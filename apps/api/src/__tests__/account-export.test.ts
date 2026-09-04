// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account export — and mostly, what may never be in one.
 *
 * The completeness half is easy to write and easy to see working. The half that
 * matters is the exclusions, because an export is a **credential-shaped hazard by
 * construction**: it is the single document containing everything about a person, and
 * it leaves our control the instant it is generated — emailed to themselves, dropped
 * in cloud storage, attached to a support ticket. A password hash or a live session
 * token in that file is worth more to an attacker than the database row it came from,
 * because the file has no access control at all once it exists.
 *
 * So the secret-exclusion tests assert against the **raw serialized bytes**, not
 * against the object shape. A nested field nobody thought to check still shows up in
 * the string, and "we don't select that column" is the kind of guarantee that survives
 * exactly until someone adds a convenient `select()` with no arguments.
 *
 * The other exclusion is other people's data. A report filed *about* this user is
 * personal data about them and would ordinarily be in scope — but handing it over
 * identifies the reporter, which is what GDPR Art. 15(4) is for and what the
 * moderation model's open question about not exposing reporters points at too.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sessions, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string, body?: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const subjectName = `exp_subject_${id}`;
const otherName = `exp_other_${id}`;

let subject: string;
let other: string;
let subjectId: number;
let otherId: number;
let workId: number;
let postSlug: string;

/** The export, as the raw bytes a user would actually receive. */
async function rawExport(cookie: string): Promise<{ res: Response; text: string }> {
	const res = await req("/api/accounts/me/export", { headers: { Cookie: cookie } });
	return { res, text: await res.text() };
}

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username IN (${subjectName}, ${otherName})`);
	subject = await signUp(subjectName);
	await enablePayouts(subjectName);
	other = await signUp(otherName);
	await enablePayouts(otherName);
	await db.execute(
		sql`UPDATE users SET is_creator = true WHERE username IN (${subjectName}, ${otherName})`,
	);

	const idOf = async (u: string) => {
		const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, u));
		return row.id;
	};
	subjectId = await idOf(subjectName);
	otherId = await idOf(otherName);

	const workRes = await post("/api/content/works", subject, {
		type: "game",
		title: `Export fixture ${id}`,
		// Declared on create so the release below is not refused for a reason this suite
		// is not about — release is gated on a declared content rating.
		maturity: "general",
	});
	expect(workRes.status).toBe(201);
	workId = (await workRes.json()).work.id;

	const release = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: subject },
		body: JSON.stringify({
			visibility: "released",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(release.status).toBe(200);

	const postRes = await post("/api/content/posts", subject, {
		title: `Export post ${id}`,
		workIds: [workId],
		isPublished: true,
	});
	expect(postRes.status).toBe(201);
	postSlug = (await postRes.json()).post.slug;

	// The subject's own words…
	expect(
		(await post(`/api/content/posts/${postSlug}/comments`, subject, { body: `MY-OWN-WORDS-${id}` }))
			.status,
	).toBe(201);
	// …and somebody else's, on the subject's post. Theirs, not the subject's.
	expect(
		(
			await post(`/api/content/posts/${postSlug}/comments`, other, {
				body: `SOMEONE-ELSES-WORDS-${id}`,
			})
		).status,
	).toBe(201);

	// The subject follows, blocks, and reports — all their own actions.
	expect((await post(`/api/accounts/users/${otherName}/follow`, subject)).status).toBe(201);
	expect(
		(
			await post("/api/moderation/reports", subject, {
				subjectType: "user",
				subjectId: otherId,
				reason: "spam",
				details: `A-REPORT-I-FILED-${id}`,
			})
		).status,
	).toBe(201);

	// And somebody reports the SUBJECT — the record that must not appear in their export.
	expect(
		(
			await post("/api/moderation/reports", other, {
				subjectType: "user",
				subjectId: subjectId,
				reason: "harassment",
				details: `A-REPORT-ABOUT-THEM-${id}`,
			})
		).status,
	).toBe(201);
}, DB_SETUP_TIMEOUT);

describe("the export contains no credentials", () => {
	it("carries neither the password hash nor any session token", async () => {
		const { text } = await rawExport(subject);

		const [row] = await db
			.select({ hash: users.passwordHash })
			.from(users)
			.where(eq(users.id, subjectId));
		expect(row.hash).toBeTruthy();
		// Asserted against the raw bytes, not the parsed shape: a field nobody thought
		// to check still appears in the string.
		expect(text).not.toContain(row.hash!);
		expect(text).not.toContain("passwordHash");
		expect(text).not.toContain("password_hash");
		// The argon2id prefix, in case the hash is ever stored or re-encoded differently.
		expect(text).not.toContain("$argon2");

		const sessionRows = await db
			.select({ token: sessions.token })
			.from(sessions)
			.where(eq(sessions.userId, subjectId));
		expect(sessionRows.length).toBeGreaterThan(0);
		for (const s of sessionRows) {
			// The live token in the cookie that fetched this very file.
			expect(text).not.toContain(s.token);
		}
	});

	it("carries no linked-identity tokens", async () => {
		// ATProto access/refresh tokens and the DPoP private key are the other
		// credentials a user's row can reach. None of them are in scope, and the key
		// names are asserted so a future `select()` with no arguments is caught even
		// on an account that has never linked anything.
		const { text } = await rawExport(subject);
		for (const forbidden of [
			"accessToken",
			"refreshToken",
			"dpopPrivatePem",
			"dpop_private_pem",
			"BEGIN PRIVATE KEY",
			"sessionToken",
		]) {
			expect(text).not.toContain(forbidden);
		}
	});

	it("still lists sessions as metadata, so the export is not simply empty", async () => {
		// The counterpart: excluding credentials must not mean excluding the fact that
		// sessions exist, which is information the user is owed and already sees.
		const { text } = await rawExport(subject);
		const data = JSON.parse(text);
		expect(Array.isArray(data.sessions)).toBe(true);
		expect(data.sessions.length).toBeGreaterThan(0);
		expect(data.sessions[0]).toHaveProperty("createdAt");
		expect(data.sessions[0]).not.toHaveProperty("token");
	});
});

/**
 * 🚨 This suite files reports in both directions between its two fixtures, and neither goes
 * with the accounts: `moderation_reports.reporter_id` is `set null` rather than `cascade`,
 * because a moderation record has to outlive the account it concerns. `afterAll` so it runs
 * whether the suite passed or bailed.
 */
afterAll(async () => {
	await purgeFixtureAccounts([subjectName, otherName]);
});

describe("the export contains no one else's data", () => {
	it("omits reports filed ABOUT the user, and includes reports filed BY them", async () => {
		const { text } = await rawExport(subject);

		// Theirs — an action they took, and part of their record.
		expect(text).toContain(`A-REPORT-I-FILED-${id}`);
		// Not theirs to receive: handing it over identifies the reporter.
		expect(text).not.toContain(`A-REPORT-ABOUT-THEM-${id}`);
	});

	it("omits other people's comments on the user's own post", async () => {
		const { text } = await rawExport(subject);
		expect(text).toContain(`MY-OWN-WORDS-${id}`);
		expect(text).not.toContain(`SOMEONE-ELSES-WORDS-${id}`);
	});
});

describe("the export is complete, readable, and handed over safely", () => {
	it("is JSON, and parses", async () => {
		const { res, text } = await rawExport(subject);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("application/json");
		// The charter's open-formats clause: a copy you can only open with the thing
		// you're leaving is not a copy.
		expect(() => JSON.parse(text)).not.toThrow();
	});

	it("is served as a no-store download rather than rendered in a tab", async () => {
		const { res } = await rawExport(subject);
		const disposition = res.headers.get("Content-Disposition") ?? "";
		expect(disposition).toContain("attachment");
		expect(disposition).toContain(subjectName);
		// A shared or proxy cache holding this file is the failure the header prevents.
		expect(res.headers.get("Cache-Control")).toContain("no-store");
	});

	it("includes the user's profile, content, money and viewing history", async () => {
		const data = JSON.parse((await rawExport(subject)).text);

		expect(data.profile.username).toBe(subjectName);
		expect(data.profile.email).toBe(`${subjectName}@example.com`);

		expect(data.content.works.some((w: { id: number }) => w.id === workId)).toBe(true);
		expect(data.content.posts.length).toBeGreaterThan(0);
		expect(data.content.comments.length).toBe(1);

		expect(data.social.following.some((f: { creatorId: number }) => f.creatorId === otherId)).toBe(
			true,
		);

		// Present as sections even when empty, so a reader can tell "nothing here" from
		// "we didn't include this".
		expect(data.money).toHaveProperty("purchases");
		expect(data).toHaveProperty("viewingHistory");
	});

	it("says what it is and when it was taken, and explains its own omissions", async () => {
		const data = JSON.parse((await rawExport(subject)).text);
		expect(data.format).toBe("anthers-account-export");
		expect(data.formatVersion).toBeGreaterThanOrEqual(1);
		expect(new Date(data.generatedAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);

		// The omissions are stated in the file itself rather than only in the policy —
		// someone reading an export shouldn't have to go looking for why their viewing
		// history stops, or conclude we simply lost it.
		const notes = (data.notes as string[]).join(" ").toLowerCase();
		expect(notes).toContain("snapshot");
		expect(notes).toContain("credentials");
		expect(notes).toContain("retention");
	});

	it("requires a session — an export endpoint is the last place to be generous", async () => {
		const res = await req("/api/accounts/me/export");
		expect(res.status).toBe(401);
	});

	it("gives each user their own data and nobody else's", async () => {
		const mine = JSON.parse((await rawExport(subject)).text);
		const theirs = JSON.parse((await rawExport(other)).text);
		expect(mine.profile.username).toBe(subjectName);
		expect(theirs.profile.username).toBe(otherName);
		expect(theirs.profile.email).not.toBe(mine.profile.email);
	});
});
