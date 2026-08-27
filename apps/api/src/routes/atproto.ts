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
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { PENDING_SIGNUP_COOKIE, setPendingSignupCookie, setSessionCookie } from "../lib/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import {
	atprotoSignupEnabled,
	findUserByAtprotoDid,
	getBlueskyProfile,
	linkAtprotoToUser,
	readPdsEmail,
	resolveIdentity,
	unlinkAtprotoFromUser,
} from "../services/atproto.js";
import {
	attachSessionToUser,
	buildClientMetadata,
	EMAIL_SCOPE,
	getAtprotoClient,
	sweepExpiredOauthState,
} from "../services/atproto-client.js";
import { createSession, validateSession } from "../services/auth.js";
import {
	bindIdentityToPending,
	findPendingByDid,
	issueCodeForPending,
	readPendingSignup,
	sweepExpiredPendingSignups,
} from "../services/pending-signups.js";

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

/**
 * Where to send the browser once the round trip is over.
 *
 * 🚨 **In development it follows the host this request arrived on, and that is the fix for a
 * real defect rather than tidiness.** The ATProto spec permits only `127.0.0.1` / `[::1]` for
 * a loopback client's redirect — never `localhost` — so the dev callback lands on
 * `127.0.0.1:8000`. Bouncing from there to a hardcoded `localhost:3000` would move the browser
 * to a *different host* mid-flow, and cookies are host-scoped: the pending signup written here
 * would be unreadable there, which is exactly how the Bluesky handoff kept losing the address
 * the PDS had just handed over.
 *
 * Production sets `FRONTEND_URL` and it wins, as it must — there the API and the SPA share one
 * origin and none of this applies.
 */
function getFrontendUrl(c: { req: { url: string } }): string {
	const configured = process.env.FRONTEND_URL;
	if (configured) return configured;
	return `http://${new URL(c.req.url).hostname}:3000`;
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
		const callbackUrl = `${getFrontendUrl(c)}/auth/atproto/callback`;

		/** Compose the one URL this route ever redirects to, so no caller hand-builds a query. */
		const back = (params: Record<string, string | undefined>) => {
			const query = new URLSearchParams();
			for (const [key, value] of Object.entries(params)) {
				if (value) query.set(key, value);
			}
			return c.redirect(`${callbackUrl}?${query.toString()}`);
		};
		/**
		 * 🚨 **Every refusal is logged, and it did not used to be.** This route turns any
		 * failure into a query parameter the browser renders as a sentence — which means a
		 * signup that silently goes wrong leaves *nothing* server-side to read. Three rounds of
		 * debugging the Bluesky handoff on 2026-08-26 were spent inferring from table state
		 * which branch had been taken, because the branch itself said nothing. A round trip
		 * through somebody else's website is exactly the path that cannot be reproduced on
		 * demand, so it is the last place to be quiet about what happened.
		 */
		const fail = (reason: string, detail?: unknown) => {
			console.warn(`[atproto/callback] refused: ${reason}`, detail ?? "");
			return back({ error: reason });
		};

		try {
			const params = new URL(c.req.url).searchParams;
			const { session, state } = await getAtprotoClient().callback(params);

			const appState: AppState = state ? JSON.parse(state) : { intent: "login" };
			console.log(
				`[atproto/callback] intent=${appState.intent} did=${session.did} ` +
					`pendingCookie=${getCookie(c, PENDING_SIGNUP_COOKIE) ? "present" : "absent"}`,
			);
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
			const user = await findUserByAtprotoDid(identity, profile.displayName);

			if (!user && appState.intent !== "signup") {
				// ⭐ **An unfinished signup resumes here, and that is what "come back and sign in
				// with the same handle" means.** Somebody who started a Bluesky signup and walked
				// away has a pending account and no `users` row, so the sign-in door finds
				// nothing — but a second completed OAuth round trip is exactly the evidence the
				// first one was, so the row may be handed back whole and bound to this browser.
				const resumable = await findPendingByDid(identity.did);
				if (resumable) {
					setPendingSignupCookie(c, resumable.token);
					return back({ success: "resume_signup", next });
				}

				// 🚨 A DID nobody has linked and no signup in progress, reached through the
				// sign-in door. This is a signup and the sign-in door cannot perform one — it
				// asked for identity only, so it holds no address and could not create an
				// account it can mail. `/subscribe` is where signing up happens, exactly as it
				// is for everyone else.
				return fail("signup_disabled");
			}

			if (!user) {
				// ── Signup ───────────────────────────────────────────────────
				if (!atprotoSignupEnabled()) return fail("signup_disabled");

				// 🚨 **A signup NEVER completes here, whatever the PDS said.** The identity is
				// proved and parked, and the address is confirmed by our own emailed code on
				// `/subscribe` before any account exists.
				//
				// This branch used to short-circuit when the PDS reported `emailConfirmed: true`,
				// creating the account outright and skipping our verification. That trusted the
				// wrong party (Parker's call, 2026-08-22): the PDS answering is **whichever
				// server the person's identity lives on**, and anyone self-hosting one can
				// answer `{email: "someone-else@example.com", emailConfirmed: true}`. The prize
				// is an Anthers account bound to an address they do not control — receipts and
				// account notices to an innocent third party, and a squatted handle. Recoverable
				// (the real owner can sign in by code and unlink) but not worth having.
				//
				// ⚠️ **An allowlist of trusted PDS hosts was the obvious alternative and was
				// rejected on principle**: "we trust Bluesky's server and not yours" is precisely
				// the posture a platform arguing that it needs nobody's permission cannot adopt.
				// Verifying everybody equally costs one email — the same step every other signup
				// already pays — and removes the trust assumption instead of narrowing it.
				//
				// ⭐ What the PDS's answer is still good for is **saving somebody typing**. The
				// address rides along as a prefill; the code is what makes it true.
				//
				// ⚠️ **The identity lands on the pending signup this browser already started at
				// `/subscribe`**, rather than starting a fresh one — that row is holding the
				// choices somebody made before they left, and dropping them here is precisely
				// the "sign up again, with no sign anything succeeded" that this flow exists to
				// fix. `bindIdentityToPending` starts one only when there is nothing to add to.
				const pds = await readPdsEmail(session);
				const token = await bindIdentityToPending(
					getCookie(c, PENDING_SIGNUP_COOKIE),
					identity,
					pds.email,
				);
				setPendingSignupCookie(c, token);

				// ⭐ **And post the code now, rather than asking them to press a button about an
				// address we just went and fetched.** Asking Bluesky for it was worth doing only
				// if it saves the step; landing on a filled-in field and a Send button gives most
				// of that step back. A no-op when the PDS gave us nothing, in which case the
				// finishing page asks for an address the ordinary way.
				await issueCodeForPending(token);

				// What the finishing page will find, said plainly. The three facts that decide
				// which face it shows are the three worth reading back on a walkthrough.
				const parked = await readPendingSignup(token);
				console.log(
					`[atproto/callback] parked signup: handle=${identity.handle || "(none)"} ` +
						`scopeGranted=${pds.scopeGranted} pdsEmail=${pds.email ? "yes" : "no"} ` +
						`rowEmail=${parked?.email ? "yes" : "no"} codeSent=${parked?.codeSentAt ? "yes" : "no"}`,
				);
				return back({ success: "needs_email", next });
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
			return fail(message, err);
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
	// 🚨 **`GET /pending` and `POST /pending/cancel` moved to `/api/auth/signup/*` on
	// 2026-08-26**, when a parked ATProto identity generalized into a pending account both
	// doors write. They are not ATProto endpoints any more: the page that finishes a signup
	// asks one question — *what am I finishing?* — and the answer must not depend on which
	// door produced it.

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
