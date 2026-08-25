// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The illegal-content reporting route that does not ask who you are.
 *
 * 🚨 **The assertion that matters is that a request carrying no session succeeds.** Until
 * this endpoint existed, `POST /api/moderation/reports` sat behind `requireAuth` and a
 * signed-out person had no way to report illegal content on Anthers at all — DSA Art. 16
 * requires a mechanism open to *anyone* rather than to members. So the case here is
 * deliberately shaped around the absence of a cookie rather than around the happy path:
 * every request below that should work sends no `Cookie` header, and the suite would pass
 * identically against a broken implementation if it did.
 *
 * The second property is **durability**, and it is asserted the way `report-escalation`
 * asserts it: on the *selection* rather than on delivery. `sendEmail` is inert under the
 * test runner by design, so "the alert arrived" would be an assertion about a stub. What
 * is worth pinning is which reports are owed an alert and that `escalated_at` is what
 * closes one out — because that stamp is the only thing standing between "a queue nobody
 * watches" and "an email nobody sent".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { abuseReports, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import {
	pendingAbuseEscalations,
	redactClosedAbuseReports,
	resolveReportedWork,
} from "../services/abuse-reports.js";
import { placeHold } from "../services/legal-hold.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

/**
 * A report from somebody with no account, with a distinct forwarded address per case.
 *
 * 🚨 **No `Cookie` header, ever.** That absence is the whole point of the endpoint, so it
 * is a property of the helper rather than of any one case — a test that quietly passed a
 * session would assert nothing this file exists to assert. The IP varies per call because
 * the route caps submissions per caller, and a shared address would make the fifth case
 * fail for a reason that has nothing to do with what it is testing.
 */
let ipSeq = 0;
function report(body: Record<string, unknown>) {
	ipSeq += 1;
	return req("/api/moderation/abuse-reports", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: ORIGIN,
			"cf-connecting-ip": `198.51.100.${ipSeq}`,
		},
		body: JSON.stringify(body),
	});
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `abuse_creator_${id}`;
let creatorId: number;
let workPublicId: number;
let workId: number;

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

let creatorCookie: string;

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username = ${creatorName}`);
	creatorCookie = await signUp(creatorName);
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, creatorName));
	creatorId = row.id;

	const work = await insertWork({ creatorId, type: "video", title: `Abuse fixture ${id}` });
	workId = work.id;
	workPublicId = work.publicId;
}, DB_SETUP_TIMEOUT);

describe("Anyone can file, with no account", () => {
	it("accepts a report from a request carrying no session at all", async () => {
		const res = await report({
			url: `https://anthers.org/works/whatever-${workPublicId}`,
			reason: "illegal",
			details: "There is material on this page that appears to break the law.",
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.reported).toBe(true);
		expect(body.reportId).toBeGreaterThan(0);

		const [row] = await db.select().from(abuseReports).where(eq(abuseReports.id, body.reportId));
		// Nobody was asked who they were, so nobody is recorded.
		expect(row.reporterId).toBeNull();
		expect(row.reporterEmail).toBe("");
		// ...and the report is still owed an alert, because nothing was delivered.
		expect(await pendingAbuseEscalations()).toContain(body.reportId);
	});

	it("still refuses the authenticated route to the same signed-out caller", async () => {
		// The contrast is the point: this is the endpoint that had no public door, and if
		// it ever grows one, the case above stops proving anything about Art. 16.
		const res = await req("/api/moderation/reports", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ subjectType: "comment", subjectId: 1, reason: "illegal" }),
		});
		expect(res.status).toBe(401);
	});

	it("records a signed-in reporter when there happens to be one, without requiring it", async () => {
		const res = await req("/api/moderation/abuse-reports", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: creatorCookie,
				"cf-connecting-ip": "198.51.100.200",
			},
			body: JSON.stringify({
				url: "https://anthers.org/posts/something",
				reason: "violence",
				details: "A credible threat against a named person.",
			}),
		});
		expect(res.status).toBe(201);
		const [row] = await db
			.select({ reporterId: abuseReports.reporterId })
			.from(abuseReports)
			.where(eq(abuseReports.id, (await res.json()).reportId));
		expect(row.reporterId).toBe(creatorId);
	});
});

describe("What the form requires", () => {
	it("refuses a report with nothing to look at", async () => {
		const res = await report({ url: "", reason: "illegal", details: "Something is wrong here." });
		expect(res.status).toBe(400);
	});

	it("refuses an explanation too thin to act on", async () => {
		// DSA Art. 16 asks for a "sufficiently substantiated explanation", and an operator
		// with a URL and the word "bad" has nowhere to start.
		const res = await report({
			url: "https://anthers.org/works/x-123456",
			reason: "illegal",
			details: "bad",
		});
		expect(res.status).toBe(400);
	});

	it("refuses a reason it does not recognise", async () => {
		const res = await report({
			url: "https://anthers.org/works/x-123456",
			reason: "not-a-reason",
			details: "This should never be filed under an invented reason code.",
		});
		expect(res.status).toBe(400);
	});
});

describe("Reading the reported location", () => {
	it("resolves a Work URL by its durable public id, not its slug", async () => {
		// The slug changes on a rename and the publicId does not, which is the whole reason
		// the two-part address exists. Matching on the slug would break every report filed
		// against a Work its creator later retitled.
		expect(await resolveReportedWork(`https://anthers.org/works/anything-${workPublicId}`)).toBe(
			workId,
		);
		expect(
			await resolveReportedWork(`https://anthers.org/works/a-different-slug-${workPublicId}`),
		).toBe(workId);
	});

	it("files the report anyway when the link resolves to nothing", async () => {
		// 🚨 Failing to resolve must never reject the report. The link may name a post, a
		// profile, something already gone, or a site that is not ours — and the person least
		// able to work out why a form rejected them is exactly the person this route is for.
		const res = await report({
			url: "https://example.com/somewhere/else",
			reason: "sexual",
			details: "Reported from an address that is not on Anthers at all.",
		});
		expect(res.status).toBe(201);

		const [row] = await db
			.select()
			.from(abuseReports)
			.where(eq(abuseReports.id, (await res.json()).reportId));
		expect(row.workId).toBeNull();
		// The URL as typed is the record, whatever we made of it.
		expect(row.url).toBe("https://example.com/somewhere/else");
	});
});

describe("Which reports are owed an alert", () => {
	it("owes one for every floor reason, sexual included", async () => {
		const filed: number[] = [];
		for (const reason of ["illegal", "sexual", "violence"]) {
			const res = await report({
				url: `https://anthers.org/works/x-${workPublicId}`,
				reason,
				details: `A public report filed under ${reason} for the escalation test.`,
			});
			expect(res.status).toBe(201);
			filed.push((await res.json()).reportId);
		}

		const pending = await pendingAbuseEscalations();
		for (const reportId of filed) expect(pending).toContain(reportId);
	});

	it("owes nothing for a reason an operator can answer in their own time", async () => {
		const res = await report({
			url: `https://anthers.org/works/x-${workPublicId}`,
			reason: "spam",
			details: "This is unsolicited advertising and nothing more urgent than that.",
		});
		// 🚨 The status is asserted before the id is read, and that is not ceremony. A
		// `not.toContain` against an `undefined` id passes against every possible bug —
		// including the endpoint 401-ing — so without this line the case is inert.
		expect(res.status).toBe(201);
		const reportId = (await res.json()).reportId;
		expect(reportId).toBeGreaterThan(0);
		expect(await pendingAbuseEscalations()).not.toContain(reportId);
	});

	it("stops owing one once somebody has actually been told", async () => {
		const res = await report({
			url: `https://anthers.org/works/x-${workPublicId}`,
			reason: "illegal",
			details: "A report that will be marked as delivered by hand.",
		});
		expect(res.status).toBe(201);
		const reportId = (await res.json()).reportId;
		// It has to be owed one first, or "no longer owed" is indistinguishable from
		// "never selected" — which is what a broken floor list would look like.
		expect(await pendingAbuseEscalations()).toContain(reportId);

		await db
			.update(abuseReports)
			.set({ escalatedAt: new Date() })
			.where(eq(abuseReports.id, reportId));

		expect(await pendingAbuseEscalations()).not.toContain(reportId);
	});
});

describe("Too many from one caller", () => {
	it("declines the sixth in ten minutes, and says where to go instead", async () => {
		const ip = "203.0.113.77";
		const send = () =>
			req("/api/moderation/abuse-reports", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: ORIGIN,
					"cf-connecting-ip": ip,
				},
				body: JSON.stringify({
					url: "https://anthers.org/works/x-123456",
					reason: "spam",
					details: "One of several reports from the same address in quick succession.",
				}),
			});

		for (let i = 0; i < 5; i++) expect((await send()).status).toBe(201);

		const sixth = await send();
		expect(sixth.status).toBe(429);
		// The message has to hand them another route rather than just refusing — this
		// endpoint's whole reason for existing is that somebody has something to report.
		expect((await sixth.json()).error).toContain("abuse@anthers.org");
	});
});

describe("Retention", () => {
	it("drops the reporter's words and address on a settled report, and a hold stops it", async () => {
		const settled = new Date("2020-01-01T00:00:00.000Z");
		const [free] = await db
			.insert(abuseReports)
			.values({
				url: "https://anthers.org/works/old-1",
				reason: "illegal",
				details: "the reporter's own words",
				reporterEmail: "someone@example.com",
				status: "dismissed",
				resolvedAt: settled,
				createdAt: settled,
				escalatedAt: new Date(),
			})
			.returning({ id: abuseReports.id });
		const [held] = await db
			.insert(abuseReports)
			.values({
				url: "https://anthers.org/works/old-2",
				reason: "illegal",
				details: "the reporter's own words",
				reporterEmail: "someone@example.com",
				status: "dismissed",
				resolvedAt: settled,
				createdAt: settled,
				escalatedAt: new Date(),
			})
			.returning({ id: abuseReports.id });
		await placeHold({
			subjectType: "abuse_report",
			subjectId: held.id,
			reason: "abuse retention fixture",
		});

		// A cutoff after both rows, so the sweep genuinely reaches them.
		await redactClosedAbuseReports(new Date("2021-01-01T00:00:00.000Z"));

		const [freeRow] = await db.select().from(abuseReports).where(eq(abuseReports.id, free.id));
		expect(freeRow.details).toBe("");
		expect(freeRow.reporterEmail).toBe("");
		expect(freeRow.redactedAt).not.toBeNull();

		// 🚨 A redaction is a destruction even though nothing here says DELETE, so a held
		// report keeps both until the hold lifts.
		const [heldRow] = await db.select().from(abuseReports).where(eq(abuseReports.id, held.id));
		expect(heldRow.details).toBe("the reporter's own words");
		expect(heldRow.reporterEmail).toBe("someone@example.com");
		expect(heldRow.redactedAt).toBeNull();
	});
});

afterAll(async () => {
	await db.execute(sql`DELETE FROM abuse_reports WHERE url LIKE 'https://anthers.org/works/%'`);
	await db.execute(sql`DELETE FROM abuse_reports WHERE url = 'https://example.com/somewhere/else'`);
	await db.execute(
		sql`DELETE FROM abuse_reports WHERE url = 'https://anthers.org/posts/something'`,
	);
	await db.execute(sql`DELETE FROM legal_holds WHERE reason = 'abuse retention fixture'`);
	await db.execute(sql`DELETE FROM users WHERE username = ${creatorName}`);
});
