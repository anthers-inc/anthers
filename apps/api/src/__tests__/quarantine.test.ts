// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Quarantine — material taken out of reach of **everybody**, and the one assertion that
 * decides whether this feature works at all.
 *
 * 🚨 **The case that matters is the purchaser.** Every other denial on this platform has a
 * buyer-shaped hole in it on purpose: `resolveAccess` reads `purchases` and never
 * `visibility`, so withdrawing a Work deliberately keeps serving the people who paid for
 * it — *"if a user purchases something, they own it, regardless of what the creator does
 * down the line."* That is correct for an ordinary takedown and wrong for this, and it is
 * the one place the existing content model does not simply extend. A test that only
 * checked a stranger is refused would pass against a plain visibility flip, which is
 * exactly the implementation that leaves the material reachable by whoever bought it.
 *
 * So the shape of each case here is: **prove the buyer gets it, then quarantine, then
 * prove the same buyer does not.** Without the first step a passing test proves only that
 * the fixture was broken.
 *
 * The second thing asserted is that the denial holds in **two independent places**. The
 * resolver refuses the Work, which every delivery route inherits; the storage layer
 * refuses the key, which catches a route that signs without resolving. Either alone reads
 * as sufficient and neither is, so both are exercised — the storage half by asking for a
 * URL directly, which is what a forgotten route would do.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	assets,
	mediaQuarantine,
	moderationActions,
	moderationReports,
	purchases,
	users,
	works,
} from "@anthers/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import app from "../index";
import { isUnderHold } from "../services/legal-hold.js";
import { clearQuarantine, loadQuarantineFindings, quarantineWork } from "../services/quarantine.js";
import { QUARANTINE_PREFIX } from "../services/storage/acl.js";
import { storage } from "../services/storage/index.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
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

async function idOf(username: string): Promise<number> {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return row.id;
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `quar_creator_${id}`;
const buyerName = `quar_buyer_${id}`;

let creatorCookie: string;
let buyerCookie: string;
let creatorId: number;
let buyerId: number;

/** Locked and priced: the only way in is a purchase, which is the viewer under test. */
const SOLD = { seedAccess: [{ threshold: 0, allow: true, price: "5.00" }] };

/**
 * A downloadable Work with one real asset object on disk, plus a completed purchase.
 *
 * The bytes are actually written rather than stubbed, because half of what is being
 * asserted is that the object **moved** — a fixture with no object would let a quarantine
 * that silently moves nothing pass every assertion below.
 */
async function seedSoldWork(title: string) {
	const work = await insertWork({
		creatorId,
		type: "software",
		title,
		streamEnabled: false,
		downloadEnabled: true,
		...SOLD,
	});

	const key = `creators/${creatorId}/assets/${work.publicId}-build.zip`;
	await storage.upload(key, Buffer.from("pretend build bytes"), "application/zip");
	const [asset] = await db
		.insert(assets)
		.values({ workId: work.id, file: key, filename: "build.zip", fileSize: 19 })
		.returning();

	await db.insert(purchases).values({
		buyerId,
		workId: work.id,
		creatorId,
		workTitle: title,
		workType: "software",
		workPublicId: work.publicId,
		type: "digital",
		amount: "5.00",
		processingFee: "0.45",
		deliveryFee: "0.00",
		crfFee: "0.00",
		salesTax: "0.00",
		creatorEarnings: "4.55",
		stripePaymentIntentId: `pi_quar_${crypto.randomUUID().slice(0, 12)}`,
		status: "completed",
	});

	return { work, asset, key };
}

/** The buyer's own download call — the exact request a purchaser makes for the bytes. */
function download(workId: number, assetId: number, cookie: string) {
	return req(`/api/content/works/${workId}/assets/${assetId}/download`, {
		method: "POST",
		headers: { Origin: ORIGIN, Cookie: cookie },
	});
}

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName})`);
	creatorCookie = await signUp(creatorName);
	buyerCookie = await signUp(buyerName);
	creatorId = await idOf(creatorName);
	buyerId = await idOf(buyerName);
	await db.execute(sql`UPDATE users SET is_creator = true WHERE id = ${creatorId}`);
}, DB_SETUP_TIMEOUT);

describe("A purchaser is refused", () => {
	it("hands the buyer their file before the quarantine, and refuses it after", async () => {
		const { work, asset } = await seedSoldWork("Bought and quarantined");

		// 🚨 Step one, and the test is worthless without it. A purchase is the access this
		// platform is most careful to preserve, so if the buyer is already being refused,
		// everything below passes for the wrong reason.
		const before = await download(work.id, asset.id, buyerCookie);
		expect(before.status).toBe(200);
		expect((await before.json()).url).toBeTruthy();

		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});

		const after = await download(work.id, asset.id, buyerCookie);
		expect(after.status).toBe(403);
		// The reason names the state rather than inheriting "gated", so a client cannot
		// render an unlock prompt for something no amount of money opens.
		expect((await after.json()).access.reason).toBe("quarantined");
	});

	it("refuses the creator's own Work too, which no other denial does", async () => {
		const { work, asset } = await seedSoldWork("Creator locked out");

		const before = await download(work.id, asset.id, creatorCookie);
		expect(before.status).toBe(200);

		await quarantineWork({
			workId: work.id,
			source: "scan",
			classification: "csam",
			actorId: null,
		});

		const after = await download(work.id, asset.id, creatorCookie);
		expect(after.status).toBe(403);
		expect((await after.json()).access.reason).toBe("quarantined");
	});
});

describe("The object itself", () => {
	it("moves to the quarantine prefix rather than being deleted", async () => {
		const { work, key } = await seedSoldWork("Moved not deleted");
		expect(await storage.exists(key)).toBe(true);

		const result = await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});
		expect(result.objectsMoved).toBeGreaterThan(0);

		// Gone from where it was...
		expect(await storage.exists(key)).toBe(false);
		// ...and still in existence, which § 2258A(h) requires and the platform's own
		// "removal is a state, never a delete" rule requires independently.
		expect(await storage.exists(`${QUARANTINE_PREFIX}${key}`)).toBe(true);
	});

	it("cannot be signed for, even by a caller that never resolved the Work", async () => {
		const { work, key } = await seedSoldWork("Unsignable");
		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});

		// This is the storage-layer half of the denial, exercised the way a forgotten
		// delivery route would reach it: a bare key, straight to the signer.
		await expect(storage.getUrl(`${QUARANTINE_PREFIX}${key}`, { signed: true })).rejects.toThrow(
			/quarantined/i,
		);
	});

	it("is not served by the local static middleware either", async () => {
		const { work, key } = await seedSoldWork("Not static-served");
		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});

		// In local mode `/content` serves CONTENT_ROOT unsigned, so the directory is a
		// second door and the prefix has to be refused there too. In S3 mode this route
		// is a no-op and the assertion holds trivially, which is correct in both.
		const res = await req(`/content/${QUARANTINE_PREFIX}${key}`);
		expect(res.status).toBe(404);
	});
});

describe("Our determination and the vendor's are kept apart", () => {
	/**
	 * 🚨 Two different obligations pull these columns apart, and collapsing them breaks
	 * both. `classification` is the Corporation's own conclusion — permanent, because it
	 * answers an appeal years later and is what a CyberTipline report states. `vendorMatch`
	 * is a detection service's answer, which its own terms may require us to time-limit and
	 * which Shield's terms forbid us feeding to generative AI. 60.13 § 7.6.
	 */
	it("stores the vendor's answer without letting it become our determination", async () => {
		const { work } = await seedSoldWork("Vendor match kept apart");
		await quarantineWork({
			workId: work.id,
			source: "scan",
			classification: "confirmed by operator review",
			vendorMatch: {
				vendor: "arachnid-shield",
				classification: "harmful-abusive-material",
				matchType: "near",
				receivedAt: new Date("2026-08-26T03:00:00.000Z").toISOString(),
			},
			actorId: creatorId,
		});

		const [row] = await db
			.select()
			.from(mediaQuarantine)
			.where(and(eq(mediaQuarantine.workId, work.id), isNull(mediaQuarantine.clearedAt)))
			.limit(1);

		// Ours is ours, and the vendor's word is nowhere in it.
		expect(row.classification).toBe("confirmed by operator review");
		expect(row.classification).not.toContain("harmful-abusive-material");
		expect(row.classification).not.toBe(row.vendorMatch?.classification);
		// Theirs is recorded, whole, including the match type — because whether reasonable
		// reliance extends to a *perceptual* match is open, and after the fact an exact and
		// a near match would otherwise be indistinguishable.
		expect(row.vendorMatch?.vendor).toBe("arachnid-shield");
		expect(row.vendorMatch?.classification).toBe("harmful-abusive-material");
		expect(row.vendorMatch?.matchType).toBe("near");
	});

	it("keeps the vendor's answer out of the operator queue", async () => {
		// 🚨 The queue is the surface most likely to be screenshotted or pasted at an agent,
		// and Shield's § 6(c) forbids Match Data as input to generative AI. Reading the
		// vendor's answer has to be a deliberate second step, not something every listing
		// hands over.
		const findings = await loadQuarantineFindings({ includeCleared: true });
		expect(findings.length).toBeGreaterThan(0);
		for (const f of findings) {
			expect(Object.keys(f)).not.toContain("vendorMatch");
			expect(JSON.stringify(f)).not.toContain("arachnid-shield");
		}
	});

	it("keeps the vendor's answer out of the append-only moderation log", async () => {
		// `moderation_actions` is permanent and agent-read. A vendor's classification copied
		// into a note would defeat both the retention limit and the AI prohibition at once.
		const { work } = await seedSoldWork("Log stays clean");
		await quarantineWork({
			workId: work.id,
			source: "scan",
			classification: "operator confirmed",
			vendorMatch: {
				vendor: "arachnid-shield",
				classification: "csam",
				matchType: "exact",
				receivedAt: new Date().toISOString(),
			},
			actorId: creatorId,
		});
		const actions = await db
			.select({ note: moderationActions.note, reason: moderationActions.reason })
			.from(moderationActions)
			.where(
				and(eq(moderationActions.subjectType, "work"), eq(moderationActions.subjectId, work.id)),
			);
		expect(actions.length).toBeGreaterThan(0);
		for (const a of actions) {
			expect(a.note).not.toContain("arachnid-shield");
			// 🚨 The vendor's CLASSIFICATION, not just its name — that is the value a naive
			// implementation copies, and checking only for the vendor name watched the wrong
			// marker entirely. Our determination is "operator confirmed"; theirs is "csam",
			// so finding "csam" here means the two collapsed.
			expect(a.note).not.toContain("csam");
			expect(a.note).toContain("operator confirmed");
		}
	});
});

describe("The record and the hold", () => {
	it("writes the finding, delists the Work, and holds all three subjects", async () => {
		const [report] = await db
			.insert(moderationReports)
			.values({
				subjectType: "work",
				subjectId: 0,
				reporterId: buyerId,
				reason: "spam",
				details: "fixture report",
				escalatedAt: new Date(),
			})
			.returning({ id: moderationReports.id });

		const { work } = await seedSoldWork("Recorded");
		await db
			.update(moderationReports)
			.set({ subjectId: work.id })
			.where(eq(moderationReports.id, report.id));

		await quarantineWork({
			workId: work.id,
			source: "report",
			classification: "sexual",
			actorId: creatorId,
			reportId: report.id,
			note: "fixture",
		});

		const [row] = await db
			.select()
			.from(mediaQuarantine)
			.where(and(eq(mediaQuarantine.workId, work.id), isNull(mediaQuarantine.clearedAt)))
			.limit(1);
		expect(row).toBeDefined();
		expect(row.source).toBe("report");
		expect(row.uploaderId).toBe(creatorId);
		expect(row.reportId).toBe(report.id);
		// What the creator had chosen, kept so a cleared finding can restore it.
		expect(row.priorVisibility).toBe("released");
		// 🚨 A record, never a rendering. There is no column here that could hold one, and
		// asserting it against the catalog rather than against what the service returns is
		// the difference between "we don't select it" and "it isn't there to select".
		const columns = (
			(await db.execute(sql`
				SELECT column_name FROM information_schema.columns WHERE table_name = 'media_quarantine'
			`)) as unknown as { column_name: string }[]
		).map((r) => r.column_name);
		expect(columns.filter((c) => /thumb|preview|image|render|body/.test(c))).toEqual([]);

		// The Work left `released`.
		const [after] = await db
			.select({ visibility: works.visibility, quarantineStatus: works.quarantineStatus })
			.from(works)
			.where(eq(works.id, work.id));
		expect(after.quarantineStatus).toBe("quarantined");
		expect(after.visibility).not.toBe("released");

		// Everything quarantined is under a preservation hold — the Work, the uploader and
		// the report. Quarantining without one moves material somewhere a sweep can still
		// reach, and nothing watches the quarantine prefix.
		expect(await isUnderHold("work", work.id)).toBe(true);
		expect(await isUnderHold("user", creatorId)).toBe(true);
		expect(await isUnderHold("report", report.id)).toBe(true);
	});

	it("resolves the open report, so the queue stops re-serving finished work", async () => {
		const { work } = await seedSoldWork("Report resolved");
		const [report] = await db
			.insert(moderationReports)
			.values({
				subjectType: "work",
				subjectId: work.id,
				reporterId: buyerId,
				reason: "spam",
				details: "fixture report 2",
				escalatedAt: new Date(),
			})
			.returning({ id: moderationReports.id });

		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});

		const [row] = await db
			.select({ status: moderationReports.status })
			.from(moderationReports)
			.where(eq(moderationReports.id, report.id));
		expect(row.status).toBe("resolved");
	});
});

describe("The creator cannot reach around it", () => {
	it("refuses to re-release, rename or re-gate a quarantined Work", async () => {
		const { work } = await seedSoldWork("No way back");
		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});

		const res = await req(`/api/content/works/${work.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ visibility: "released" }),
		});
		expect(res.status).toBe(404);

		const [after] = await db
			.select({ visibility: works.visibility })
			.from(works)
			.where(eq(works.id, work.id));
		expect(after.visibility).not.toBe("released");
	});

	it("refuses to delete it, because deleting purges the objects under hold", async () => {
		const { work, key } = await seedSoldWork("Undeletable");
		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});

		const res = await req(`/api/content/works/${work.id}?force=true`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(404);

		// The row survives, and so do the bytes — which is the assertion that matters,
		// since the delete path's whole job is to call `purgeWorkMedia`.
		const [row] = await db.select({ id: works.id }).from(works).where(eq(works.id, work.id));
		expect(row).toBeDefined();
		expect(await storage.exists(`${QUARANTINE_PREFIX}${key}`)).toBe(true);
	});
});

describe("Clearing a finding", () => {
	it("puts the object back and restores the visibility the creator chose", async () => {
		const { work, asset, key } = await seedSoldWork("Wrongly flagged");
		await quarantineWork({
			workId: work.id,
			source: "scan",
			classification: "no-known-match",
			actorId: creatorId,
		});
		expect(await storage.exists(key)).toBe(false);

		const result = await clearQuarantine({ workId: work.id, actorId: creatorId, note: "mistake" });
		expect(result.objectsRestored).toBeGreaterThan(0);
		expect(result.visibility).toBe("released");
		expect(await storage.exists(key)).toBe(true);

		// And the buyer has their file back.
		const after = await download(work.id, asset.id, buyerCookie);
		expect(after.status).toBe(200);
	});

	it("leaves the preservation hold standing, because that is a different decision", async () => {
		const { work } = await seedSoldWork("Cleared but held");
		await quarantineWork({
			workId: work.id,
			source: "operator",
			classification: "csam",
			actorId: creatorId,
		});
		await clearQuarantine({ workId: work.id, actorId: creatorId });

		// 🚨 Clearing says "the finding was wrong". Lifting a hold says "the obligation to
		// preserve has ended". Coupling them would make the first silently do the second,
		// and the record of having checked is what would be destroyed.
		expect(await isUnderHold("work", work.id)).toBe(true);
	});
});

afterAll(async () => {
	// Objects first: the rows below are what name them, so dropping the rows first would
	// strand every quarantined file in the dev content directory.
	const rows = await db
		.select({ quarantineKey: mediaQuarantine.quarantineKey })
		.from(mediaQuarantine)
		.innerJoin(works, eq(mediaQuarantine.workId, works.id))
		.where(eq(works.creatorId, creatorId));
	for (const r of rows) await storage.delete(r.quarantineKey).catch(() => {});

	const workRows = await db
		.select({ id: works.id })
		.from(works)
		.where(eq(works.creatorId, creatorId));
	for (const w of workRows) {
		const [a] = await db.select({ file: assets.file }).from(assets).where(eq(assets.workId, w.id));
		if (a?.file) await storage.delete(a.file).catch(() => {});
	}

	// Holds carry no FK to their subject, so deleting the users leaves them active — and a
	// stale hold suspends real sweeps in later runs.
	await db.execute(sql`DELETE FROM legal_holds WHERE reason LIKE 'Quarantine of Work %'`);
	await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName})`);
});
