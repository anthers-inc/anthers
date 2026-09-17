// SPDX-License-Identifier: Apache-2.0
/**
 * ATProto OAuth routes.
 *
 * Endpoints:
 *   GET  /client-metadata.json — OAuth client metadata document
 *   POST /auth                 — Initiate OAuth flow (returns authorization URL)
 *   GET  /callback             — OAuth callback (exchanges code, creates session, redirects)
 *   GET  /handle-available     — Is a name Anthers could issue still free?
 *   POST /handle/domain        — Point an issued identity at a domain the holder owns
 *   GET  /recovery-key         — Has this account taken one, and which key
 *   POST /recovery-key/request — Ask the node to mail the holder a PLC operation token
 *   POST /recovery-key/confirm — Seat the holder's key above Anthers' own
 *   GET  /publishing           — How this account's records reach the network, or why they cannot
 *   POST /publishing/stop      — Take the listings down and hand the permission back
 *
 * The protocol work is `@atproto/oauth-client`'s; see `services/atproto-client.ts` for why
 * it is the runtime-agnostic core rather than the Node package. What is left here is the
 * three intents — sign in with an identity, sign up with one, or let Anthers publish a
 * creator's listings into one — and the ceremony each owes. There is no linking: every account
 * is created holding its one identity, and swapping it for another is not built.
 *
 * 🚨 **The ACCOUNT decides the scope, not the intent, and getting that backwards is the bug
 * this route was rebuilt to remove.** One OAuth session is stored per DID and each
 * authorization replaces the last, so a sign-in asking only for identity would discard a
 * publishing permission the creator had already granted — their listings would then stop
 * updating with nothing anywhere reporting a problem. Every door now asks for what the account
 * holds, and a returning person sees no consent screen for a grant they have already made.
 *
 * ⭐ **A record in somebody's repository is Anthers working, not an accessory they opt into.**
 * The permission to write one belongs with connecting an identity, the way permissions belong
 * with authorizing any application. `publish` exists as the one separate ask because the creator
 * tier is the one permission most accounts have no use for — asked once, when somebody starts
 * publishing, and carried by every sign-in after that.
 */

import { sanitizeNextPath } from "@anthers/shared/next-path";
import { OAuthCallbackError } from "@atproto/oauth-client";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { PENDING_SIGNUP_COOKIE, setPendingSignupCookie, setSessionCookie } from "../lib/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import {
	atprotoPublishEnabled,
	findUserByAtprotoDid,
	getBlueskyProfile,
	isCreatorAccount,
	isCreatorIdentity,
	publishingStateFor,
	readPdsEmail,
	recordPublishGrant,
	resolveIdentity,
} from "../services/atproto.js";
import {
	attachSessionToUser,
	buildClientMetadata,
	getAtprotoClient,
	recordGrantedScope,
	scopeFor,
	sweepExpiredOauthState,
} from "../services/atproto-client.js";
import { createSession, validateSession } from "../services/auth.js";
import {
	checkHandleAvailability,
	hostedHandleFor,
	hostedHandleSuffix,
	hostedIdentityOffered,
	normalizeHandleName,
	swapHostedHandle,
} from "../services/hosted-accounts.js";
import {
	recoveryKeyState,
	requestRecoveryKeyToken,
	seatRecoveryKey,
} from "../services/hosted-recovery-key.js";
import {
	bindIdentityToPending,
	findPendingByDid,
	handleReservedElsewhere,
	issueCodeForPending,
	readPendingSignup,
	sweepExpiredPendingSignups,
} from "../services/pending-signups.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/**
 * A name to check, bounded before it reaches the node.
 *
 * Generous rather than exact: the real rules are `handleNameProblem`'s and are answered as
 * sentences somebody can act on, so a strict regex here would turn a typo into a 400 with no
 * explanation instead of a message saying which character is the problem.
 */
const handleQuerySchema = z.object({ name: z.string().min(1).max(300) });

/** A domain being taken as a handle. The node is the authority; this only bounds the body. */
const domainSwapSchema = z.object({ handle: z.string().min(1).max(253) });

/**
 * A recovery key being seated, bounded before it reaches the node.
 *
 * The real check is `isSecp256k1DidKey`, which decodes the key and asks the curve whether the
 * point is on it — a length bound here only keeps a hostile body from reaching that at all.
 */
const recoveryKeySchema = z.object({
	token: z.string().min(1).max(200),
	didKey: z.string().min(1).max(200),
});

const authInitSchema = z.object({
	/**
	 * ⚠️ **Optional because the `publish` intent has no use for one**, and required for every
	 * other intent by the check in the handler. That flow authorizes against the DID already on
	 * the account: it knows whose repository it means and must not be told, because a handle the
	 * browser supplied is a handle an attacker could supply. Accepting one and ignoring it would
	 * leave a field that looks load-bearing and is not — which is how somebody later "fixes" the
	 * flow by using it.
	 */
	handle: z.string().min(1).optional(),
	intent: z.enum(["login", "signup", "publish"]).default("login"),
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
	intent: "login" | "signup" | "publish";
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
 * origin and none of this applies. A browser test session serves its preview on a port of its
 * own and names it in `PREVIEW_PORT`; `make dev` serves the SPA on 3000.
 */
function getFrontendUrl(c: { req: { url: string } }): string {
	const configured = process.env.FRONTEND_URL;
	if (configured) return configured;
	return `http://${new URL(c.req.url).hostname}:${process.env.PREVIEW_PORT ?? "3000"}`;
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
/**
 * What this round trip should ask for, given who is going through it.
 *
 * 🚨 **A sign-in asks for everything the account already holds, not for the minimum a sign-in
 * needs.** One OAuth session is stored per DID and each authorization replaces the last, so
 * asking for less would discard a permission somebody had already granted and their listings
 * would quietly stop updating. A returning person is not prompted again for a grant they have
 * already made — the authorization server redirects straight through — so this costs them
 * nothing and asking for less would cost them the feature.
 *
 * ⚠️ **A creator is recognized by their account, which means resolving the handle first.** The
 * alternative was asking every reader for permission to write Work listings they will never
 * have, which is the kind of over-ask a platform arguing for minimal permissions cannot make.
 * The resolution is one the SDK performs anyway a moment later.
 */
async function scopeForFlow(intent: AppState["intent"], subject: string): Promise<string> {
	// Signing up has no account to read, so it gets the base set plus the address scope.
	if (intent === "signup") return scopeFor({ email: true });
	// An explicit ask, from somebody who went looking for it.
	// Giving the permission again asks for what the account holds, as a sign-in does: the creator
	// tier only for a creator, so a reader restoring their comments is not asked about publishing.
	if (intent === "publish") return scopeFor({ creator: await isCreatorIdentity(subject) });
	return scopeFor({ creator: await isCreatorIdentity(subject) });
}

/**
 * Read the scope a fresh session was actually granted.
 *
 * ⚠️ **Answers null rather than throwing, and null means "not known".** A token that will not
 * describe itself must not take a sign-in down with it, and the caller stores the null — which
 * reads, correctly, as no permission on file.
 *
 * ⚠️ **`try`/`catch` rather than a rejection handler, because the throw can be synchronous.**
 * A session object that lacks the method at all raises a `TypeError` before any promise
 * exists, which `.then(ok, onRejected)` would sail straight past — and this sits on the path
 * every sign-in takes, so the difference is whether a surprising session shape costs a scope
 * reading or costs somebody their sign-in.
 */
async function grantedScopeOf(session: {
	getTokenInfo: () => Promise<{ scope?: string }>;
}): Promise<string | null> {
	try {
		return (await session.getTokenInfo()).scope ?? null;
	} catch {
		return null;
	}
}

/**
 * The state of a publishing grant somebody refused at their own server's consent screen, or null
 * when the error is anything else.
 *
 * ⚠️ **Only the publishing intent.** A denied sign-in or signup is a round trip that did not
 * happen, and the error page is the right answer to it; a denied publishing grant is a creator
 * who is still signed in and has made a choice with a consequence worth explaining.
 */
function deniedPublishGrant(err: unknown): { next: string | undefined } | null {
	if (!(err instanceof OAuthCallbackError) || err.params.get("error") !== "access_denied") {
		return null;
	}
	try {
		const state = JSON.parse(err.state ?? "") as Partial<AppState>;
		if (state.intent !== "publish") return null;
		return { next: sanitizeNextPath(state.next) ?? undefined };
	} catch {
		return null;
	}
}

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
		if (intent === "publish") {
			const token = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
			if (!token) {
				return c.json({ error: "Authentication required" }, 401);
			}
			const result = await validateSession(token);
			if (!result) {
				return c.json({ error: "Invalid session" }, 401);
			}
			userId = result.user.id;
		}

		// ⚠️ **The publishing flow authorizes against the DID on the account, never the handle in
		// the request.** Resolving what the browser sent would let somebody sign in as themselves
		// and grant over an identity that is not theirs, and the callback's own identity check
		// would then be the only thing standing between that and a catalog written into a
		// stranger's repository. One guard is better placed than two are.
		let subject = handle ?? "";
		if (intent !== "publish" && !subject) {
			return c.json(
				{ error: "Which Bluesky handle? It usually looks like alice.bsky.social." },
				400,
			);
		}
		if (intent === "publish") {
			// The switch gates asking for the creator tier. A reader giving back the permission for
			// their comments, reviews, votes and follows is never behind it.
			if (!atprotoPublishEnabled() && (await isCreatorAccount(userId as number))) {
				return c.json({ error: "Publishing to your own repository isn't open yet." }, 403);
			}
			const state = await publishingStateFor(userId as number);
			if (!state.did) return c.json({ error: "Account not found." }, 404);
			if (state.route === "hosted") {
				return c.json(
					{ error: "Anthers already publishes your listings — this handle lives on its own node." },
					409,
				);
			}
			subject = state.did;
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
			const url = await getAtprotoClient().authorize(subject, {
				state: JSON.stringify(appState),
				scope: await scopeForFlow(intent, subject),
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

			// 🚨 **What was granted is written down on EVERY intent, including the ones that asked
			// for nothing.** One session is stored per DID, so each authorization replaces the
			// last — which means signing in after granting publishing leaves an identity-only
			// token behind. Recording only on the publishing path would leave the column claiming
			// a permission the stored token no longer carries, and the first anybody would hear of
			// it is a listing that had silently stopped updating.
			const grantedScope = await grantedScopeOf(session);
			await recordGrantedScope(session.did, grantedScope);

			if (appState.intent === "publish") {
				if (!appState.userId) return fail("not_authenticated");

				const result = await recordPublishGrant(appState.userId, identity, grantedScope);
				if (result.status === "refused") return fail(result.reason);

				await attachSessionToUser(identity.did, appState.userId);

				// ⚠️ A decline is an answer rather than a failure, so it is not logged as a refusal —
				// but it leaves the creator unable to publish, and Studio settings says so when the
				// browser lands there.
				if (result.status === "declined") return back({ success: "publish_declined", next });

				console.log(
					`[atproto/callback] publishing granted for ${identity.did}, ` +
						`${result.queued} work(s) queued`,
				);
				return back({ success: "publishing", next });
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
			// 🚨 **Pressing Deny at the consent screen arrives here, as an error, and for the
			// publishing grant it is not one.** An authorization server answers a denial with
			// `access_denied` rather than with a narrower grant, so the `declined` branch above
			// never sees it — and without this a creator who said no was shown "sign-in didn't
			// work" and a link back to log in, from an account they were already signed in to.
			// It lands where a narrower grant does, on Studio settings saying what it means.
			const denied = deniedPublishGrant(err);
			if (denied) return back({ success: "publish_declined", next: denied.next });

			const message = err instanceof Error ? err.message : "exchange_failed";
			return fail(message, err);
		}
	})

	// ── What the browser needs to know before it offers anything ─────────────
	//
	// Both signup doors are always offered, and the Anthers one needs every piece of hosting
	// configured — a door that refuses when pressed is worse than no door, so the browser asks
	// and shows only the Bluesky door when hosting is off. The suffix travels with the answer so
	// the browser can show a handle in full without a second copy of `anthers.social` living in
	// the front end.
	.get("/config", async (c) =>
		c.json({
			hostedIdentityOffered: await hostedIdentityOffered(),
			hostedHandleSuffix: await hostedHandleSuffix(),
		}),
	)

	// ── Is this handle free? ─────────────────────────────────────────────────
	//
	// ⭐ **Answered while somebody is still typing, which is the whole reason it exists.** The
	// alternative is finding out after the address is confirmed and the account is made, at the
	// one moment there is nothing useful to do about it.
	//
	// ⚠️ **It enumerates nothing that is not already public.** The node answers
	// `com.atproto.identity.resolveHandle` to anybody who asks, and a name held for somebody's
	// unfinished signup reads as taken exactly as it would to that person's rival at the card.
	// What it deliberately does NOT reveal is anything about Anthers accounts or about who holds
	// a reservation.
	//
	// ⭐ **This browser's own reservation reads as available**, so somebody who pressed the
	// button and came back to the same name is told it is theirs.
	.get("/handle-available", zValidator("query", handleQuerySchema), async (c) => {
		if (!(await hostedIdentityOffered())) {
			return c.json({ status: "unknown" as const, handle: "" });
		}
		const name = await normalizeHandleName(c.req.valid("query").name);
		const held = await handleReservedElsewhere(name, getCookie(c, PENDING_SIGNUP_COOKIE));
		const result = held ? { status: "taken" as const } : await checkHandleAvailability(name);
		return c.json({ ...result, handle: await hostedHandleFor(name) });
	})

	// ── Take a domain you own as your handle ─────────────────────────────────
	//
	// ⭐ **The node verifies the domain, so there is no DNS code here.** `updateHandle` resolves
	// any non-service handle and refuses unless it already points at this DID, which is what
	// makes the `handle.invalid` hazard unreachable through this path.
	//
	// ⚠️ **`unproven` is a 200, deliberately.** A DNS record takes time to propagate, so a first
	// attempt usually does not resolve yet and the person has done nothing wrong. Answering that
	// with an error status would make the ordinary case look like a failure — and the page needs
	// to respond by showing instructions and a *check again*, not an apology.
	.post("/handle/domain", requireAuth, zValidator("json", domainSwapSchema), async (c) => {
		const user = c.get("user");
		const result = await swapHostedHandle(user.id, { handle: c.req.valid("json").handle });
		if (result.status === "swapped") return c.json({ status: "swapped", handle: result.handle });
		if (result.status === "unproven") {
			return c.json({ status: "unproven", handle: result.handle, did: result.did });
		}
		const status = result.fault === "name" ? 400 : result.fault === "account" ? 409 : 503;
		return c.json({ error: result.message }, status);
	})

	// ── What settings should offer about a recovery key ──────────────────────
	//
	// ⚠️ **It answers what ANTHERS did, which is the only question it can answer honestly.**
	// Somebody who seated a key with their own tooling did what the arrangement promises they
	// can, and nothing here would know. The identity's rotation list is the authority on what
	// it carries; this decides what to offer.
	.get("/recovery-key", requireAuth, async (c) => {
		const user = c.get("user");
		return c.json(await recoveryKeyState(user.id));
	})

	// ── Taking a recovery key ────────────────────────────────────────────────
	//
	// 🚨 **Two steps with an emailed token between them, and the token is not friction to
	// design away.** The node refuses to sign a PLC operation without one, which means the
	// account holder proves control of their address before a key that outranks Anthers is
	// seated. The hub holds the account's password, so if it could also read that token there
	// would be no second party in this at all.
	//
	// ⚠️ **Only the public half ever arrives here.** The keypair is generated in the browser and
	// the private half never leaves the tab — see `apps/web/src/lib/recovery-key.ts` for why a
	// key Anthers generated would defeat what the key is for.
	.post("/recovery-key/request", requireAuth, async (c) => {
		const user = c.get("user");
		const result = await requestRecoveryKeyToken(user.id);
		if (result.status === "sent") return c.json({ sent: true });
		return c.json({ error: result.message }, result.fault === "account" ? 409 : 503);
	})

	.post("/recovery-key/confirm", requireAuth, zValidator("json", recoveryKeySchema), async (c) => {
		const user = c.get("user");
		const { token, didKey } = c.req.valid("json");
		const result = await seatRecoveryKey(user.id, { token, didKey });
		if (result.status === "seated" || result.status === "already-held") {
			return c.json({ didKey: result.didKey, alreadyHeld: result.status === "already-held" });
		}
		// A bad key or a spent code are the person's to fix and are 400s; an account that may
		// not do this at all is a 409; a node that will not answer is a 503. Same three-way
		// split as the handle route, for the same reason.
		const status =
			result.fault === "key" || result.fault === "token"
				? 400
				: result.fault === "account"
					? 409
					: 503;
		return c.json({ error: result.message }, status);
	})

	// ── A signup waiting on an address ───────────────────────────────────────
	//
	// 🚨 **`GET /pending` and `POST /pending/cancel` moved to `/api/auth/signup/*` on
	// 2026-08-26**, when a parked ATProto identity generalized into a pending account both
	// doors write. They are not ATProto endpoints any more: the page that finishes a signup
	// asks one question — *what am I finishing?* — and the answer must not depend on which
	// door produced it.

	// ── Publishing a creator's records into their own repository ─────────────
	//
	// 🚨 **`ungranted` is a warning, never an offer.** A creator in it cannot publish anything
	// until they give the permission again, and the banner, Studio settings and every publish
	// control read this to say so before they try. The route answers for any signed-in account,
	// because whether somebody is a creator is not this endpoint's question to ask.
	//
	// ⭐ **It rechecks a grant on file with the creator's own server**, at most once per quarter
	// hour, which is how a permission taken back somewhere else reaches the banner before it
	// reaches a refusal. See `recheckPublishingGrant`.
	.get("/publishing", requireAuth, async (c) => {
		const user = c.get("user");
		return c.json(await publishingStateFor(user.id, { recheck: true }));
	})

	// ── Stop publishing ──────────────────────────────────────────────────────
	//
	// 🚨 **It takes the listings down before it hands the permission back**, because deleting a
	// record needs the permission being handed back — see `stopPublishingFor` for why the
	// reverse order would strand every listing on the network for good.
	//
	// ⚠️ **A partial removal answers 409 and keeps the grant.** Holding a permission somebody
	// asked to withdraw is the lesser harm: it is the only state a retry can finish from, and
	// the alternative is listings nobody can ever take down.
	.post("/publishing/stop", requireAuth, async (c) => {
		const user = c.get("user");
		const { stopPublishingFor } = await import("../services/work-listing.js");
		const result = await stopPublishingFor(user.id);
		if (!result.revoked) {
			return c.json(
				{
					error:
						`${result.stranded} listing(s) could not be removed, so the permission is still in ` +
						"place. Try again — stopping now would leave them on the network for good.",
					...result,
				},
				409,
			);
		}
		return c.json(result);
	});

export { atprotoRoutes };
