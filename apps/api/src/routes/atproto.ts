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
});

/**
 * What rides in the SDK's `appState`. Stored server-side in `atproto_oauth_state` and
 * handed back by `callback()`, so neither field is ever client-supplied — which is the
 * whole reason `userId` may be trusted here.
 */
interface AppState {
	intent: "login" | "link";
	userId?: number;
}

function getFrontendUrl(): string {
	return process.env.FRONTEND_URL ?? "http://localhost:3000";
}

const atprotoRoutes = new Hono()
	// ── Client Metadata ──────────────────────────────────────────────────────
	// `client_id` must be the URL this document is served from; that is what makes the
	// client discoverable to an authorization server without prior registration.
	.get("/client-metadata.json", (c) => c.json(buildClientMetadata()))

	// ── Auth Init ────────────────────────────────────────────────────────────
	.post("/auth", zValidator("json", authInitSchema), async (c) => {
		const { handle, intent } = c.req.valid("json");

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

			const appState: AppState = { intent, userId };
			const url = await getAtprotoClient().authorize(handle, {
				state: JSON.stringify(appState),
				// Identity only. Writing records needs more, and it is asked for at the point
				// a creator opts into publishing — never bundled into signing in.
				scope: "atproto",
			});
			return c.json({ authorization_url: url.toString() });
		} catch (err) {
			const message = err instanceof Error ? err.message : "OAuth initiation failed";
			return c.json({ error: message }, 400);
		}
	})

	// ── Callback ─────────────────────────────────────────────────────────────
	.get("/callback", async (c) => {
		const frontendUrl = getFrontendUrl();
		const callbackUrl = `${frontendUrl}/auth/atproto/callback`;
		const fail = (reason: string) =>
			c.redirect(`${callbackUrl}?error=${encodeURIComponent(reason)}`);

		try {
			const params = new URL(c.req.url).searchParams;
			const { session, state } = await getAtprotoClient().callback(params);

			const appState: AppState = state ? JSON.parse(state) : { intent: "login" };
			const identity = await resolveIdentity(session.did);
			const profile = await getBlueskyProfile(session.did);

			if (appState.intent === "link") {
				if (!appState.userId) return fail("not_authenticated");

				const linkResult = await linkAtprotoToUser(appState.userId, identity);
				if (linkResult.error) return fail(linkResult.error);

				await attachSessionToUser(identity.did, appState.userId);
				return c.redirect(`${callbackUrl}?success=linked`);
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

			return c.redirect(`${callbackUrl}?success=login`);
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
