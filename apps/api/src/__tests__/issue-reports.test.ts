// SPDX-License-Identifier: Apache-2.0
/**
 * The defect-report intake: `POST /api/moderation/issue-reports` and the admin queue behind it.
 *
 * 🚨 **The assertion that matters is that a request carrying no session succeeds** — the
 * person who hit the site's worst bug is often mid-signup or signed out by the bug itself,
 * so filing must not depend on a session being valid. The shape is inherited from
 * `abuse-reports.test.ts`, but the properties asserted are this pipeline's own: no mail
 * exists to be owed, so there is no escalation to pin — what matters instead is the
 * boundary between the two intakes and the open→ingested transition, which is the queue's
 * only action.
 *
 * Every fixture row here marks itself as a test in its `summary` or `details`, because the
 * admin console renders a reporter's words verbatim and a plausible-sounding fake bug in a
 * dev queue is indistinguishable from a real one unless the row says so.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { issueReports, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { ingestIssueReport, loadIssueQueue } from "../services/issue-reports.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

/**
 * A report from somebody with no account, with a distinct forwarded address per case.
 *
 * 🚨 **No `Cookie` header, ever.** That absence is the point of the endpoint, so it is a
 * property of the helper rather than of any one case. The IP varies per call because the
 * route caps submissions per caller, and a shared address would make a later case fail
 * for a reason that has nothing to do with what it is testing.
 */
let ipSeq = 0;
function report(body: Record<string, unknown>) {
	ipSeq += 1;
	return req("/api/moderation/issue-reports", {
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
const filerName = `issue_filer_${id}`;
let filerCookie: string;
let filerId: number;
/** The admin account that ingests, which is who an ingested report records. */
let operatorId: number;

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE email = ${`${filerName}@example.com`}`);
	filerCookie = (await createAccount(filerName)).cookie;
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, `${filerName}@example.com`));
	filerId = row.id;
	operatorId = (await createAdminFixture("issue-operator")).id;
}, DB_SETUP_TIMEOUT);

describe("Anyone can file, with no account", () => {
	it("accepts a report from a request carrying no session at all", async () => {
		const res = await report({
			summary: `Test fixture: upload spins (${id})`,
			details: "A fixture report exercising the public intake. No real defect is being described.",
			pageUrl: "https://anthers.org/discover",
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.reported).toBe(true);
		expect(body.issueId).toBeGreaterThan(0);

		const [row] = await db.select().from(issueReports).where(eq(issueReports.id, body.issueId));
		// Nobody was asked who they were, so nobody is recorded.
		expect(row.reporterId).toBeNull();
		expect(row.reporterEmail).toBe("");
		// What they typed is the record — no normalization, no derivation.
		expect(row.pageUrl).toBe("https://anthers.org/discover");
		expect(row.status).toBe("open");
	});

	it("records a signed-in reporter when there happens to be one, without requiring it", async () => {
		const res = await req("/api/moderation/issue-reports", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: filerCookie,
				"cf-connecting-ip": "198.51.100.200",
			},
			body: JSON.stringify({
				summary: `Test fixture: player stalls (${id})`,
				details: "A fixture report filed signed-in, to pin that the session is read if present.",
			}),
		});
		expect(res.status).toBe(201);
		const [row] = await db
			.select({ reporterId: issueReports.reporterId })
			.from(issueReports)
			.where(eq(issueReports.id, (await res.json()).issueId));
		expect(row.reporterId).toBe(filerId);
	});
});

describe("What the form requires", () => {
	it("refuses a summary too thin to triage on", async () => {
		const res = await report({
			summary: "bad",
			details: "A fixture summary that is shorter than the minimum the form asks for.",
		});
		expect(res.status).toBe(400);
	});

	it("refuses details too thin to act on", async () => {
		const res = await report({
			summary: `Test fixture: too thin (${id})`,
			details: "bad",
		});
		expect(res.status).toBe(400);
	});

	it("refuses a malformed email rather than storing a useless reply address", async () => {
		const res = await report({
			summary: `Test fixture: email shape (${id})`,
			details: "A fixture report whose optional email is not an email.",
			reporterEmail: "not-an-email",
		});
		expect(res.status).toBe(400);
	});

	it("accepts an empty location, because naming where is optional", async () => {
		const res = await report({
			summary: `Test fixture: no location (${id})`,
			details: "A fixture report that names no page, which the schema should accept.",
		});
		expect(res.status).toBe(201);
		const [row] = await db
			.select({ pageUrl: issueReports.pageUrl })
			.from(issueReports)
			.where(eq(issueReports.id, (await res.json()).issueId));
		expect(row.pageUrl).toBe("");
	});
});

describe("Too many from one caller", () => {
	// 🚨 This suite asserts the limiter's refusal, so the session knob has to be OFF for
	// it — the same discipline the limiter's own suite applies (see there): taken out for
	// the run and put back at process exit, so the opt-in never makes a refusal test
	// pass vacuously.
	const knob = process.env.RATE_LIMITS_DISABLED;
	delete process.env.RATE_LIMITS_DISABLED;
	process.on("exit", () => {
		process.env.RATE_LIMITS_DISABLED = knob;
	});

	it("declines the sixth in ten minutes, with its own cap that never touches the abuse one", async () => {
		const ip = "203.0.113.77";
		const send = () =>
			req("/api/moderation/issue-reports", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: ORIGIN,
					"cf-connecting-ip": ip,
				},
				body: JSON.stringify({
					summary: `Test fixture: burst (${id})`,
					details: "One of several reports from the same address in quick succession.",
				}),
			});

		for (let i = 0; i < 5; i++) expect((await send()).status).toBe(201);

		const sixth = await send();
		expect(sixth.status).toBe(429);
	});
});

describe("The open to ingested transition", () => {
	it("ingests an open report once, and not twice", async () => {
		const res = await report({
			summary: `Test fixture: ingest once (${id})`,
			details: "A fixture report an operator will read and mark ingested.",
		});
		expect(res.status).toBe(201);
		const issueId = (await res.json()).issueId;

		expect(await ingestIssueReport({ issueId, adminId: operatorId })).toBe(true);
		const [row] = await db.select().from(issueReports).where(eq(issueReports.id, issueId));
		expect(row.status).toBe("ingested");
		expect(row.ingestedBy).toBe(operatorId);
		expect(row.ingestedAt).not.toBeNull();

		// A second ingest would rewrite `ingested_at` and lose when the decision was
		// actually taken — the same refusal `closeAbuseReport` makes.
		expect(await ingestIssueReport({ issueId, adminId: operatorId })).toBe(false);
	});

	it("answers 404 for an ingest of an id that is not open", async () => {
		const res = await report({
			summary: `Test fixture: ingest 404 (${id})`,
			details: "A fixture report that will be ingested through the route, then again.",
		});
		expect(res.status).toBe(201);
		const issueId = (await res.json()).issueId;
		expect(await ingestIssueReport({ issueId, adminId: operatorId })).toBe(true);

		const again = await req("/api/admin/issue-reports/ingest", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ issueId }),
		});
		// 401 rather than 404: the caller is not an operator at all, so what the id
		// names is not their information to learn.
		expect(again.status).toBe(401);
	});

	it("the queue carries open reports and hides ingested ones by default", async () => {
		const res = await report({
			summary: `Test fixture: queue visibility (${id})`,
			details: "A fixture report left open so the queue's default selection shows it.",
		});
		expect(res.status).toBe(201);
		const issueId = (await res.json()).issueId;

		const open = await loadIssueQueue();
		expect(open.find((r) => r.id === issueId)).toBeDefined();

		await ingestIssueReport({ issueId, adminId: operatorId });
		const after = await loadIssueQueue();
		expect(after.find((r) => r.id === issueId)).toBeUndefined();
		const all = await loadIssueQueue({ includeIngested: true });
		expect(all.find((r) => r.id === issueId)?.status).toBe("ingested");
	});
});

afterAll(async () => {
	// The summaries all carry the fixture marker *and* the run id, so this sweep takes
	// back exactly this suite's rows and nothing a human filed.
	await db.execute(sql`DELETE FROM issue_reports WHERE summary LIKE ${`%(${id})%`}`);
	await db.execute(sql`DELETE FROM users WHERE email = ${`${filerName}@example.com`}`);
});
