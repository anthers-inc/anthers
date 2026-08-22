// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ATProto OAuth routes.
 *
 * Endpoints:
 *   GET  /client-metadata.json — OAuth client metadata document
 *   POST /auth                 — Initiate OAuth flow (returns authorization URL)
 *   GET  /callback             — OAuth callback (exchanges code, creates session, redirects)
 *   POST /unlink               — Unlink ATProto identity from account
 *
 * The protocol work is `@atproto/oauth-client`'s; see `services/atproto-client.ts` for why
 * it is the runtime-agnostic core rather than the Node package. What is left here is the
 * two intents — link an identity to the account you are signed into, or sign in with one —
 * and the ceremony each of them owes.
 */

import { sanitizeNextPath } from "@anthers/shared/next-path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { setSessionCookie } from "../lib/session-cookie.js";
import { requireAuth } from "../middleware/auth.js";
import {
	createUserFromAtproto,
	findUserByAtprotoDid,
	getBlueskyProfile,
	linkAtprotoToUser,
	resolveIdentity,
	unlinkAtprotoFromUser,
} from "../services/atproto.js";
import {
	attachSessionToUser,
	buildClientMetadata,
	getAtprotoClient,
	sweepExpiredOauthState,
} from "../services/atproto-client.js";
import { createSession, validateSession } from "../services/auth.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const authInitSchema = z.object({
	handle: z.string().min(1),
	intent: z.enum(["login", "link"]).default("login"),
	/**
	 * Where to land afterwards — the thing the person was trying to do when signing in
	 * interrupted them. Client-supplied, and therefore sanitized before it is stored rather
	 * than trusted because it came from our own page.
	 */
	next: z.string().optional(),
});

/**
 * What rides in the SDK's `appState`. Stored server-side in `atproto_oauth_state` and
 * handed back by `callback()`, so nothing here is client-supplied *at the callback* —
 * which is the whole reason `userId` may be trusted.
 *
 * ⚠️ `next` is the exception and is a different kind of value: it *originates* with the
 * client, and being stored server-side in between only means an attacker has to send the
 * victim through the flow rather than tamper with a URL mid-flight. It is passed through
 * `sanitizeNextPath` on the way in and again on the way out, because the property that
 * matters is what the browser is finally told to navigate to.
 */
interface AppState {
	intent: "login" | "link";
	userId?: number;
	next?: string;
}

function getFrontendUrl(): string {
	return process.env.FRONTEND_URL ?? "http://localhost:3000";
}

/**
 * Turn a failure to start the flow into something worth reading.
 *
 * ⚠️ **One case is common enough to deserve copy and the rest are not.** Almost every
 * refusal here is a mistyped handle, and the SDK reports it as *"Failed to resolve
 * identity: alice.bsky.socail"* — accurate, and phrased for whoever wrote the SDK. The
 * others (a PDS that is down, an authorization server that refuses the client) are rare,
 * are not the person's fault, and are worth passing through verbatim, because a generic
 * apology would throw away the only clue anyone has.
 */
function startFailureMessage(err: unknown): string {
	const raw = err instanceof Error ? err.message : "";
	if (/resolve identity|resolve handle|not found/i.test(raw)) {
		return "We couldn't find that handle. Check the spelling — it usually looks like alice.bsky.social.";
	}
	return raw || "Couldn't start the Bluesky flow. Please try again.";
}

const atprotoRoutes = new Hono()
	// ── Client Metadata ──────────────────────────────────────────────────────
	// `client_id` must be the URL this document is served from; that is what makes the
	// client discoverable to an authorization server without prior registration.
	.get("/client-metadata.json", (c) => c.json(buildClientMetadata()))

	// ── Auth Init ────────────────────────────────────────────────────────────
	.post("/auth", zValidator("json", authInitSchema), async (c) => {
		const { handle, intent, next } = c.req.valid("json");

		let userId: number | undefined;
		if (intent === "link") {
			const token = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
			if (!token) {
				return c.json({ error: "Authentication required for linking" }, 401);
			}
			const result = await validateSession(token);
			if (!result) {
				return c.json({ error: "Invalid session" }, 401);
			}
			userId = result.user.id;
		}

		try {
			// Opportunistic rather than scheduled: this is the only route that creates state
			// rows, so it is the only place that can be relied on to run before they pile up.
			await sweepExpiredOauthState();

			const appState: AppState = {
				intent,
				userId,
				next: sanitizeNextPath(next) ?? undefined,
			};
			const url = await getAtprotoClient().authorize(handle, {
				state: JSON.stringify(appState),
				// Identity only. Writing records needs more, and it is asked for at the point
				// a creator opts into publishing — never bundled into signing in.
				scope: "atproto",
			});
			return c.json({ authorization_url: url.toString() });
		} catch (err) {
			return c.json({ error: startFailureMessage(err) }, 400);
		}
	})

	// ── Callback ─────────────────────────────────────────────────────────────
	.get("/callback", async (c) => {
		const callbackUrl = `${getFrontendUrl()}/auth/atproto/callback`;

		/** Compose the one URL this route ever redirects to, so no caller hand-builds a query. */
		const back = (params: Record<string, string | undefined>) => {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(params)) {
				if (value) query.set(key, value);
			}
			return c.redirect(`${callbackUrl}?${query.toString()}`);
		};
		const fail = (reason: string) => back({ error: reason });

		try {
			const params = new URL(c.req.url).searchParams;
			const { session, state } = await getAtprotoClient().callback(params);

			const appState: AppState = state ? JSON.parse(state) : { intent: "login" };
			// Sanitized on the way in as well; this is the read that actually decides where a
			// browser goes, and it is the one that has to be right.
			const next = sanitizeNextPath(appState.next) ?? undefined;
			const identity = await resolveIdentity(session.did);
			const profile = await getBlueskyProfile(session.did);

			if (appState.intent === "link") {
				if (!appState.userId) return fail("not_authenticated");

				const linkResult = await linkAtprotoToUser(appState.userId, identity);
				if (linkResult.error) return fail(linkResult.error);

				await attachSessionToUser(identity.did, appState.userId);
				return back({ success: "linked" });
			}

			// ── Login intent ─────────────────────────────────────────────────
			let user = await findUserByAtprotoDid(identity, profile.displayName);
			if (!user) {
				// 🚨 A DID nobody has linked means this is a SIGNUP, not a sign-in, and signup
				// through this door is closed until it carries the same ceremony as every
				// other one. See `createUserFromAtproto`.
				const created = await createUserFromAtproto(identity, profile.displayName);
				if (created.error || !created.user) return fail(created.error ?? "signup_failed");
				user = created.user;
			}

			await attachSessionToUser(identity.did, user.id);

			const sessionToken = await createSession(
				user.id,
				c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
				c.req.header("User-Agent"),
			);
			setSessionCookie(c, sessionToken);

			return back({
				success: "login",
				next,
				// An account can be signed in and still owe a handle — the signup ceremony
				// creates it before asking for one, and nothing forces the question later. The
				// emailed-code door already reports this; a second door that did not would send
				// those accounts somewhere they cannot be linked to from.
				onboarding: user.username === null ? "1" : undefined,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : "exchange_failed";
			return fail(message);
		}
	})

	// ── Unlink ───────────────────────────────────────────────────────────────
	.post("/unlink", requireAuth, async (c) => {
		const user = c.get("user");
		const result = await unlinkAtprotoFromUser(user.id);

		if (result.error) {
			return c.json({ error: result.error }, 400);
		}

		return c.json({ success: true });
	});

export { atprotoRoutes };
