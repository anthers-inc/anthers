// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The signup ceremony: prove the address, then build the account.
//
// Two halves, tested against a real database because the interesting rules are all
// stateful — the resend throttle, the attempt cap and the single-live-code invariant are
// each about what a *second* request sees.
//
// What is deliberately asserted here rather than through the UI: the endpoint must not
// become an oracle for "is this address registered?". That property has no visible
// symptom and no error, which is exactly the kind of claim this codebase has learned to
// pin down (see the third-party-requests lesson — where a document claims an absence,
// that absence needs a test).
import { afterAll, describe, expect, test } from "bun:test";
import { db } from "@anthers/db/client";
import { signupCodes, users } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import {
	checkSignupCode,
	generateSignupCode,
	issueSignupCode,
	normalizeEmail,
	SIGNUP_CODE_MAX_ATTEMPTS,
	SIGNUP_CODE_RESEND_MS,
	SIGNUP_CODE_TTL_MS,
} from "../services/signup-codes.js";

/** Unique per run, so concurrent runs and leftovers never collide. */
const RUN = `cer${Date.now()}${Math.floor(Math.random() * 1000)}`;
const addr = (tag: string) => `${RUN}-${tag}@example.com`;

/** CSRF requires a real browser Origin — a bare Request never reaches the handler. */
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", ...headers },
		body: JSON.stringify(body),
	});
}

afterAll(async () => {
	// The unit suites share the dev database, so clean up after ourselves — see the
	// Agents Hub's note on the dev DB not being a clean room.
	await db.delete(signupCodes).where(like(signupCodes.email, `${RUN}-%`));
	await db.delete(users).where(like(users.email, `${RUN}-%`));
});

describe("the code itself", () => {
	test("is six characters from an alphabet with no confusable pairs", () => {
		for (let i = 0; i < 200; i++) {
			const code = generateSignupCode();
			expect(code).toHaveLength(6);
			// O/0, I/1/L are the pairs someone retyping from an email gets wrong, and a
			// correct-but-unreadable code fails exactly like a wrong one.
			expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
		}
	});

	test("does not repeat itself across draws", () => {
		// Not a randomness test — a guard against someone replacing the CSPRNG with
		// something seeded or constant, which would look fine in every other assertion.
		const seen = new Set(Array.from({ length: 200 }, generateSignupCode));
		expect(seen.size).toBeGreaterThan(190);
	});
});

describe("addresses are one key", () => {
	test("case and surrounding space do not make a second account", async () => {
		expect(normalizeEmail("  A@B.COM ")).toBe("a@b.com");
	});

	test("a code issued for one casing verifies under another", async () => {
		const email = addr("case");
		const issued = await issueSignupCode(email.toUpperCase());
		expect(issued.code).not.toBeNull();

		const check = await checkSignupCode(email, issued.code as string);
		expect(check.ok).toBe(true);
	});

	test("the code is accepted in lower case, as a reader would retype it", async () => {
		const email = addr("lower");
		const issued = await issueSignupCode(email);
		const check = await checkSignupCode(email, (issued.code as string).toLowerCase());
		expect(check.ok).toBe(true);
	});
});

describe("the code is stored hashed, not held", () => {
	test("the plaintext is nowhere in the row", async () => {
		const email = addr("hash");
		const issued = await issueSignupCode(email);
		const [row] = await db.select().from(signupCodes).where(eq(signupCodes.email, email));

		expect(row.codeHash).not.toContain(issued.code as string);
		expect(row.codeHash.startsWith("$argon2id$")).toBe(true);
	});
});

describe("one live code per address", () => {
	test("re-requesting replaces the previous code rather than adding one", async () => {
		const email = addr("replace");
		const first = await issueSignupCode(email);
		// Past the throttle, so this is a genuine re-request rather than a no-op.
		const second = await issueSignupCode(email, new Date(Date.now() + SIGNUP_CODE_RESEND_MS + 1));
		expect(second.code).not.toBeNull();

		const rows = await db.select().from(signupCodes).where(eq(signupCodes.email, email));
		expect(rows).toHaveLength(1);

		// The whole point: a mailbox holding two codes has exactly one that works.
		expect((await checkSignupCode(email, first.code as string)).ok).toBe(false);
		expect((await checkSignupCode(email, second.code as string)).ok).toBe(true);
	});

	test("a re-request clears the attempts spent on the old code", async () => {
		const email = addr("attreset");
		await issueSignupCode(email);
		await checkSignupCode(email, "AAAAAA");
		await checkSignupCode(email, "BBBBBB");

		const fresh = await issueSignupCode(email, new Date(Date.now() + SIGNUP_CODE_RESEND_MS + 1));
		const [row] = await db.select().from(signupCodes).where(eq(signupCodes.email, email));
		expect(row.attempts).toBe(0);
		expect((await checkSignupCode(email, fresh.code as string)).ok).toBe(true);
	});
});

describe("the send throttle", () => {
	test("a second request inside the window sends nothing", async () => {
		const email = addr("throttle");
		const first = await issueSignupCode(email);
		expect(first.throttled).toBe(false);

		const second = await issueSignupCode(email);
		expect(second.throttled).toBe(true);
		expect(second.code).toBeNull();

		// And the first code still works — a throttled repeat must not invalidate the
		// code the user is in the middle of typing.
		expect((await checkSignupCode(email, first.code as string)).ok).toBe(true);
	});

	test("past the window a new code is issued", async () => {
		const email = addr("unthrottle");
		await issueSignupCode(email);
		const later = await issueSignupCode(email, new Date(Date.now() + SIGNUP_CODE_RESEND_MS + 1));
		expect(later.throttled).toBe(false);
		expect(later.code).not.toBeNull();
	});
});

describe("spending a code", () => {
	test("a correct code deletes the row, so it cannot be replayed", async () => {
		const email = addr("replay");
		const issued = await issueSignupCode(email);
		const code = issued.code as string;

		expect((await checkSignupCode(email, code)).ok).toBe(true);
		const second = await checkSignupCode(email, code);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.reason).toBe("no_code");

		const rows = await db.select().from(signupCodes).where(eq(signupCodes.email, email));
		expect(rows).toHaveLength(0);
	});

	test("an expired code is refused and swept", async () => {
		const email = addr("expired");
		const issued = await issueSignupCode(email);
		const after = new Date(Date.now() + SIGNUP_CODE_TTL_MS + 1);

		const check = await checkSignupCode(email, issued.code as string, after);
		expect(check.ok).toBe(false);
		if (!check.ok) expect(check.reason).toBe("expired");
	});

	test("the attempt cap spends the code, and the right code no longer works", async () => {
		const email = addr("cap");
		const issued = await issueSignupCode(email);
		const code = issued.code as string;

		// Walk it wrong exactly to the cap. "ZZZZZZ" is a valid shape and a wrong value.
		for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
			const attempt = await checkSignupCode(email, "ZZZZZZ");
			expect(attempt.ok).toBe(false);
		}

		// 🚨 The property that matters: the CORRECT code is now dead too. A cap that
		// still admits the right answer stops nothing — the attacker walking the space
		// is precisely the person who will eventually present it.
		const withRealCode = await checkSignupCode(email, code);
		expect(withRealCode.ok).toBe(false);
		if (!withRealCode.ok) expect(withRealCode.reason).toBe("too_many_attempts");
	});

	test("every wrong guess is counted, including one that throws nothing", async () => {
		const email = addr("count");
		await issueSignupCode(email);
		await checkSignupCode(email, "ZZZZZZ");
		await checkSignupCode(email, "YYYYYY");

		const [row] = await db.select().from(signupCodes).where(eq(signupCodes.email, email));
		expect(row.attempts).toBe(2);
	});
});

describe("POST /auth/signup/start tells the caller nothing", () => {
	test("an unknown address and a registered one are indistinguishable", async () => {
		const known = addr("known");
		// Give the address a real account first.
		const issued = await issueSignupCode(known);
		await post("/api/auth/signup/verify", { email: known, code: issued.code });

		const unknownRes = await post("/api/auth/signup/start", { email: addr("unknown") });
		const knownRes = await post("/api/auth/signup/start", { email: known });

		expect(unknownRes.status).toBe(200);
		expect(knownRes.status).toBe(200);
		// Byte-identical bodies. If either ever carries a hint — `created`, `exists`, a
		// different message — this endpoint becomes a way to ask who is on Anthers.
		expect(await unknownRes.text()).toBe(await knownRes.text());
	});

	test("a throttled repeat still answers 200 with the same body", async () => {
		const email = addr("quiet");
		const first = await post("/api/auth/signup/start", { email });
		const second = await post("/api/auth/signup/start", { email });

		expect(second.status).toBe(200);
		expect(await second.text()).toBe(await first.text());
	});
});

describe("POST /auth/signup/verify", () => {
	test("creates the account, verified, nameless, and signed in", async () => {
		const email = addr("create");
		const issued = await issueSignupCode(email);

		const res = await post("/api/auth/signup/verify", { email, code: issued.code });
		expect(res.status).toBe(201);

		const body = (await res.json()) as {
			user: { id: number; username: string | null; emailVerified: boolean };
			created: boolean;
			needsOnboarding: boolean;
		};
		expect(body.created).toBe(true);
		expect(body.needsOnboarding).toBe(true);
		expect(body.user.username).toBeNull();

		// Verified from the first instant: the code they just typed IS the verification,
		// and a second "please confirm" would teach them to ignore the first.
		expect(body.user.emailVerified).toBe(true);

		// The session cookie is the shortcut the ceremony rests on — without it the
		// payment step would need a second identity to reconcile.
		expect(res.headers.get("Set-Cookie") ?? "").toContain("session=");
	});

	test("signs an existing account in rather than creating a second one", async () => {
		const email = addr("return");
		const first = await issueSignupCode(email);
		const created = await post("/api/auth/signup/verify", { email, code: first.code });
		const createdBody = (await created.json()) as { user: { id: number } };

		const second = await issueSignupCode(email, new Date(Date.now() + SIGNUP_CODE_RESEND_MS + 1));
		const res = await post("/api/auth/signup/verify", { email, code: second.code });
		expect(res.status).toBe(200);

		const body = (await res.json()) as { user: { id: number }; created: boolean };
		expect(body.created).toBe(false);
		expect(body.user.id).toBe(createdBody.user.id);
		expect(res.headers.get("Set-Cookie") ?? "").toContain("session=");

		const rows = await db.select().from(users).where(eq(users.email, email));
		expect(rows).toHaveLength(1);
	});

	test("a wrong code is refused with one message, whoever the address belongs to", async () => {
		const registered = addr("msg-known");
		const issued = await issueSignupCode(registered);
		await post("/api/auth/signup/verify", { email: registered, code: issued.code });

		const onKnown = await post("/api/auth/signup/verify", {
			email: registered,
			code: "ZZZZZZ",
		});
		const onUnknown = await post("/api/auth/signup/verify", {
			email: addr("msg-unknown"),
			code: "ZZZZZZ",
		});

		expect(onKnown.status).toBe(400);
		expect(onUnknown.status).toBe(400);
		// Closing the enumeration leak on /start and reopening it here would be worse
		// than never closing it: the attacker only needs one of the two doors.
		expect(await onKnown.text()).toBe(await onUnknown.text());
	});

	test("no session is issued when the code is wrong", async () => {
		const email = addr("nosession");
		await issueSignupCode(email);
		const res = await post("/api/auth/signup/verify", { email, code: "ZZZZZZ" });

		expect(res.status).toBe(400);
		expect(res.headers.get("Set-Cookie") ?? "").not.toContain("session=");
		const rows = await db.select().from(users).where(eq(users.email, email));
		expect(rows).toHaveLength(0);
	});
});

describe("POST /auth/onboarding/claim", () => {
	/** Walk the ceremony to a signed-in, nameless account and return its cookie. */
	async function pendingAccount(tag: string): Promise<{ cookie: string; email: string }> {
		const email = addr(tag);
		const issued = await issueSignupCode(email);
		const res = await post("/api/auth/signup/verify", { email, code: issued.code });
		const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0];
		return { cookie, email };
	}

	test("claims the handle and leaves the password unset when none is given", async () => {
		const { cookie, email } = await pendingAccount("claim");
		const username = `${RUN}claim`.slice(0, 30);

		const res = await post(
			"/api/auth/onboarding/claim",
			{ username, acceptTerms: true },
			{ Cookie: cookie },
		);
		expect(res.status).toBe(200);

		const [row] = await db.select().from(users).where(eq(users.email, email));
		expect(row.username).toBe(username);
		// The option has to actually be an option: an account that chose no password is
		// a supported end state, not an unfinished one.
		expect(row.passwordHash).toBeNull();
	});

	test("sets a password when one is given, and it signs in", async () => {
		const { cookie, email } = await pendingAccount("claimpw");
		const username = `${RUN}pw`.slice(0, 30);

		await post(
			"/api/auth/onboarding/claim",
			{ username, password: "correct horse battery", acceptTerms: true },
			{ Cookie: cookie },
		);

		const signIn = await post("/api/auth/sign-in", {
			login: username,
			password: "correct horse battery",
		});
		expect(signIn.status).toBe(200);
	});

	test("a taken handle is refused and nothing is written", async () => {
		const { cookie: firstCookie } = await pendingAccount("dup1");
		const { cookie: secondCookie, email: secondEmail } = await pendingAccount("dup2");
		const username = `${RUN}dup`.slice(0, 30);

		await post(
			"/api/auth/onboarding/claim",
			{ username, acceptTerms: true },
			{ Cookie: firstCookie },
		);
		const res = await post(
			"/api/auth/onboarding/claim",
			{ username, acceptTerms: true },
			{ Cookie: secondCookie },
		);

		expect(res.status).toBe(409);
		const [row] = await db.select().from(users).where(eq(users.email, secondEmail));
		expect(row.username).toBeNull();
	});

	test("claiming twice is refused — a handle is not renamed through this door", async () => {
		const { cookie } = await pendingAccount("twice");
		const first = `${RUN}t1`.slice(0, 30);
		const second = `${RUN}t2`.slice(0, 30);

		await post(
			"/api/auth/onboarding/claim",
			{ username: first, acceptTerms: true },
			{ Cookie: cookie },
		);
		const res = await post(
			"/api/auth/onboarding/claim",
			{ username: second, acceptTerms: true },
			{ Cookie: cookie },
		);

		// Renaming has consequences this endpoint should not quietly acquire: other
		// people hold the old URL, and the vacated name becomes impersonatable.
		expect(res.status).toBe(409);
	});

	test("a reserved handle is refused", async () => {
		const { cookie } = await pendingAccount("reserved");
		const res = await post(
			"/api/auth/onboarding/claim",
			{ username: "settings", acceptTerms: true },
			{ Cookie: cookie },
		);
		// A name the router already answers to would sign up fine and strand the profile
		// at an unreachable URL.
		expect(res.status).toBe(400);
	});

	test("requires a signed-in account", async () => {
		const res = await post("/api/auth/onboarding/claim", {
			username: `${RUN}anon`.slice(0, 30),
			acceptTerms: true,
		});
		expect(res.status).toBe(401);
	});

	/**
	 * 🚨 The 13+ floor is the one thing Anthers asserts about age, and **an unaccepted
	 * assertion is not one** — the phrase lived in a document no user had ever seen,
	 * which made it closer to a wish than a term.
	 *
	 * The ceremony moves where this has to be asked. `/subscribe` collects an address and
	 * nothing else, and `/signup/verify` creates the account the moment the code checks
	 * out — so **onboarding is the only place left**, and if it does not ask, nobody ever
	 * agreed to anything.
	 */
	test("refuses to claim a handle without the terms actually being accepted", async () => {
		const { cookie, email } = await pendingAccount("terms");
		const username = `${RUN}terms`.slice(0, 30);

		const missing = await post("/api/auth/onboarding/claim", { username }, { Cookie: cookie });
		expect(missing.status).toBe(400);

		// `false` is not a value to accept and quietly record — it is a request that
		// cannot be granted, which is why the schema is a literal rather than a boolean.
		const refused = await post(
			"/api/auth/onboarding/claim",
			{ username, acceptTerms: false },
			{ Cookie: cookie },
		);
		expect(refused.status).toBe(400);

		// And neither attempt wrote anything.
		const [row] = await db.select().from(users).where(eq(users.email, email));
		expect(row.username).toBeNull();
	});
});

describe("a pending account has no public existence", () => {
	test("it is absent from the creator listing even when flagged a creator", async () => {
		const email = addr("ghost");
		const issued = await issueSignupCode(email);
		await post("/api/auth/signup/verify", { email, code: issued.code });

		// Force the one state that could leak: a creator with no handle. Nothing in the
		// app can reach this, which is exactly why it is worth asserting — the listing
		// must not depend on onboarding having run.
		await db.update(users).set({ isCreator: true }).where(eq(users.email, email));

		const res = await app.request("/api/accounts/creators");
		const body = (await res.json()) as { creators: { id: number; username: string }[] };

		const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
		expect(body.creators.some((c) => c.id === row.id)).toBe(false);
		// And nothing in the payload carries a null handle, which is the shape the
		// browser's `PublicUser.username: string` promises.
		expect(body.creators.every((c) => typeof c.username === "string")).toBe(true);
	});
});
