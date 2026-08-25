// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Floor-level reports reach a human out of band, rather than resting in a queue
 * nobody watches.
 *
 * The property under test is **selection**, not delivery. `sendEmail` is a no-op
 * under the test runner by design (see `services/email.ts`), so a test that
 * asserted "the alert arrived" would be asserting on a stub and would pass against
 * an implementation that never composed a message at all. What is worth pinning is
 * the decision the code makes: *which* reports are owed an alert, that a filed
 * floor report is one of them, and that an ordinary report is not.
 *
 * 🚨 The case this file exists for is `sexual`. Its own hint in the reason taxonomy
 * reads "Explicit sexual material, or any sexual content involving minors", so a
 * person reporting child sexual abuse material will most often pick it rather than
 * `illegal` — the form steers them there. An escalation wired only to `illegal`
 * passes every obvious test and misses the report that matters most, which is why
 * the reason codes are asserted one at a time instead of as a set.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { comments, moderationReports, users } from "@anthers/db/schema";
import { FLOOR_MODERATION_REASONS, isFloorReason } from "@anthers/shared/moderation";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { pendingEscalations } from "../services/moderation.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string, body: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
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
const creatorName = `esc_creator_${id}`;
const reporterNames = ["a", "b", "c", "d"].map((s) => `esc_${s}_${id}`);

let creator: string;
const reporters: string[] = [];
let slug: string;
/** One comment per reporter, so each report is a distinct (reporter, subject) pair. */
const commentIds: number[] = [];

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${reporterNames[0]}, ${reporterNames[1]}, ${reporterNames[2]}, ${reporterNames[3]})`,
	);
	creator = await signUp(creatorName);
	for (const name of reporterNames) reporters.push(await signUp(name));

	const postRes = await post("/api/content/posts", creator, {
		title: `Escalation fixture ${id}`,
		isPublished: true,
	});
	expect(postRes.status).toBe(201);
	slug = (await postRes.json()).post.slug;

	// Four comments by the creator — the reporters report them, so nobody is
	// reporting their own words and each report is its own row.
	for (let i = 0; i < reporterNames.length; i++) {
		const res = await post(`/api/content/posts/${slug}/comments`, creator, {
			body: `escalation fixture comment ${i}`,
		});
		expect(res.status).toBe(201);
		commentIds.push((await res.json()).comment.id);
	}
}, DB_SETUP_TIMEOUT);

async function report(cookie: string, commentId: number, reason: string) {
	const res = await post("/api/moderation/reports", cookie, {
		subjectType: "comment",
		subjectId: commentId,
		reason,
		details: "fixture report",
	});
	expect(res.status).toBe(201);
	return (await res.json()).reportId as number;
}

async function escalatedAt(reportId: number): Promise<Date | null> {
	const [row] = await db
		.select({ escalatedAt: moderationReports.escalatedAt })
		.from(moderationReports)
		.where(eq(moderationReports.id, reportId))
		.limit(1);
	return row?.escalatedAt ?? null;
}

describe("The floor taxonomy", () => {
	it("names the three reasons that must reach a person, and sexual is one of them", () => {
		// Asserted individually rather than as a set: a set comparison written against
		// the implementation would agree with whatever the implementation says, and the
		// entire point of this list is that `sexual` is easy to leave out.
		expect(isFloorReason("illegal")).toBe(true);
		expect(isFloorReason("sexual")).toBe(true);
		expect(isFloorReason("violence")).toBe(true);
		expect(FLOOR_MODERATION_REASONS).toHaveLength(3);
	});

	it("leaves the reasons an operator can answer in their own time off the floor", () => {
		expect(isFloorReason("spam")).toBe(false);
		expect(isFloorReason("harassment")).toBe(false);
		expect(isFloorReason("other")).toBe(false);
	});
});

describe("Filing a floor report", () => {
	it("marks every floor reason as owed an alert, sexual included", async () => {
		const filed: number[] = [];
		const reasons = ["illegal", "sexual", "violence"];
		for (let i = 0; i < reasons.length; i++) {
			filed.push(await report(reporters[i], commentIds[i], reasons[i]));
		}

		// Nothing was delivered — sendEmail is inert under the test runner — so every
		// one of these is still owed an alert, which is exactly what the sweep selects.
		const pending = await pendingEscalations();
		for (const reportId of filed) expect(pending).toContain(reportId);
		for (const reportId of filed) expect(await escalatedAt(reportId)).toBeNull();
	});

	it("does not owe an alert for an ordinary report", async () => {
		const reportId = await report(reporters[3], commentIds[3], "spam");
		const pending = await pendingEscalations();
		expect(pending).not.toContain(reportId);
	});

	it("selects a floor report even after an operator has resolved it", async () => {
		// The hole the floor exists to close: somebody clears it inside the console
		// before anyone outside was told. Status is deliberately not part of the
		// selection, so a resolved report is still owed its alert.
		const [row] = await db
			.select({ id: moderationReports.id })
			.from(moderationReports)
			.where(eq(moderationReports.reason, "sexual"))
			.limit(1);
		expect(row).toBeDefined();
		await db
			.update(moderationReports)
			.set({ status: "dismissed", resolvedAt: new Date() })
			.where(eq(moderationReports.id, row.id));

		expect(await pendingEscalations()).toContain(row.id);
	});

	it("stops selecting a report once somebody has actually been told", async () => {
		const [row] = await db
			.select({ id: moderationReports.id })
			.from(moderationReports)
			.where(eq(moderationReports.reason, "violence"))
			.limit(1);
		expect(row).toBeDefined();
		await db
			.update(moderationReports)
			.set({ escalatedAt: new Date() })
			.where(eq(moderationReports.id, row.id));

		expect(await pendingEscalations()).not.toContain(row.id);
	});
});

describe("Cleanup", () => {
	it("removes the fixture", async () => {
		await db.delete(comments).where(inArray(comments.id, commentIds));
		await db.delete(users).where(inArray(users.username, [creatorName, ...reporterNames]));
		expect(true).toBe(true);
	});
});
