// SPDX-License-Identifier: AGPL-3.0-or-later
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { MAX_PICKED_CREATORS, MAX_SIGNUP_AMOUNT } from "@anthers/shared/signup";
import { zValidator } from "@hono/zod-validator";
import { eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie } from "hono/cookie";
import { z } from "zod";
import {
	clearPendingSignupCookie,
	PENDING_SIGNUP_COOKIE,
	setPendingSignupCookie,
	setSessionCookie,
} from "../lib/cookies.js";
import { requireAuth } from "../middleware/auth.js";
import { bearerToken } from "../middleware/bearer.js";
import { invalidBody } from "../middleware/validate.js";
import { isReservedUsername } from "../reserved-usernames.js";
import { atprotoSignupEnabled } from "../services/atproto.js";
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
import {
	clearPendingSignup,
	consumePendingSignup,
	markCodeSent,
	picksOf,
	readPendingSignup,
	resumeByProvedAddress,
	setPendingEmail,
	startPendingSignup,
	sweepExpiredPendingSignups,
} from "../services/pending-signups.js";
import { checkSignupCode, issueSignInCode, issueSignupCode } from "../services/signup-codes.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const signUpSchema = z.object({
	username: z
		.string()
		.min(3)
		.max(150)
		.regex(/^[a-zA-Z0-9_-]+$/, "Username can only contain letters, numbers, hyphens, underscores")
		// Impersonation only: profiles live under `/@name`, so a handle cannot collide
		// with a page and there is no route blacklist — see reserved-usernames.ts.
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

/**
 * The choices `/subscribe` is holding when somebody presses *Create My Account*.
 *
 * ⚠️ **Bounded rather than accepted as posted.** This arrives from a browser and is stored
 * as jsonb on a row nobody has yet proved anything about, so the ceiling is here rather
 * than in the shape's own definition — `@anthers/shared/signup` describes what the picks
 * *are*, and this describes what a stranger may send.
 */
const signupPicksSchema = z.object({
	anthers: z.number().min(0).max(MAX_SIGNUP_AMOUNT),
	follow: z.array(z.string().min(1).max(150)).max(MAX_PICKED_CREATORS),
	seed: z.array(z.string().min(1).max(150)).max(MAX_PICKED_CREATORS),
});

/**
 * Asking for an account.
 *
 * The address is **optional**, because the Bluesky door leaves `/subscribe` before it has
 * one: the identity is proved first and the PDS may or may not hand an address over, so the
 * row is written with the picks alone and the address lands on it later.
 */
const signupBeginSchema = z.object({
	email: z.string().email().max(254).optional(),
	picks: signupPicksSchema,
	next: z.string().max(2048).optional(),
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

/**
 * What the page finishing a signup is told about it.
 *
 * ⚠️ **One shape, always, and `null` when there is nothing.** Two `c.json` calls returning
 * different objects give the RPC client a union every caller then has to narrow by hand.
 *
 * 🚨 **It describes a signup this browser started and nothing else**, because it answers
 * from the httpOnly cookie alone. A hand-typed URL gets `null`, so the finishing page cannot
 * be talked into displaying somebody else's handle by anybody who knows it.
 */
function serializePendingSignup(row: Awaited<ReturnType<typeof readPendingSignup>>) {
	if (!row) return null;
	return {
		email: row.email,
		/**
		 * Whether a code has actually gone out to that address.
		 *
		 * 🚨 **Separate from holding the address, and the finishing page needs both.** The
		 * Bluesky door learns an address at the OAuth callback, which sends nothing — so a
		 * page choosing its state on `email` alone announced "check your email" for mail that
		 * was never posted.
		 */
		codeSent: row.codeSentAt !== null,
		/** Whether a code sent to that address has already been completed — see the resume path. */
		addressProved: row.emailProvedAt !== null,
		atprotoHandle: row.atprotoDid ? row.atprotoHandle : null,
		picks: picksOf(row),
		next: row.next,
	};
}

/**
 * Turn a proved address into a signed-in account, spending whatever pending signup this
 * browser is carrying.
 *
 * 🚨 **This is the ONE place an account comes into existence from a proved address**, and
 * both routes that can do it call it rather than repeating it. The two of them differ only
 * in what proved the address — a code spent here, or a code spent at `/signin/verify` on a
 * signup being resumed in another browser — and that difference must not turn into two
 * descriptions of what a new account looks like. The last time signup had two descriptions
 * of itself they drifted about terms acceptance and onboarding, which is why there is one
 * door at all.
 *
 * A created account is `emailVerified: true` from the first instant and gets no
 * verification mail: the code just typed IS the verification, and asking a second time for
 * the same fact is how a flow teaches people to ignore it. `username` stays null, which is
 * what makes the account `needsOnboarding` and routes it to `/welcome` — the only place the
 * terms and the 13+ assertion are ever presented.
 */
async function mintFromProvedAddress(
	c: Parameters<typeof setSessionCookie>[0] & {
		req: { header: (name: string) => string | undefined };
	},
	email: string,
	pendingToken: string | undefined,
) {
	const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
	const user =
		existing ?? (await db.insert(users).values({ email, emailVerified: true }).returning())[0];

	const token = await createSession(
		user.id,
		c.req.header("X-Forwarded-For") ?? c.req.header("CF-Connecting-IP"),
		c.req.header("User-Agent"),
	);
	setSessionCookie(c, token);

	// 🚨 **A Bluesky signup finishes HERE**, and that is what makes it one ceremony rather
	// than two. The identity was proved by a completed OAuth round trip and written down;
	// the code just typed proves the address. Attaching now is safe precisely because of
	// that order — a PDS's claim about an address is somebody else's assertion, and a code
	// we sent to a mailbox they read is ours. It is also why this works for a *returning*
	// account whose address happens to match: they proved the mailbox, so it is theirs.
	//
	// ⚠️ Deliberately not fatal. A refusal means the DID already belongs to another account,
	// and the right outcome is a signed-in account with no link rather than a failed signup.
	const spent = pendingToken ? await consumePendingSignup(pendingToken, user.id) : null;
	if (pendingToken) clearPendingSignupCookie(c);

	return {
		body: {
			user: serializeUser(user),
			// What the client does next. `created` opens onboarding; a returning user is
			// simply signed in and keeps whatever they already had.
			created: !existing,
			// Onboarding is unfinished business for anyone without a handle, which includes a
			// returning user who abandoned it last time.
			needsOnboarding: user.username === null,
			// What the signup was carrying, so the finishing page commits the choices somebody
			// made minutes ago rather than asking for them again.
			picks: spent?.picks ?? null,
			next: spent?.next || null,
			atprotoLinked: spent?.atprotoLinked ?? false,
		},
		created: !existing,
	};
}

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

	// ── Signup ceremony: ask, prove the address, then build the account ──────
	//
	// The order is the feature. `/subscribe` is where a visitor makes their choices;
	// pressing *Create My Account* writes them down and takes the person **off** that page
	// to one whose only job is finishing. This is where that happens. Parker's reasoning:
	// every account should arrive with a confirmed address, the public page should ask for
	// as little as it possibly can, and the next thing asked of somebody should be the only
	// thing in front of them rather than a modal over a page still inviting them to change
	// their picks.
	//
	// Step 0 — write the pending account down and send the code.
	//
	// 🚨 **The row is written before anything is proved, which is exactly why it is not a
	// `users` row.** `users.email` is `NOT NULL UNIQUE`, so a pending account there would
	// claim an address on the strength of somebody having typed it — see
	// `services/pending-signups.ts`.
	//
	// It answers 200 whatever happened, for the same reason `/signup/start` does: the
	// moment this endpoint answers differently for an address that already has an account,
	// it becomes a way to ask "is this person on Anthers?" and get a reliable answer.
	.post("/signup/begin", zValidator("json", signupBeginSchema, invalidBody), async (c) => {
		const { email, picks, next } = c.req.valid("json");

		// Opportunistic rather than scheduled. `prune-credentials` sweeps these overnight
		// too; doing it here as well means the table cannot grow unboundedly between runs on
		// the one route that creates rows in it.
		void sweepExpiredPendingSignups().catch(() => {});

		const token = await startPendingSignup({
			previousToken: getCookie(c, PENDING_SIGNUP_COOKIE),
			email,
			picks,
			next,
		});
		setPendingSignupCookie(c, token);

		// Failures are swallowed on purpose, exactly as at `/signup/start`. A mail outage, a
		// throttled repeat and an address that already has an account must all look identical
		// from out here.
		if (email) {
			try {
				const issued = await issueSignupCode(email);
				if (issued.code) {
					await (issued.existingAccount
						? sendSignInCodeEmail(email, issued.code)
						: sendSignupCodeEmail(email, issued.code));
				}
				// Stamped whether or not a code was minted: a throttled repeat means one went
				// out a moment ago, which is exactly the state the finishing page should show.
				await markCodeSent(token);
			} catch (err) {
				console.error("[signup/begin] failed to issue a code:", err);
			}
		}

		return c.json({ success: true });
	})

	// What the finishing page needs in order to say whose signup it is finishing, and to
	// show the choices it is about to commit. Answers from the cookie and nothing else.
	.get("/signup/pending", async (c) => {
		const row = await readPendingSignup(getCookie(c, PENDING_SIGNUP_COOKIE));
		return c.json({
			pending: serializePendingSignup(row),
			// So the finishing page knows whether to offer connecting Bluesky at all — the
			// same reason `/api/atproto/config` exists. A button that refuses when pressed is
			// worse than no button.
			atprotoSignupEnabled: atprotoSignupEnabled(),
		});
	})

	// Abandon it — the "actually, never mind" on the finishing page. The row goes as well as
	// the cookie, because an unfinished signup nobody is claiming is a row waiting to expire.
	.post("/signup/cancel", async (c) => {
		const token = getCookie(c, PENDING_SIGNUP_COOKIE);
		await clearPendingSignup(token);
		if (token) clearPendingSignupCookie(c);
		return c.json({ success: true });
	})

	// Step 1 — issue a code. ALWAYS 200, whatever happened.
	//
	// ⚠️ This is the **resend**, and the address it is given may be a new one: somebody whose
	// PDS gave us no address types theirs here, and somebody who mistyped theirs at
	// `/subscribe` corrects it. Either way the pending row has to follow, or the account
	// would be minted against the address they abandoned.
	.post("/signup/start", zValidator("json", emailCodeStartSchema, invalidBody), async (c) => {
		const { email } = c.req.valid("json");

		// The pending row follows the address the code is actually going to. Without this a
		// corrected typo would leave the row pointing at the mistyped address, and the resume
		// path would go looking for a mailbox nobody can read.
		const pendingToken = getCookie(c, PENDING_SIGNUP_COOKIE);
		if (pendingToken && (await readPendingSignup(pendingToken))) {
			await setPendingEmail(pendingToken, email);
		}

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
			// The address on the row is now one we have actually posted to, which is what
			// lets the finishing page show a code box rather than an address field.
			await markCodeSent(pendingToken);
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

		const minted = await mintFromProvedAddress(
			c,
			result.email,
			getCookie(c, PENDING_SIGNUP_COOKIE),
		);
		return c.json(minted.body, minted.created ? 201 : 200);
	})

	// Step 2b — finish a signup whose address was proved somewhere else.
	//
	// 🚨 **This exists because of resumption in a DIFFERENT browser, and it creates nothing
	// that `/signup/verify` would not have created.** Somebody who starts a signup on a
	// laptop and opens the mail on a phone has no cookie on the phone; they sign in at
	// `/login` with their address, and the code they complete there proves the mailbox and
	// hands the pending signup to that browser. The code is spent by then, so asking for a
	// second one would be asking them to prove the same fact twice — this spends the
	// `emailProvedAt` stamp instead.
	//
	// ⚠️ **The two things it insists on are what keep it from being a second signup door.**
	// It needs a pending signup bound to this browser by cookie, and that row must already
	// carry the stamp. Neither can be produced by asking: the row only exists because
	// somebody pressed *Create My Account* at `/subscribe`, and the stamp only exists
	// because somebody read a code out of the mailbox on it.
	.post("/signup/complete", async (c) => {
		const pendingToken = getCookie(c, PENDING_SIGNUP_COOKIE);
		const row = await readPendingSignup(pendingToken);
		if (!row?.email || !row.emailProvedAt) {
			return c.json({ error: "There's nothing to finish here — start at /subscribe." }, 404);
		}

		const minted = await mintFromProvedAddress(c, row.email, pendingToken);
		return c.json(minted.body, minted.created ? 201 : 200);
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
			// 🚨 **An unfinished signup resumes here, and this route still creates nothing.**
			// Somebody who pressed *Create My Account* in another browser has a pending signup
			// and no account; they have just proved the address on it, which is the only thing
			// resumption may ever be gated on. So the row is handed to *this* browser and the
			// browser is sent to the page that finishes it — where `POST /signup/complete` is
			// what actually mints the account, on the signup pair where minting belongs.
			//
			// ⚠️ **The identity on that row does not come with it**, because an address was
			// proved and an identity was not. See `resumeByProvedAddress` for the takeover
			// that closes.
			const resumed = await resumeByProvedAddress(result.email);
			if (resumed) {
				setPendingSignupCookie(c, resumed.token);
				return c.json({ user: null, needsOnboarding: true, resume: true });
			}

			// Reachable only by someone holding a live code for an address with no account and
			// no pending signup — which `/signin/start` never issues, so it means a code minted
			// at `/subscribe` was typed in here instead. Naming that plainly costs nothing:
			// reaching this line already requires reading the mailbox, so there is no
			// enumeration left to protect. What it must not do is quietly create the account.
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

		// One shape for both outcomes. Two `c.json` calls returning different objects give the
		// RPC client a union type that every caller then has to narrow by hand.
		return c.json({
			user: serializeUser(user),
			// Someone who abandoned onboarding still owes a handle, and the code is the only
			// way that account comes back at all — so this door has to be able to say so.
			needsOnboarding: user.username === null,
			resume: false,
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

	// ── Desktop Enrollment ────────────────────────────────────────────────────
	// The desktop Studio never sees a password. It opens the authorize page in the
	// SYSTEM browser, where the creator already holds a cookie session, and one
	// confirm click mints an independently revocable desktop token. PKCE binds the
	// app that started the flow to the app that redeems it. See `apps/api/src/middleware/bearer.ts`.

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
