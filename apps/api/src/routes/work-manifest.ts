// SPDX-License-Identifier: Apache-2.0
/**
 * `GET /api/content/works/:id/manifest` — the reader's copy of a gated Work's manifest.
 *
 * The route is thin because the interesting question is not here: `gatedManifestFor` asks the
 * same `authorizeSpaceAccess` the space authority will ask before it issues a credential, and
 * then performs the delegation, attestation, credential and MAC-verified read. What is left is
 * mapping an outcome to an answer a page can act on, without leaking a refusal reason the gate
 * meant for its own logs.
 *
 * ⚠️ **A refusal is not a 500.** A reader the gate does not admit gets a 403; a Work with no
 * manifest gets a 404; a deployment without the app's attestation key gets a 503 that says the
 * feature is unavailable rather than pretending the reader is at fault. The authority's own
 * error names (`AppNotAuthorized`, `UserNotAuthorized`) are passed through where they explain
 * something the page can show.
 */

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";
import { SpaceRequestError } from "../services/atproto-space.js";
import { type GatedManifestResult, gatedManifestFor } from "../services/gated-manifest.js";
import { SpaceReadError } from "../services/space-credential.js";

const workManifestRoutes = new Hono().get("/works/:id/manifest", requireAuth, async (c) => {
	const user = c.get("user");
	const workId = Number(c.req.param("id"));
	if (!Number.isSafeInteger(workId) || workId <= 0) {
		return c.json({ error: "Work not found" }, 404);
	}

	const result = await gatedManifestFor({ workId, readerUserId: user.id });
	if (result.status === "ok") {
		return c.json({ manifest: result.manifest });
	}

	const refusal = refusalFor(result);
	// A 5xx or an app-perimeter refusal is worth a line; an ordinary "you don't have access"
	// is the page's business and would otherwise fill the log with every gated view.
	if (refusal.status >= 500 || refusal.body.code === "app_not_authorized") {
		console.warn(
			`[work-manifest] work ${workId} reader ${user.id}: ${result.reason}` +
				(result.detail ? ` — ${result.detail}` : ""),
		);
	}
	return c.json(refusal.body, refusal.status as 403 | 404 | 409 | 502 | 503);
});

function refusalFor(result: Extract<GatedManifestResult, { status: "refused" }>): {
	status: number;
	body: { error: string; code: string };
} {
	const cause = result.cause;
	if (cause instanceof SpaceReadError && cause.cause instanceof SpaceRequestError) {
		const authorityError = cause.cause.error;
		if (authorityError === "AppNotAuthorized" || authorityError === "InvalidClientAttestation") {
			return {
				status: 403,
				body: {
					error: "This app isn't authorized to open this Work's files.",
					code: "app_not_authorized",
				},
			};
		}
		if (authorityError === "UserNotAuthorized" || authorityError === "NotAuthorized") {
			return {
				status: 403,
				body: { error: "You don't have access to this Work's files.", code: "not_entitled" },
			};
		}
	}

	switch (result.reason) {
		case "no_work":
		case "no_manifest":
		case "no_creator":
			return { status: 404, body: { error: "Work not found", code: "manifest_missing" } };
		case "no_session":
			return {
				status: 409,
				body: {
					error:
						"Reading a Work's files needs a permission this identity hasn't granted yet. The app can open files for identities it hosts today.",
					code: "space_scope_required",
				},
			};
		case "client_not_configured":
			return {
				status: 503,
				body: { error: "File access is not available right now.", code: "space_unavailable" },
			};
		case "no_kem_key":
		case "mac_mismatch":
		case "wrong_record":
		case "request":
			return {
				status: 502,
				body: { error: "The Work's files could not be read.", code: "space_unavailable" },
			};
		default:
			return {
				status: 403,
				body: { error: "You don't have access to this Work's files.", code: "not_entitled" },
			};
	}
}

export { workManifestRoutes };
