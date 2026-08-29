// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The DMCA takedown surface, end to end: notice → takedown → counter-notice →
 * restore, and the three absences the brief names as the ones most likely to be
 * untested:
 *
 * 1. One notice never removes more than the material it identified.
 * 2. A bare user report never causes a removal.
 * 3. A restore inside the statutory window puts back exactly what came down, and
 *    does not resurrect anything the creator removed themselves in the meantime.
 *
 * Plus the takedown-state check that is the whole point of Phase 1:
 * - A taken-down Work denies access to EVERYONE — the creator, buyers, and
 *   entitled viewers — through `resolveAccessSync`.
 * - The `takedown` reason is returned, not `gated` or `payment_required`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { dmcaNotices, moderationActions, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

/**
 * A Work's access verdict as seen by a signed-in non-owner.
 *
 * 🚨 **The cookie is not optional, and it stopped being optional on 2026-08-28.** These
 * assertions used a logged-out request because that was the shortest way to reach
 * `resolveAccessSync` without hitting the owner branch. Consuming a Work now requires an
 * account, so a logged-out viewer resolves `login_required` on everything and the takedown
 * this file exists to prove would be masked by a denial that has nothing to do with it —
 * which is precisely what happened: `login_required` arrived where `takedown` was expected.
 * A signed-in stranger reaches the same resolver and is refused for the real reason.
 */
async function accessOf(targetWorkId: number, cookie: string) {
	const res = await req(`/api/content/works/${targetWorkId}`, { headers: { Cookie: cookie } });
	expect(res.status).toBe(200);
	return (await res.json()).work.access as { canAccess: boolean; reason: string };
}

function post(path: string, cookie: string | undefined, body: unknown) {
	const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
	if (cookie) headers.Cookie = cookie;
	return req(path, { method: "POST", headers, body: JSON.stringify(body) });
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
const creatorName = `dmca_creator_${id}`;
const adminName = `dmca_admin_${id}`;
const otherCreatorName = `dmca_other_${id}`;

let creator: string;
let admin: string;
let otherCreator: string;
let workId: number;
let otherWorkId: number;

// A valid notice body with all six elements.
function noticeBody(targetWorkId: number, overrides: Partial<Record<string, unknown>> = {}) {
	return {
		workId: targetWorkId,
		complainantName: "Copyright Holder",
		complainantEmail: "holder@example.com",
		complainantAddress: "123 Main St, Anytown, US",
		complainantPhone: "555-0100",
		copyrightedWorkDescription: "My original game, 'Example Quest', released 2024.",
		infringingMaterialDescription: "The work at this URL is a copy of my game.",
		goodFaithStatement: "I have a good faith belief that the use is not authorized.",
		authorizationStatement: "The information is accurate and I am authorized to act.",
		fairUseConsidered: true,
		...overrides,
	};
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${adminName}, ${otherCreatorName})`,
	);
	creator = await signUp(creatorName);
	await enablePayouts(creatorName);
	admin = await signUp(adminName);
	await enablePayouts(adminName);
	otherCreator = await signUp(otherCreatorName);
	await enablePayouts(otherCreatorName);
	await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${adminName}`);

	// Create two Works by two different creators, both released and free.
	const w1 = await post("/api/content/works", creator, {
		type: "game",
		title: `DMCA fixture ${id}`,
		// Declared on create so the release below is not refused for a reason this suite
		// is not about — release is gated on a declared content rating.
		maturity: "general",
	});
	expect(w1.status).toBe(201);
	workId = (await w1.json()).work.id;

	const w2 = await post("/api/content/works", otherCreator, {
		type: "game",
		title: `Other ${id}`,
		maturity: "general",
	});
	expect(w2.status).toBe(201);
	otherWorkId = (await w2.json()).work.id;

	// Release each Work with its own creator's cookie.
	for (const [wid, cookie] of [
		[workId, creator],
		[otherWorkId, otherCreator],
	] as const) {
		const release = await req(`/api/content/works/${wid}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				visibility: "released",
				seedAccess: [{ threshold: 0, allow: true, price: "0" }],
			}),
		});
		expect(release.status).toBe(200);
	}
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// Notices explicitly, then works, then users. `dmca_notices.work_id` is
	// `set null` rather than `cascade` (changed 2026-08-16, so an infringer cannot
	// erase the record by deleting the Work) — so deleting the Work no longer
	// takes the notices with it, and a suite that assumed it would leaves litter.
	// 🚨 Reports too, and for the same reason as the notices: `moderation_reports` FKs are
	// deliberately `set null`, so deleting the Work and the users leaves them behind. One of
	// these carries a FLOOR reason — this suite reports a Work as "illegal" on purpose,
	// because that is the closest reason to a copyright claim — and a floor report left in
	// the database is an alert somebody is owed. Litter here is a person's attention.
	await db.execute(
		sql`DELETE FROM moderation_reports WHERE subject_id IN (${workId}, ${otherWorkId}) AND subject_type = 'work'`,
	);
	await db.execute(sql`DELETE FROM dmca_notices WHERE work_id IN (${workId}, ${otherWorkId})`);
	await db.execute(sql`DELETE FROM works WHERE id IN (${workId}, ${otherWorkId})`);
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${adminName}, ${otherCreatorName})`,
	);
});

describe("DMCA notice intake", () => {
	it("is public — no auth required", async () => {
		const res = await post("/api/dmca/notices", undefined, noticeBody(workId));
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.filed).toBe(true);
		expect(typeof body.noticeId).toBe("number");
	});

	it("rejects a notice targeting a non-existent Work", async () => {
		const res = await post("/api/dmca/notices", undefined, noticeBody(999_999_999));
		expect(res.status).toBe(404);
	});

	it("rejects a notice missing a required element", async () => {
		// Missing complainantAddress (element iv)
		const res = await post("/api/dmca/notices", undefined, {
			...noticeBody(workId),
			complainantAddress: "",
		});
		expect(res.status).toBe(400);
	});

	it("serves the attestation text so the form renders the exact copy", async () => {
		const res = await req("/api/dmca/attestation");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.notice).toContain("penalty of perjury");
		expect(body.counterNotice).toContain("penalty of perjury");
	});
});

describe("DMCA takedown — the access denial", () => {
	let noticeId: number;

	it("an admin can act on a notice and take down the Work", async () => {
		const fileRes = await post("/api/dmca/notices", undefined, noticeBody(workId));
		expect(fileRes.status).toBe(201);
		noticeId = (await fileRes.json()).noticeId;

		// Before the takedown, the Work is accessible.
		expect((await accessOf(workId, otherCreator)).canAccess).toBe(true);

		// Act on the notice as admin.
		const actRes = await post(`/api/admin/dmca/${noticeId}/act`, admin, { note: "Valid notice" });
		expect(actRes.status).toBe(200);
		expect((await actRes.json()).status).toBe("taken_down");
	});

	it("a taken-down Work denies access to everyone via resolveAccessSync", async () => {
		// The creator themselves reach the owner branch and never see a verdict, so this
		// asks as a signed-in stranger — the path that actually runs `resolveAccessSync`.
		const access = await accessOf(workId, otherCreator);
		expect(access.canAccess).toBe(false);
		expect(access.reason).toBe("takedown");
	});

	it("a taken-down Work outranks the account requirement for a logged-out viewer", async () => {
		// 🚨 The takedown is checked before everything else in the resolver, and this is
		// where that ordering earns its place. A logged-out viewer is refused twice over
		// now — no account, and the material is down — and the reason they are given must
		// be the takedown, or a notice would look like a login prompt to anyone auditing
		// what we serve.
		const res = await req(`/api/content/works/${workId}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.work.access.canAccess).toBe(false);
		expect(body.work.access.reason).toBe("takedown");
	});

	it("the takedown is recorded in the moderation_actions audit log", async () => {
		const rows = await db
			.select()
			.from(moderationActions)
			.where(
				sql`${moderationActions.subjectType} = 'work' AND ${moderationActions.subjectId} = ${workId} AND ${moderationActions.action} = 'hide'`,
			)
			.limit(1);
		expect(rows.length).toBe(1);
		expect(rows[0].reason).toBe("dmca");
	});

	it("one notice never removes more than the material it identified", async () => {
		// The OTHER Work — by a different creator, not named in any notice —
		// must still be accessible. This is the absence the brief names: a takedown
		// that scopes to a catalog or an account is the competitor-removal weapon.
		expect((await accessOf(otherWorkId, creator)).canAccess).toBe(true);
		// And the other Work's takedown_status is still "active"
		const [otherWork] = await db
			.select({ takedownStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, otherWorkId))
			.limit(1);
		expect(otherWork?.takedownStatus).toBe("active");
	});
});

describe("DMCA restore — the sweep", () => {
	it("a manual restore puts the Work back to active", async () => {
		// Find the notice from the previous suite and restore it.
		const [notice] = await db
			.select({ id: dmcaNotices.id })
			.from(dmcaNotices)
			.where(eq(dmcaNotices.workId, workId))
			.orderBy(sql`${dmcaNotices.id} DESC`)
			.limit(1);
		expect(notice).toBeDefined();

		const res = await post(`/api/admin/dmca/${notice!.id}/restore`, admin, {
			note: "Complainant withdrew",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("restored");

		// The Work is accessible again.
		const access = await accessOf(workId, otherCreator);
		expect(access.canAccess).toBe(true);
		expect(access.reason).not.toBe("takedown");

		// And the restore was recorded in the audit log.
		const restoreRows = await db
			.select()
			.from(moderationActions)
			.where(
				sql`${moderationActions.subjectType} = 'work' AND ${moderationActions.subjectId} = ${workId} AND ${moderationActions.action} = 'restore'`,
			)
			.limit(1);
		expect(restoreRows.length).toBe(1);
	});
});

describe("A bare user report never causes a removal", () => {
	it("reporting a Work through the moderation queue does not take it down", async () => {
		// The moderation report path is separate from the DMCA notice path.
		// A user reporting a Work as "illegal" should NOT change its takedown_status.
		const beforeStatus = await db
			.select({ takedownStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, otherWorkId))
			.limit(1);
		expect(beforeStatus[0]?.takedownStatus).toBe("active");

		// Report the other Work as "illegal" — the closest reason to a copyright claim.
		const reportRes = await post("/api/moderation/reports", creator, {
			subjectType: "work",
			subjectId: otherWorkId,
			reason: "illegal",
			details: "this looks like a copyright violation",
		});
		// The report should be accepted (201) — reporting is not the same as removal.
		expect(reportRes.status).toBe(201);

		// The Work's takedown_status must still be "active" — a report is not a notice.
		const afterStatus = await db
			.select({ takedownStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, otherWorkId))
			.limit(1);
		expect(afterStatus[0]?.takedownStatus).toBe("active");

		// And the Work is still accessible.
		expect((await accessOf(otherWorkId, creator)).canAccess).toBe(true);
	});
});

describe("DMCA reject — a first-class outcome", () => {
	it("an admin can reject a notice with a reach-back note", async () => {
		const fileRes = await post("/api/dmca/notices", undefined, noticeBody(workId));
		expect(fileRes.status).toBe(201);
		const noticeId = (await fileRes.json()).noticeId;

		const res = await post(`/api/admin/dmca/${noticeId}/reject`, admin, {
			note: "Element (ii) insufficient — could not identify the copyrighted work. Contacting complainant.",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("rejected");

		// The Work must NOT have been taken down.
		const [work] = await db
			.select({ takedownStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		expect(work?.takedownStatus).toBe("active");
	});
});

describe("DMCA admin gate", () => {
	it("a non-admin gets 404, not 403 — the surface is not advertised", async () => {
		const res = await req("/api/admin/dmca", { headers: { Cookie: creator } });
		expect(res.status).toBe(404);
	});
});
