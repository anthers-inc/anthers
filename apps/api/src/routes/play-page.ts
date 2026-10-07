// SPDX-License-Identifier: Apache-2.0
/**
 * The play page — the server-rendered parent an isolation build plays inside.
 *
 * 🚨 **Why this page exists at all: the ancestor rule.** A threaded engine export asks
 * for `SharedArrayBuffer`, which a browser grants only to a cross-origin-isolated
 * context, and a frame is isolated only when EVERY ancestor is too. Anthers' Work pages
 * are a static SPA served by the CDN — per-Work response headers are structurally
 * impossible there — so an isolation build can never play inline. This page is the
 * answer: rendered by the API per request, so it can carry
 * `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy:
 * require-corp` on its own response AND mint the play token itself, server-side, while
 * holding the visitor's session — the one place with both isolation and the session.
 * The saves shim (step 6) and presence (step 7) hang off exactly that combination.
 *
 * 🚨 **The gates run before the token is minted, on this very request** — access, the
 * Public Access meter, and the household limit, the same ladder `/works/:id/play`
 * runs. A user the meters refuse gets the refusal page, not a frame that fails later.
 *
 * The build frame inside is the delivery origin with the token prefix — same shape as
 * HostedEmbed's frame, but the src is minted here rather than by a browser call, and
 * this page's own headers make the frame's isolation real. The frame sandbox matches
 * `ProjectEmbed`'s (allow-same-origin beside allow-scripts is what keeps saves), and
 * the delivery responses carry COEP-felicitous headers by construction: everything the
 * build loads is same-origin to the frame.
 */

import { db } from "@anthers/db/client";
import { webBuilds } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { buildDeliveryHost, mintPlayToken, PLAY_TOKEN_TTL_SECONDS } from "../lib/web-build.js";
import { getOptionalUserId } from "../middleware/auth.js";
import {
	findWorkRow,
	parentalTimeGate,
	publicAccessGate,
	requireUserOrShareLink,
	workAccessFor,
} from "./content.js";

/**
 * The one HTML shape this module serves. A refusal is a real page too — a user the
 * meters stopped gets a sentence they can read, not a blank frame. Plain, no scripts,
 * and the styles are inline because the page has exactly one job.
 */
function page(title: string, body: string, extraHeaders?: Record<string, string>): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0b0d; color: #e8e6e3; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 24px; }
  .frame-wrap iframe { width: 100%; min-height: 640px; border: 0; border-radius: 8px; }
  .refuse { padding: 48px 24px; text-align: center; font-family: system-ui, sans-serif; }
  a { color: #9db8d2; }
</style>
</head>
<body>
${body}
</body>
</html>`;
	return new Response(html, {
		headers: {
			"Content-Type": "text/html;charset=utf-8",
			"Cache-Control": "no-store",
			...extraHeaders,
		},
	});
}

/**
 * The two response headers the page carries: COOP `same-origin` and COEP
 * `require-corp`. Carried on the refusal pages too — an answer that varies its own
 * headers by body is one more thing to keep in step, and the cost of the pair on a
 * refusal is nothing.
 */
const ISOLATION_HEADERS = {
	"Cross-Origin-Opener-Policy": "same-origin",
	"Cross-Origin-Embedder-Policy": "require-corp",
} as const;

function refusal(title: string, message: string): Response {
	return page(
		title,
		`<div class="refuse"><h1>${title}</h1><p>${message}</p><p><a href="/">Back to Anthers</a></p></div>`,
		ISOLATION_HEADERS,
	);
}

export function createPlayPageRoutes(): Hono {
	return new Hono().get("/:id", requireUserOrShareLink, async (c) => {
		const work = await findWorkRow(c.req.param("id"));
		if (!work)
			return refusal("Work not found", "This play page reached for a Work that is not here.");

		const access = await workAccessFor(c, work);
		if (!access.canAccess) {
			return refusal(
				"Access required",
				"This Work is gated, and your account has not cleared its threshold. Open the Work's page on Anthers to get access.",
			);
		}
		const metered = await publicAccessGate(c, work, access);
		if (metered) {
			return refusal(
				metered.error,
				"The monthly Public Access allowance has run out. It resets each month.",
			);
		}
		const limited = await parentalTimeGate(await getOptionalUserId(c), work);
		if (limited) {
			return refusal(
				limited.error ?? "Time limited",
				"A household time limit has stopped play for now.",
			);
		}

		const [build] = await db
			.select({
				id: webBuilds.id,
				entryPath: webBuilds.entryPath,
				requiresIsolation: webBuilds.requiresIsolation,
			})
			.from(webBuilds)
			.where(and(eq(webBuilds.workId, work.id), eq(webBuilds.isPrimary, true)))
			.limit(1);
		if (!build) {
			return refusal("No hosted build", "This Work has no hosted browser build to play.");
		}

		const host = buildDeliveryHost(work.publicId, process.env, new URL(c.req.url).host);
		if (!host) {
			return refusal(
				"Delivery not configured",
				"Hosted build delivery does not answer for this deployment. Its operator has not named a delivery origin.",
			);
		}
		const token = mintPlayToken(work.id, PLAY_TOKEN_TTL_SECONDS);

		// The per-Work host is https in every environment that names one; an own-host
		// dev delivery takes the request's scheme, as the play route does.
		const suffixSet = Boolean(process.env.BUILD_ORIGIN_SUFFIX?.trim());
		const scheme = suffixSet ? "https" : new URL(c.req.url).protocol.replace(":", "");
		const src = `${scheme}://${host}/build/${token}/${build.entryPath}`;

		const escapedTitle =
			work.title?.replace(
				/[&<>"']/g,
				(ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
			) ?? "Untitled";

		return page(
			`Playing ${escapedTitle} — Anthers`,
			`<div class="wrap"><div class="frame-wrap"><iframe src="${src}" title="${escapedTitle}" sandbox="allow-scripts allow-same-origin allow-popups" allowfullscreen></iframe></div></div>`,
			build.requiresIsolation ? ISOLATION_HEADERS : {},
		);
	});
}
