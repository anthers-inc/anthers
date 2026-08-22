// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ATProto OAuth routes.
 *
 * Endpoints:
 *   GET  /client-metadata.json — OAuth client metadata document
 *   POST /auth                 — Initiate OAuth flow (returns authorization URL)
 *   GET  /callback             — OAuth callback (exchanges code, creates session, redirects)
 *   GET  /pending              — What a signup waiting on an address knows about itself
 *   POST /unlink               — Unlink ATProto identity from account
 *
 * The protocol work is `@atproto/oauth-client`'s; see `services/atproto-client.ts` for why
 * it is the runtime-agnostic core rather than the Node package. What is left here is the
 * three intents — link an identity to the account you are signed into, sign in with one, or
 * sign up with one — and the ceremony each of them owes.
 *
 * 🚨 **The intent decides the scope, and that is why there are three rather than two.**
 * Signing up needs `transition:email`, because Anthers never creates an account it cannot
 * mail; signing in and linking need identity and nothing else. Folding signup into the
 * login intent would make every returning person consent to us reading their email address
 * to do something that never needs it.
 */

import { sanitizeNextPath } from "@anthers/shared/next-path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { setSessionCookie } from "../lib/session-cookie.js";
import { requireAuth } from "../middleware/auth.js";
import {
	atprotoSignupEnabled,
	clearPendingSignup,
	createAccountFromAtproto,
	EMAIL_SCOPE,
	findUserByAtprotoDid,
	getBlueskyProfile,
	linkAtprotoToUser,
	PENDING_SIGNUP_TTL_MS,
	readPdsEmail,
	readPendingSignup,
	resolveIdentity,
	startPendingSignup,
	sweepExpiredPendingSignups,
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
	intent: z.enum(["login", "link", "signup"]).default("login"),
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
	intent: "login" | "link" | "signup";
	userId?: number;
	next?: string;
}

function getFrontendUrl(): string {
	return process.env.FRONTEND_URL ?? "http://localhost:3000";
}

/**
 * The cookie that binds a parked signup to this browser.
 *
 * `Lax` rather than `Strict` because it has to survive the redirect back from an
 * authorization server on another origin, which is the only moment it is ever set.
 */
const PENDING_COOKIE = "atproto_pending";

function setPendingCookie(c: Parameters<typeof setCookie>[0], token: string): void {
	setCookie(c, PENDING_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "Lax",
		path: "/",
		maxAge: Math.floor(PENDING_SIGNUP_TTL_MS / 1000),
		...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
	});
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

		// Refused here rather than at the callback, so nobody is sent through an
		// authorization screen on another website to be told no on the way back.
		if (intent === "signup" && !atprotoSignupEnabled()) {
			return c.json({ error: "Signing up with Bluesky isn't open yet." }, 403);
		}

		try {
			// Opportunistic rather than scheduled: these are the only routes that create rows
			// in either table, so this is the only place that can be relied on to run.
			await Promise.all([sweepExpiredOauthState(), sweepExpiredPendingSignups()]);

			const appState: AppState = {
				intent,
				userId,
				next: sanitizeNextPath(next) ?? undefined,
			};
			const url = await getAtprotoClient().authorize(handle, {
				state: JSON.stringify(appState),
				// ⚠️ Identity only, except when signing up. Writing records needs more still,
				// and it is asked for at the point a creator opts into publishing — never
				// bundled into signing in. `transition:email` is narrow enough that the consent
				// screen reads honestly ("read your email address", not "do anything").
				scope: intent === "signup" ? `atproto ${EMAIL_SCOPE}` : "atproto",
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

			// ── Login and signup ─────────────────────────────────────────────
			//
			// They share everything after "is there an account for this DID?", including the
			// answer when there is one: somebody who pressed Sign Up with a handle they had
			// already linked is signed in rather than told off.
			let user = await findUserByAtprotoDid(identity, profile.displayName);

			if (!user && appState.intent !== "signup") {
				// 🚨 A DID nobody has linked, reached through the sign-in door. This is a signup
				// and the sign-in door cannot perform one — it asked for identity only, so it
				// holds no address and could not create an account it can mail. `/subscribe` is
				// where signing up happens, exactly as it is for everyone else.
				return fail("signup_disabled");
			}

			if (!user) {
				// ── Signup ───────────────────────────────────────────────────
				if (!atprotoSignupEnabled()) return fail("signup_disabled");

				const pds = await readPdsEmail(session);

				// Usable means present AND confirmed by the PDS. An unconfirmed address is a
				// string somebody typed into another website, which is not evidence of anything.
				if (pds.email && pds.confirmed) {
					const created = await createAccountFromAtproto({
						identity,
						email: pds.email,
						displayName: profile.displayName,
					});
					user = created.user;
					// `email_has_account` is not a failure — it is the fourth way of arriving at
					// the emailed code, and it falls through to exactly that below.
					if (created.error && created.error !== "email_has_account") {
						return fail(created.error);
					}
				}

				if (!user) {
					// 🚨 **Anthers never creates an account it cannot mail**, so the four ways of
					// not having a usable address — scope refused, no address on file, address
					// unconfirmed, address already spoken for — all end here, in the ordinary
					// emailed-code ceremony. The identity is parked, proved, and attached the
					// moment a code confirms an address.
					//
					// ⭐ The collision case is the interesting one and it resolves *safely* for
					// the same reason: the PDS's claim about an address is somebody else's
					// assertion, and a code we sent and they read is ours.
					const token = await startPendingSignup(identity, pds.email);
					setPendingCookie(c, token);
					return back({ success: "needs_email", next });
				}
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

	// ── What the browser needs to know before it offers anything ─────────────
	//
	// 🚨 **Without this the closed state is a button that refuses**, which is worse than no
	// button: `ATPROTO_SIGNUP_ENABLED` is a launch switch, and while it is off `/subscribe`
	// should look exactly as it did before this existed rather than advertising a door and
	// then apologising. The API refuses either way — this only decides whether anyone is
	// invited to try.
	.get("/config", (c) => c.json({ signupEnabled: atprotoSignupEnabled() }))

	// ── A signup waiting on an address ───────────────────────────────────────
	//
	// What `/subscribe` needs in order to say *whose* signup it is finishing, and to
	// prefill the address the PDS gave us when it gave us one.
	//
	// ⚠️ It answers from the httpOnly cookie and nothing else, so it can only ever describe
	// a signup this browser started. The address it returns is one the PDS already handed
	// us for this identity — but it is a **prefill and not a claim**, and the person may
	// type a different one, which is theirs to do. The code is what proves it either way.
	.get("/pending", async (c) => {
		const row = await readPendingSignup(getCookie(c, PENDING_COOKIE));
		// One shape, always. Two `c.json` calls returning different objects give the RPC
		// client a union type that every caller then has to narrow by hand.
		const pending: { handle: string; email: string | null } | null = row
			? { handle: row.handle, email: row.email ?? null }
			: null;
		return c.json({ pending });
	})

	// Abandon it — the "actually, never mind" on `/subscribe`. The row goes as well as the
	// cookie, because a parked identity nobody is claiming is just a row waiting to expire.
	.post("/pending/cancel", async (c) => {
		await clearPendingSignup(getCookie(c, PENDING_COOKIE));
		deleteCookie(c, PENDING_COOKIE, {
			path: "/",
			...(process.env.COOKIE_DOMAIN ? { domain: process.env.COOKIE_DOMAIN } : {}),
		});
		return c.json({ success: true });
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
