// SPDX-License-Identifier: AGPL-3.0-or-later
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import { setSessionCookie } from "../lib/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import { bearerToken } from "../middleware/bearer.js";
import { invalidBody } from "../middleware/validate.js";
import { isReservedUsername } from "../reserved-usernames.js";
import { attachPendingSignup } from "../services/atproto.js";
import {
	authorizeDesktopAuth,
	cleanupDesktopAuthRequests,
	createEmailVerificationToken,
	createPasswordResetToken,
	createSession,
	deleteSession,
	getPendingDesktopAuth,
	hashPassword,
	listUserSessions,
	redeemDesktopAuth,
	resetPassword,
	revokeUserSession,
	startDesktopAuth,
	validateSession,
	verifyEmailToken,
	verifyPassword,
} from "../services/auth.js";
import {
	sendSignInCodeEmail,
	sendSignupCodeEmail,
	sendVerificationEmail,
	sendWelcomeEmail,
} from "../services/email.js";
import { checkSignupCode, issueSignInCode, issueSignupCode } from "../services/signup-codes.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const signUpSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(150)
		.regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, underscores")
		// A name the router already answers to would sign up fine and then strand
		// the profile at an unreachable URL — see reserved-usernames.ts.
		.refine((name) => !isReservedUsername(name), "That username is reserved"),
	email: z.string().email().max(254),
	password: z.string().min(8).max(128),
	/**
	 * Must be `true`. Enforced at the API rather than only in the form, because the
	 * 13+ floor is the **one** thing Anthers asserts about age and an unaccepted
	 * assertion is not one — "you must be 13 or older" lived in a document no user had
	 * ever seen, which made it closer to a wish than a term.
	 *
	 * A literal rather than a boolean: `false` is not a value that should be accepted
	 * and silently recorded, it is a request that cannot be granted.
	 */
	acceptTerms: z.literal(true, {
		errorMap: () => ({ message: "You need to accept the terms to create an account." }),
	}),
});

const signInSchema = z.object({
	login: z.string(), // accepts username or email
	password: z.string(),
});

/**
 * Both emailed-code doors take the same two shapes — `/signup/*` (which may create an
 * account) and `/signin/*` (which never can). One pair of schemas, because the *request* is
 * genuinely the same request; what differs is what the route is willing to do with it.
 */
const emailCodeStartSchema = z.object({
	email: z.string().email().max(254),
});

const emailCodeVerifySchema = z.object({
	email: z.string().email().max(254),
	/**
	 * Six characters from the code alphabet, case-insensitively.
	 *
	 * Loose on purpose — the exact alphabet is `services/signup-codes.ts`'s business and
	 * a stricter regex here would leak it into the 400s, telling an attacker which
	 * symbols are worth trying. This only rejects a shape that cannot be a code at all.
	 */
	code: z.string().trim().length(6),
});

const claimUsernameSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(150)
		.regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, underscores")
		.refine((name) => !isReservedUsername(name), "That username is reserved"),
	/**
	 * Optional, and that is the point rather than an omission.
	 *
	 * Someone who would rather sign in with an emailed code should not be made to invent
	 * a password to get through onboarding — an unwanted password is one that gets reused
	 * or written down. Leaving it unset is a supported end state; `POST /auth/signin/*` —
	 * which is what `/login` does with an empty password field — is how those accounts come
	 * back, and `/subscribe` signs a known address in as well.
	 */
	password: z.string().min(8).max(128).optional(),
	acceptTerms: z.literal(true, {
		errorMap: () => ({ message: "You need to accept the terms to create an account." }),
	}),
});

const verifyEmailSchema = z.object({
	token: z.string().min(1),
});

const requestPasswordResetSchema = z.object({
	email: z.string().email(),
});

const resetPasswordSchema = z.object({
	token: z.string().min(1),
	password: z.string().min(8).max(128),
});

const changePasswordSchema = z.object({
	currentPassword: z.string(),
	newPassword: z.string().min(8).max(128),
});

/** A PKCE challenge/code/verifier — all are hex tokens from `generateToken()`. */
const hexToken = z
	.string()
	.min(32)
	.max(128)
	.regex(/^[0-9a-f]+$/, "Expected a lowercase hex token");

const desktopStartSchema = z.object({
	challenge: hexToken,
	label: z.string().min(1).max(80).optional(),
});

const desktopAuthorizeSchema = z.object({
	challenge: hexToken,
});

const desktopExchangeSchema = z.object({
	code: hexToken,
	verifier: hexToken,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Standard user shape returned from auth endpoints */
function serializeUser(user: typeof users.$inferSelect) {
	return {
		id: user.id,
		username: user.username,
		email: user.email,
		displayName: user.displayName,
		bio: user.bio,
		isCreator: user.isCreator,
		isAdmin: user.isAdmin,
		avatar: user.avatar,
		headerImage: user.headerImage,
		websiteUrl: user.websiteUrl,
		location: user.location,
		emailVerified: user.emailVerified,
		themePreference: user.themePreference,
		atprotoDid: user.atprotoDid,
		atprotoHandle: user.atprotoHandle,
		createdAt: user.createdAt,
	};
}

// The cookie helper moved to `lib/cookies.ts` — there were two copies and the
// other one omitted COOKIE_DOMAIN. `COOKIE_DOMAIN` is still read here for `deleteCookie`,
// which must be given the same domain or the cookie cannot be cleared.
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN;

// ─── Routes ──────────────────────────────────────────────────────────────────

const authRoutes = new Hono()
	// ── Sign Up ───────────────────────────────────────────────────────────────
	.post("/sign-up", zValidator("json", signUpSchema, invalidBody), async (c) => {
		const { username, email, password } = c.req.valid("json");

		// Check for existing user (username or email)
		const existing = await db
			.select({ id: users.id, username: users.username, email: users.email })
			.from(users)
			.where(or(eq(users.username, username), eq(users.email, email)))
			.limit(2);

		for (const row of existing) {
			if (row.username === username) {
				return c.json({ error: "Username already taken" }, 409);
			}
			if (row.email === email) {
				return c.json({ error: "Email already registered" }, 409);
			}
		}

		// Create user
		const passwordHash = await hashPassword(password);
		const [user] = await db.insert(users).values({ username, email, passwordHash }).returning();

		// Create session
		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		// Send the welcome + email-verification message. Never let a mail hiccup
		// fail the sign-up itself — the user can always re-request verification.
		const verifyToken = await createEmailVerificationToken(user.id);
		await sendWelcomeEmail(user.email, user.username, verifyToken);

		return c.json({ user: serializeUser(user) }, 201);
	})

	// ── Signup ceremony: prove the address, then build the account ───────────
	//
	// The order is the feature. `/subscribe` asks for an email and nothing else, this
	// pair confirms the address, and only then does anything ask for money or a name.
	// Parker's reasoning: every account should arrive with a confirmed address, and the
	// public page should ask for as little as it possibly can.
	//
	// Step 1 — issue a code. ALWAYS 200, whatever happened.
	.post("/signup/start", zValidator("json", emailCodeStartSchema, invalidBody), async (c) => {
		const { email } = c.req.valid("json");

		// Failures are swallowed on purpose. A mail outage, a throttled repeat and an
		// address that already has an account must all look identical from out here —
		// the moment one of them answers differently, this endpoint becomes a way to
		// ask "is this person on Anthers?" and get a reliable answer.
		try {
			const issued = await issueSignupCode(email);
			if (issued.code) {
				await (issued.existingAccount
					? sendSignInCodeEmail(email, issued.code)
					: sendSignupCodeEmail(email, issued.code));
			}
		} catch (err) {
			console.error("[signup/start] failed to issue a code:", err);
		}

		// Deliberately says nothing about what was sent, or whether anything was.
		return c.json({ success: true });
	})

	// Step 2 — spend the code. Creates the account, or signs the existing one in, and
	// issues the session cookie either way.
	//
	// 🚨 **Issuing the session here is the shortcut the whole ceremony rests on.** Once
	// the browser holds a session, the payment step is an ordinary authenticated call
	// and reuses the existing preview + modal machinery unchanged — no second identity,
	// no half-built account waiting on a charge to become real, and nothing to reconcile
	// if the card is declined. A declined card leaves a perfectly good free account,
	// which is the correct outcome and takes no code to arrange.
	.post("/signup/verify", zValidator("json", emailCodeVerifySchema, invalidBody), async (c) => {
		const { email, code } = c.req.valid("json");

		const result = await checkSignupCode(email, code);
		if (!result.ok) {
			// One message for every failure. Distinguishing "no code for this address"
			// from "wrong code" would confirm registration to anyone who asked, which is
			// the leak `/signup/start` is careful to avoid — closing it there and
			// reopening it here would be worse than never closing it.
			const status = result.reason === "too_many_attempts" ? 429 : 400;
			return c.json(
				{
					error:
						result.reason === "too_many_attempts"
							? "Too many attempts. Ask for a new code."
							: "That code didn't work. Check it, or ask for a new one.",
					reason: result.reason,
				},
				status,
			);
		}

		const [existing] = await db.select().from(users).where(eq(users.email, result.email)).limit(1);

		// Created accounts are `emailVerified: true` from the first instant, and get no
		// verification mail: the code they just typed IS the verification, and asking a
		// second time for the same fact is how a flow teaches people to ignore it.
		//
		// The username stays null until onboarding claims one — see the column's note
		// for why a placeholder was rejected rather than merely unnecessary.
		const user =
			existing ??
			(await db.insert(users).values({ email: result.email, emailVerified: true }).returning())[0];

		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		// 🚨 **A Bluesky signup that could not get a usable address from its PDS finishes
		// HERE**, and this is what makes it one ceremony rather than two. The identity was
		// proved by a completed OAuth round trip and parked; the code just typed proves the
		// address. Attaching now is safe precisely because of that order — the PDS's claim
		// about an address is somebody else's assertion, and a code we sent to a mailbox
		// they read is ours. It is also why this works for a *returning* account whose
		// address happens to match: they proved the mailbox, so it is theirs.
		//
		// Deliberately not fatal. A refusal means the DID already belongs to another
		// account, and the right outcome is a signed-in account with no link rather than a
		// failed signup — the person can sort the link out from settings.
		//
		// ⚠️ **Guarded, and it emits nothing when there is no pending token.** An
		// unconditional `deleteCookie` here added a second `Set-Cookie` to *every* signup,
		// which broke a client that read the header and took the first cookie — the ceremony
		// test does exactly that, and so might anything else. A route that has always
		// answered with one cookie should keep doing so on the path that has not changed.
		const pendingToken = getCookie(c, "atproto_pending");
		if (pendingToken) {
			await attachPendingSignup(pendingToken, user.id);
			deleteCookie(c, "atproto_pending", {
				path: "/",
				...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
			});
		}

		return c.json(
			{
				user: serializeUser(user),
				// What the client does next. `created` opens onboarding; a returning user
				// is simply signed in and keeps whatever they already had.
				created: !existing,
				// Onboarding is unfinished business for anyone without a handle, which
				// includes a returning user who abandoned it last time.
				needsOnboarding: user.username === null,
			},
			existing ? 200 : 201,
		);
	})

	// ── Onboarding: claim the handle, and optionally set a password ──────────
	//
	// The other half of the ceremony. The account already exists and is signed in, so
	// this is an ordinary authenticated call — it just happens to be the one that makes
	// the account visible to anybody else.
	.post(
		"/onboarding/claim",
		requireAuth,
		zValidator("json", claimUsernameSchema, invalidBody),
		async (c) => {
			const sessionUser = c.get("user");
			const { username, password } = c.req.valid("json");

			// Idempotent only in the trivial sense: claiming again is refused rather than
			// silently renaming. A handle is a URL other people hold, and changing one is
			// a different feature with different consequences (redirects, impersonation
			// of the vacated name) that this endpoint should not quietly become.
			if (sessionUser.username !== null) {
				return c.json({ error: "You've already chosen a username." }, 409);
			}

			const [taken] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.username, username))
				.limit(1);
			if (taken) {
				return c.json({ error: "Username already taken" }, 409);
			}

			const [user] = await db
				.update(users)
				.set({
					username,
					...(password ? { passwordHash: await hashPassword(password) } : {}),
				})
				.where(eq(users.id, sessionUser.id))
				.returning();

			return c.json({ user: serializeUser(user) });
		},
	)

	// ── Sign In (accepts username or email) ──────────────────────────────────
	.post("/sign-in", zValidator("json", signInSchema, invalidBody), async (c) => {
		const { login, password } = c.req.valid("json");

		// Look up by username or email
		const [user] = await db
			.select()
			.from(users)
			.where(or(eq(users.username, login), eq(users.email, login)))
			.limit(1);

		if (!user?.passwordHash) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		const valid = await verifyPassword(password, user.passwordHash);
		if (!valid) {
			return c.json({ error: "Invalid credentials" }, 401);
		}

		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		return c.json({ user: serializeUser(user) });
	})

	// ── Sign In without a password (the emailed code, from /login) ───────────
	//
	// The same proof of address the signup ceremony uses, narrowed so that it can only ever
	// sign someone in. `/login` leaves the password field empty and lands here.
	//
	// 🚨 **Why this is not just `/signup/start` called from a second page.** That pair
	// *creates an account* when the address is unknown, which is the one thing the login
	// page must never do — `/subscribe` is the single signup door precisely so that terms
	// acceptance, onboarding and where a new account lands have one description rather than
	// two that drift. A page that mints accounts as a side effect of a mistyped address is
	// that second door, however little it looks like one.
	//
	// Step 1 — issue a code, but only to an address that already has an account. ALWAYS 200.
	.post("/signin/start", zValidator("json", emailCodeStartSchema, invalidBody), async (c) => {
		const { email } = c.req.valid("json");

		try {
			// `issueSignInCode` is the half that decides — see its note for why an unknown
			// address gets no row (and not merely no email), and for the timing question.
			const issued = await issueSignInCode(email);
			if (issued.code) {
				// Off the response path on purpose: awaiting a network call here would make
				// "this address has an account" measurable in milliseconds, which is the
				// question the identical body exists to refuse.
				void sendSignInCodeEmail(email, issued.code).catch((err) => {
					console.error("[signin/start] failed to send the code:", err);
				});
			}
		} catch (err) {
			console.error("[signin/start] failed to issue a code:", err);
		}

		// Says nothing about what was sent, or whether anything was. Byte-identical to the
		// unknown-address answer, and a test pins that.
		return c.json({ success: true });
	})

	// Step 2 — spend the code and sign in. Creates nothing, ever.
	.post("/signin/verify", zValidator("json", emailCodeVerifySchema, invalidBody), async (c) => {
		const { email, code } = c.req.valid("json");

		const result = await checkSignupCode(email, code);
		if (!result.ok) {
			// The same one message `/signup/verify` gives, for the same reason: two doors
			// onto one code table are only as quiet as the louder of them.
			const status = result.reason === "too_many_attempts" ? 429 : 400;
			return c.json(
				{
					error:
						result.reason === "too_many_attempts"
							? "Too many attempts. Ask for a new code."
							: "That code didn't work. Check it, or ask for a new one.",
					reason: result.reason,
				},
				status,
			);
		}

		const [user] = await db.select().from(users).where(eq(users.email, result.email)).limit(1);
		if (!user) {
			// Reachable only by someone holding a live code for an address with no account —
			// which `/signin/start` never issues, so it means a code minted at `/subscribe`
			// was typed in here instead. Naming that plainly costs nothing: reaching this
			// line already requires reading the mailbox, so there is no enumeration left to
			// protect. What it must not do is quietly create the account.
			return c.json(
				{ error: "There's no Anthers account for that address yet — sign up to create one." },
				404,
			);
		}

		const token = await createSession(
			user.id,
			c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
			c.req.header("User-Agent"),
		);
		setSessionCookie(c, token);

		return c.json({
			user: serializeUser(user),
			// Someone who abandoned onboarding still owes a handle, and the code is the only
			// way that account comes back at all — so this door has to be able to say so.
			needsOnboarding: user.username === null,
		});
	})

	// ── Sign Out ──────────────────────────────────────────────────────────────
	// Reads the bearer token first so a desktop sign-out ends the DESKTOP session
	// rather than silently doing nothing (these two routes resolve the session
	// themselves instead of going through requireAuth, so they need the same rule).
	.post("/sign-out", async (c) => {
		const token = bearerToken(c) ?? getCookie(c, "session");
		if (token) {
			await deleteSession(token);
		}
		deleteCookie(c, "session", { path: "/", ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}) });
		return c.json({ success: true });
	})

	// ── Current User ─────────────────────────────────────────────────────────
	.get("/me", async (c) => {
		const presentedBearer = bearerToken(c);
		const token = presentedBearer ?? getCookie(c, "session");
		if (!token) {
			return c.json({ user: null });
		}

		const result = await validateSession(token);
		if (!result) {
			// Only a browser has a cookie to clear; a dead bearer token is the client's
			// to discard, and clearing the cookie here would sign the browser out of a
			// session the desktop app's staleness says nothing about.
			if (!presentedBearer) {
				deleteCookie(c, "session", {
					path: "/",
					...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
				});
			}
			return c.json({ user: null });
		}

		return c.json({ user: serializeUser(result.user) });
	})

	// ── Email Verification ───────────────────────────────────────────────────
	.post("/verify-email", zValidator("json", verifyEmailSchema, invalidBody), async (c) => {
		const { token } = c.req.valid("json");
		const userId = await verifyEmailToken(token);

		if (!userId) {
			return c.json({ error: "Invalid or expired verification token" }, 400);
		}

		return c.json({ success: true });
	})

	// ── Resend Verification Email ────────────────────────────────────────────
	.post("/resend-verification", requireAuth, async (c) => {
		const user = c.get("user");

		// Check if already verified
		const [fullUser] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);

		if (fullUser?.emailVerified) {
			return c.json({ error: "Email already verified" }, 400);
		}

		const verifyToken = await createEmailVerificationToken(user.id);
		await sendVerificationEmail(user.email, user.username, verifyToken);
		return c.json({ success: true });
	})

	// ── Request Password Reset ───────────────────────────────────────────────
	.post(
		"/request-password-reset",
		zValidator("json", requestPasswordResetSchema, invalidBody),
		async (c) => {
			const { email } = c.req.valid("json");

			// Always return success to prevent email enumeration
			const [user] = await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, email))
				.limit(1);

			if (user) {
				await createPasswordResetToken(user.id);
				// In production, would send email here
			}

			return c.json({ success: true });
		},
	)

	// ── Reset Password ───────────────────────────────────────────────────────
	.post("/reset-password", zValidator("json", resetPasswordSchema, invalidBody), async (c) => {
		const { token, password } = c.req.valid("json");
		const success = await resetPassword(token, password);

		if (!success) {
			return c.json({ error: "Invalid or expired reset token" }, 400);
		}

		return c.json({ success: true });
	})

	// ── Change Password (authenticated) ──────────────────────────────────────
	.post(
		"/change-password",
		requireAuth,
		zValidator("json", changePasswordSchema, invalidBody),
		async (c) => {
			const user = c.get("user");
			const { currentPassword, newPassword } = c.req.valid("json");

			// Get full user record with password hash
			const [fullUser] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);

			if (!fullUser?.passwordHash) {
				return c.json({ error: "Cannot change password for ATProto-only accounts" }, 400);
			}

			const valid = await verifyPassword(currentPassword, fullUser.passwordHash);
			if (!valid) {
				return c.json({ error: "Current password is incorrect" }, 401);
			}

			const passwordHash = await hashPassword(newPassword);
			await db.update(users).set({ passwordHash }).where(eq(users.id, user.id));

			return c.json({ success: true });
		},
	)

	// ── Devices / Sessions ───────────────────────────────────────────────────
	// The revocation surface that makes long-lived desktop tokens safe to hand out:
	// a stolen laptop is killable without signing every browser out.
	.get("/sessions", requireAuth, async (c) => {
		const user = c.get("user");
		const current = c.get("sessionToken");
		const rows = await listUserSessions(user.id);
		const currentId = await validateSession(current).then((r) => r?.session.id ?? null);
		return c.json({
			sessions: rows.map((s) => ({ ...s, current: s.id === currentId })),
		});
	})

	.delete("/sessions/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id)) return c.json({ error: "Invalid session id" }, 400);

		const revoked = await revokeUserSession(user.id, id);
		if (!revoked) return c.json({ error: "Not found" }, 404);
		return c.json({ success: true });
	})

	// ── Desktop Enrolment ────────────────────────────────────────────────────
	// The desktop Studio never sees a password. It opens the authorize page in the
	// SYSTEM browser, where the creator already holds a cookie session, and one
	// confirm click mints an independently revocable desktop token. PKCE binds the
	// app that started the flow to the app that redeems it. See 42.06 § Desktop auth.

	// Step 1 — the app opens the flow with only a PKCE challenge. Deliberately
	// unauthenticated: no session exists yet and no user is implied.
	.post("/desktop/start", zValidator("json", desktopStartSchema, invalidBody), async (c) => {
		const { challenge, label } = c.req.valid("json");
		await startDesktopAuth(challenge, label ?? null);
		// Opportunistic sweep — these rows are short-lived and low-volume, so this
		// costs less than owning a scheduled job for them.
		void cleanupDesktopAuthRequests().catch(() => {});
		return c.json({ success: true }, 201);
	})

	// Step 2 — the authorize page asks what it is about to approve. Returns only the
	// device label, never anything derived from a session.
	.get("/desktop/pending/:challenge", async (c) => {
		const pending = await getPendingDesktopAuth(c.req.param("challenge"));
		if (!pending) return c.json({ error: "This sign-in request has expired" }, 404);
		return c.json({ label: pending.label, expiresAt: pending.expiresAt });
	})

	// Step 3 — the confirm click, under the browser's normal cookie session. This is
	// what turns "this browser is signed in" into a separate desktop credential.
	.post(
		"/desktop/authorize",
		requireAuth,
		zValidator("json", desktopAuthorizeSchema, invalidBody),
		async (c) => {
			const user = c.get("user");
			const { challenge } = c.req.valid("json");

			const code = await authorizeDesktopAuth(
				challenge,
				user.id,
				c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP") ?? null,
				c.req.header("User-Agent") ?? null,
			);
			if (!code) return c.json({ error: "This sign-in request has expired" }, 404);

			return c.json({ code });
		},
	)

	// Step 4 — the app redeems the code with its verifier and receives the token.
	// Unauthenticated by design: possession of code + verifier IS the proof.
	.post("/desktop/exchange", zValidator("json", desktopExchangeSchema, invalidBody), async (c) => {
		const { code, verifier } = c.req.valid("json");

		const token = await redeemDesktopAuth(code, verifier);
		if (!token) return c.json({ error: "Invalid or expired code" }, 400);

		const result = await validateSession(token);
		if (!result) return c.json({ error: "Invalid or expired code" }, 400);

		// The one place a session token is returned in a body rather than a Set-Cookie:
		// the caller is not a browser and has no cookie jar to put it in.
		return c.json({ token, user: serializeUser(result.user) });
	});

export { authRoutes };
