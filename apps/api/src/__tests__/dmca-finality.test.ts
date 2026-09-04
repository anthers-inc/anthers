// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The DMCA clocks, and the money that hangs off them.
 *
 * Three things are under test here, and each of them existed as an *absence*
 * before this suite — which is precisely the shape the Hub warns is most likely
 * to be untested:
 *
 * 1. **The restore sweep's query actually executes.** It did not: the predicate
 *    interpolated Drizzle columns inside their own quotes, rendering
 *    `""dmca_notices"."restore_no_earlier_than""`, which Postgres rejects as a
 *    zero-length delimited identifier. The daily cron threw on every run from the
 *    day it shipped, so **no Work was ever restored automatically** — the one
 *    § 512(g)(2)(C) obligation the job exists to discharge. Nothing failed
 *    visibly, because the only restore under test was the manual one. A sweep
 *    needs a test that runs the sweep.
 *
 * 2. **Buyers are refunded at finality, never at removal.** Refunding the moment
 *    a Work comes down and then restoring it on day 12 leaves a refunded buyer
 *    holding restored access, and spends charitable remainder on a claim that
 *    turned out to be wrong. So the assertion that matters is a *negative* one:
 *    immediately after a takedown, the buyer's purchase is untouched.
 *
 * 3. **A user report still never causes a removal** — including down the new
 *    route-out, whose entire job is to answer a reporter without treating their
 *    report as a notice.
 *
 * Nothing here reaches the network: the Stripe client is the same recording fake
 * `refunds.test.ts` uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { dmcaNotices, moderationReports, purchases, users, works } from "@anthers/db/schema";
import { calculateFees } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import {
	addBusinessDays,
	finalizeNotice,
	isBusinessDay,
	noticesReadyForFinality,
	noticesReadyForRestore,
} from "../services/dmca";
import { purgeAccountsCreatedHere } from "./cleanup";
import { purgeFixtureAccounts } from "./cleanup.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const FAKE_KEY = "sk_test_fake_no_network";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string | undefined, body: unknown) {
	const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
	if (cookie) headers.Cookie = cookie;
	return req(path, { method: "POST", headers, body: JSON.stringify(body) });
}

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// ── Business-day arithmetic ──────────────────────────────────────────────────
// Pure, no database. `new Date(y, m, d)` is local time, which is the same basis
// the implementation works on — see the note on `addBusinessDays` for why the
// remaining imprecision is inside the statute's 10-to-14-business-day band.

describe("business days — weekends", () => {
	it("a Saturday and a Sunday are not business days", () => {
		expect(isBusinessDay(new Date(2026, 7, 15))).toBe(false); // Sat 15 Aug 2026
		expect(isBusinessDay(new Date(2026, 7, 16))).toBe(false); // Sun 16 Aug 2026
		expect(isBusinessDay(new Date(2026, 7, 17))).toBe(true); // Mon 17 Aug 2026
	});

	it("adding business days skips the weekend", () => {
		// Thu 13 Aug 2026 + 2 business days = Mon 17 Aug.
		const out = addBusinessDays(new Date(2026, 7, 13), 2);
		expect(out.getFullYear()).toBe(2026);
		expect(out.getMonth()).toBe(7);
		expect(out.getDate()).toBe(17);
	});
});

describe("business days — federal holidays", () => {
	it("skips a fixed-date holiday", () => {
		expect(isBusinessDay(new Date(2026, 5, 19))).toBe(false); // Fri 19 Jun 2026 — Juneteenth
		expect(isBusinessDay(new Date(2026, 11, 25))).toBe(false); // Fri 25 Dec 2026 — Christmas
	});

	it("skips a computed holiday", () => {
		expect(isBusinessDay(new Date(2026, 0, 19))).toBe(false); // 3rd Mon Jan 2026 — MLK Day
		expect(isBusinessDay(new Date(2026, 4, 25))).toBe(false); // last Mon May 2026 — Memorial Day
		expect(isBusinessDay(new Date(2026, 10, 26))).toBe(false); // 4th Thu Nov 2026 — Thanksgiving
	});

	it("moves a Saturday holiday back to the preceding Friday", () => {
		// 4 July 2026 is a Saturday, so the federal holiday is observed Fri 3 July.
		// The Saturday is already skipped as a weekend; the Friday is the one that
		// only a holiday rule can catch.
		expect(isBusinessDay(new Date(2026, 6, 3))).toBe(false);
		expect(isBusinessDay(new Date(2026, 6, 6))).toBe(true); // Mon 6 July is normal
	});

	it("moves a Sunday holiday forward to the following Monday", () => {
		// 11 Nov 2029 (Veterans Day) is a Sunday → observed Mon 12 Nov.
		expect(isBusinessDay(new Date(2029, 10, 12))).toBe(false);
	});

	it("catches a New Year's Day observed in the PRECEDING year", () => {
		// 1 Jan 2028 is a Saturday, so it is observed Fri 31 Dec 2027 — a date the
		// 2027 holiday set would otherwise never contain, because the holiday it
		// belongs to is in 2028.
		expect(isBusinessDay(new Date(2027, 11, 31))).toBe(false);
	});

	it("a holiday pushes the computed date LATER, which is the safe direction", () => {
		// Mon 30 Nov 2026 + 5 business days. Without holidays that is Mon 7 Dec.
		// Thanksgiving (26 Nov) is behind us, so this window is clean — but the same
		// span started a week earlier crosses it.
		const clean = addBusinessDays(new Date(2026, 10, 30), 5);
		expect(clean.getDate()).toBe(7);
		expect(clean.getMonth()).toBe(11);

		// Mon 23 Nov 2026 + 5 business days: Tue/Wed/(Thu is Thanksgiving)/Fri/Mon/Tue
		// → Tue 1 Dec, one day later than the naive weekday count's Mon 30 Nov.
		const acrossHoliday = addBusinessDays(new Date(2026, 10, 23), 5);
		expect(acrossHoliday.getMonth()).toBe(11);
		expect(acrossHoliday.getDate()).toBe(1);
	});
});

// ── The database half ────────────────────────────────────────────────────────

interface Call {
	method: string;
	args: unknown[];
}

/** The same recording fake `refunds.test.ts` uses — nothing reaches the network. */
function fakeStripe() {
	const calls: Call[] = [];
	const real = new Stripe(FAKE_KEY);
	const client = {
		webhooks: real.webhooks,
		refunds: {
			create: (...args: unknown[]) => {
				calls.push({ method: "refunds.create", args });
				return Promise.resolve({ id: `re_${uid()}` });
			},
		},
	} as unknown as Stripe;
	return { client, calls, reset: () => calls.splice(0, calls.length) };
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `fin_creator_${run}`;
const buyerName = `fin_buyer_${run}`;
const adminName = `fin_admin_${run}`;

const PRICE = "5.00";
const fees = calculateFees(new Decimal(PRICE), { type: "digital" });

let fake: ReturnType<typeof fakeStripe>;
let realClient: Stripe | null;
let creatorId: number;
let buyerId: number;
let creatorCookie: string;
let buyerCookie: string;
let adminCookie: string;

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
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
	const cookie = res.headers.get("Set-Cookie")?.split(";")[0] as string;
	const [row] = await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.username, username))
		.returning({ id: users.id });
	return { cookie, id: row.id };
}

/** A released Work for sale, with one completed purchase behind it. */
async function workWithBuyer(title: string) {
	const work = await insertWork({
		creatorId,
		type: "game",
		title,
		streamEnabled: false,
		downloadEnabled: true,
		seedAccess: [{ threshold: 0, allow: true, price: PRICE }],
	});
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId,
			workId: work.id,
			creatorId,
			workTitle: title,
			workType: "game",
			workPublicId: work.publicId,
			type: "digital",
			amount: PRICE,
			processingFee: fees.processingFee.toFixed(2),
			deliveryFee: fees.deliveryFee.toFixed(2),
			crfFee: "0.00",
			salesTax: fees.salesTax.toFixed(2),
			creatorEarnings: fees.creatorEarnings.toFixed(2),
			stripePaymentIntentId: `pi_${uid()}`,
			status: "completed",
		})
		.returning();
	return { workId: work.id, purchaseId: purchase.id };
}

function noticeBody(targetWorkId: number) {
	return {
		workId: targetWorkId,
		complainantName: "Copyright Holder",
		complainantEmail: "holder@example.com",
		complainantAddress: "123 Main St, Anytown, US",
		complainantPhone: "555-0100",
		copyrightedWorkDescription: "My original game.",
		infringingMaterialDescription: "The work at this URL is a copy of my game.",
		goodFaithStatement: "I have a good faith belief that the use is not authorized.",
		authorizationStatement: "The information is accurate and I am authorized to act.",
		fairUseConsidered: true,
	};
}

/** File a notice against a Work and have the admin act on it. Returns the notice id. */
async function takedown(targetWorkId: number): Promise<number> {
	const filed = await post("/api/dmca/notices", undefined, noticeBody(targetWorkId));
	expect(filed.status).toBe(201);
	const noticeId = (await filed.json()).noticeId as number;
	const acted = await post(`/api/admin/dmca/${noticeId}/act`, adminCookie, {});
	expect(acted.status).toBe(200);
	return noticeId;
}

async function reloadNotice(noticeId: number) {
	const [row] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, noticeId)).limit(1);
	return row;
}

async function reloadPurchase(purchaseId: number) {
	const [row] = await db.select().from(purchases).where(eq(purchases.id, purchaseId)).limit(1);
	return row;
}

const createdWorks: number[] = [];

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${adminName})`,
	);
	realClient = getStripe();
	fake = fakeStripe();
	setStripeClient(fake.client);

	({ cookie: creatorCookie, id: creatorId } = await signUp(creatorName));
	({ cookie: buyerCookie, id: buyerId } = await signUp(buyerName));
	({ cookie: adminCookie } = await signUp(adminName));
	await db.execute(sql`UPDATE users SET is_admin = true WHERE username = ${adminName}`);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	// 🚨 Reports first, and explicitly: `moderation_reports.reporter_id` is `set null`
	// rather than `cascade`, because a moderation record has to outlive the account it
	// concerns — so deleting these users leaves every report this suite filed behind.
	await purgeFixtureAccounts([creatorName, buyerName, adminName]);
	setStripeClient(realClient);
	// Notices first, then works, then users. `dmca_notices.work_id` is `set null`,
	// so a Work delete no longer takes its notices with it; and `works.creator_id`
	// is `set null` too, so deleting the users would orphan the Works rather than
	// remove them. Both directions leave litter if the order is wrong.
	for (const id of createdWorks) {
		await db.delete(dmcaNotices).where(eq(dmcaNotices.workId, id));
		await db.delete(works).where(eq(works.id, id));
	}
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${adminName})`,
	);
});

// ── The sweeps ───────────────────────────────────────────────────────────────

describe("the restore sweep query", () => {
	it("executes at all, and selects a notice whose window has closed", async () => {
		const { workId } = await workWithBuyer(`Restore sweep ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		// Counter-notice, then backdate the window so the sweep should pick it up.
		const countered = await post(`/api/dmca/notices/${noticeId}/counter`, creatorCookie, {
			subscriberName: "A Creator",
			subscriberAddress: "1 Creator Way, Anytown, US",
			subscriberPhone: "555-0111",
			jurisdictionConsent: "I consent to federal jurisdiction.",
			goodFaithStatement: "Removed by mistake.",
		});
		expect(countered.status).toBe(201);
		await db
			.update(dmcaNotices)
			.set({ restoreNoEarlierThan: new Date(Date.now() - 86_400_000) })
			.where(eq(dmcaNotices.id, noticeId));

		// 🚨 This call is the regression test. It threw `zero-length delimited
		// identifier` before the quoting fix, which meant the daily cron never
		// restored anything.
		const ready = await noticesReadyForRestore();
		expect(ready.some((n) => n.noticeId === noticeId)).toBe(true);
	});

	it("excludes a notice whose complainant filed suit", async () => {
		const { workId } = await workWithBuyer(`Suit filed ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		const countered = await post(`/api/dmca/notices/${noticeId}/counter`, creatorCookie, {
			subscriberName: "A Creator",
			subscriberAddress: "1 Creator Way, Anytown, US",
			subscriberPhone: "555-0111",
			jurisdictionConsent: "I consent to federal jurisdiction.",
			goodFaithStatement: "Removed by mistake.",
		});
		expect(countered.status).toBe(201);
		await db
			.update(dmcaNotices)
			.set({ restoreNoEarlierThan: new Date(Date.now() - 86_400_000) })
			.where(eq(dmcaNotices.id, noticeId));

		const suit = await post(`/api/admin/dmca/${noticeId}/suit`, adminCookie, {});
		expect(suit.status).toBe(200);

		const ready = await noticesReadyForRestore();
		expect(ready.some((n) => n.noticeId === noticeId)).toBe(false);
	});
});

describe("the finality sweep query", () => {
	it("ignores a takedown whose counter-notice window is still open", async () => {
		const { workId } = await workWithBuyer(`Window open ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		const notice = await reloadNotice(noticeId);
		expect(notice?.counterNoticeDueBy).toBeTruthy();
		expect(notice!.counterNoticeDueBy!.getTime()).toBeGreaterThan(Date.now());

		const ready = await noticesReadyForFinality();
		expect(ready.some((n) => n.noticeId === noticeId)).toBe(false);
	});

	it("selects a takedown whose window has closed with no counter-notice", async () => {
		const { workId } = await workWithBuyer(`Window closed ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);
		await db
			.update(dmcaNotices)
			.set({ counterNoticeDueBy: new Date(Date.now() - 86_400_000) })
			.where(eq(dmcaNotices.id, noticeId));

		const ready = await noticesReadyForFinality();
		expect(ready.some((n) => n.noticeId === noticeId)).toBe(true);
	});
});

// ── Refund at finality, not at removal ───────────────────────────────────────

describe("buyer refunds are released at finality, never at removal", () => {
	it("a takedown alone refunds nobody", async () => {
		const { workId, purchaseId } = await workWithBuyer(`No refund yet ${uid()}`);
		createdWorks.push(workId);
		fake.reset();
		await takedown(workId);

		// The negative assertion is the point: the money has not moved.
		expect(fake.calls.length).toBe(0);
		const purchase = await reloadPurchase(purchaseId);
		expect(purchase?.status).toBe("completed");
		expect(purchase?.refundedAt).toBeNull();
	});

	it("finalizing refunds the buyer and stamps the notice", async () => {
		const { workId, purchaseId } = await workWithBuyer(`Refund at finality ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);
		fake.reset();

		const result = await finalizeNotice({ noticeId, reason: "no_counter_notice" });
		expect(result).toEqual({ finalized: true, buyersRefunded: 1 });
		expect(fake.calls.length).toBe(1);

		const purchase = await reloadPurchase(purchaseId);
		expect(purchase?.status).toBe("refunded");

		const notice = await reloadNotice(noticeId);
		expect(notice?.finalizedAt).toBeTruthy();
		expect(notice?.finalizedReason).toBe("no_counter_notice");
		expect(notice?.buyersRefunded).toBe(1);
	});

	it("a refunded buyer does not silently regain access if the Work comes back", async () => {
		const { workId, purchaseId } = await workWithBuyer(`Restore after refund ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);
		await finalizeNotice({ noticeId, reason: "no_counter_notice" });

		// A late counter-notice still restores the Work — the window governs the
		// money, never whether the creator may answer.
		const restored = await post(`/api/admin/dmca/${noticeId}/restore`, adminCookie, {});
		expect(restored.status).toBe(200);

		// The Work is back, but the refunded purchase is not an entitlement:
		// `resolveAccess` counts only completed purchases.
		const [work] = await db
			.select({ takedownStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		expect(work?.takedownStatus).toBe("active");

		const purchase = await reloadPurchase(purchaseId);
		expect(purchase?.status).toBe("refunded");

		// Asserted through the ownership endpoint rather than re-derived here: it
		// runs the same resolver the delivery routes do.
		const [row] = await db
			.select({ slug: works.slug })
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		const owns = await req(`/api/payments/owns/${row.slug}`, { headers: { Cookie: buyerCookie } });
		expect(owns.status).toBe(200);
		expect((await owns.json()).owns).toBe(false);
	});

	it("refuses to finalize a notice an operator already restored", async () => {
		const { workId, purchaseId } = await workWithBuyer(`Restored early ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		const restored = await post(`/api/admin/dmca/${noticeId}/restore`, adminCookie, {
			note: "Complainant withdrew",
		});
		expect(restored.status).toBe(200);
		fake.reset();

		// `not_actioned`, not `not_taken_down`: `restoreWork` moves the notice to
		// `restored`, so the notice-lifecycle guard is the one that fires. Both
		// guards protect the same thing; only the order decides which speaks.
		const result = await finalizeNotice({ noticeId, reason: "no_counter_notice" });
		expect(result).toEqual({ finalized: false, reason: "not_actioned" });
		expect(fake.calls.length).toBe(0);
		expect((await reloadPurchase(purchaseId))?.status).toBe("completed");
	});

	it("refuses to finalize a Work that is no longer taken down", async () => {
		const { workId, purchaseId } = await workWithBuyer(`Work back up ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		// Constructed directly, because no app path produces it: `restoreWork` always
		// moves the notice too, so the `not_taken_down` branch is defense in depth
		// against a future writer of `takedown_status` that forgets the notice. It is
		// tested rather than trusted for exactly that reason — an unreachable guard
		// nobody has exercised is a guard nobody knows works.
		await db.update(works).set({ takedownStatus: "active" }).where(eq(works.id, workId));
		fake.reset();

		const result = await finalizeNotice({ noticeId, reason: "no_counter_notice" });
		expect(result).toEqual({ finalized: false, reason: "not_taken_down" });
		expect(fake.calls.length).toBe(0);
		expect((await reloadPurchase(purchaseId))?.status).toBe("completed");
	});

	it("is idempotent — a second finalize refunds nobody twice", async () => {
		const { workId } = await workWithBuyer(`Idempotent ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		await finalizeNotice({ noticeId, reason: "no_counter_notice" });
		fake.reset();
		const second = await finalizeNotice({ noticeId, reason: "no_counter_notice" });
		expect(second).toEqual({ finalized: false, reason: "already_final" });
		expect(fake.calls.length).toBe(0);
	});
});

describe("conceding", () => {
	it("lets the creator settle the sale without waiting out the clock", async () => {
		const { workId, purchaseId } = await workWithBuyer(`Conceded ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);
		fake.reset();

		const res = await post(`/api/dmca/notices/${noticeId}/concede`, creatorCookie, {});
		expect(res.status).toBe(200);
		expect((await res.json()).buyersRefunded).toBe(1);

		expect((await reloadPurchase(purchaseId))?.status).toBe("refunded");
		expect((await reloadNotice(noticeId))?.finalizedReason).toBe("conceded");
	});

	it("refuses anyone who is not the Work's creator", async () => {
		const { workId, purchaseId } = await workWithBuyer(`Not yours ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);
		fake.reset();

		const res = await post(`/api/dmca/notices/${noticeId}/concede`, buyerCookie, {});
		expect(res.status).toBe(403);
		expect(fake.calls.length).toBe(0);
		expect((await reloadPurchase(purchaseId))?.status).toBe("completed");
	});
});

// ── The route-out ────────────────────────────────────────────────────────────

describe("routing a report out to the copyright path", () => {
	it("clears the reports and removes nothing", async () => {
		const { workId } = await workWithBuyer(`Route out ${uid()}`);
		createdWorks.push(workId);

		const reported = await post("/api/moderation/reports", buyerCookie, {
			subjectType: "work",
			subjectId: workId,
			reason: "spam",
			details: "this is my song and they did not license it",
		});
		expect(reported.status).toBe(201);

		const routed = await post("/api/admin/moderation/route-to-copyright", adminCookie, {
			subjectType: "work",
			subjectId: workId,
		});
		expect(routed.status).toBe(200);
		const body = await routed.json();
		expect(body.dismissed).toBe(1);
		expect(body.reportersNotified).toBe(1);

		// 🚨 The load-bearing assertion: the Work is untouched. A bare user report
		// is not a notice, and pointing the reporter at the notice path must not
		// have the side effect the notice path would have had.
		const [work] = await db
			.select({ takedownStatus: works.takedownStatus })
			.from(works)
			.where(eq(works.id, workId))
			.limit(1);
		expect(work?.takedownStatus).toBe("active");

		// No notice was created either — routing out is a signpost, not a filing.
		const notices = await db.select().from(dmcaNotices).where(eq(dmcaNotices.workId, workId));
		expect(notices.length).toBe(0);

		// And the report is closed rather than left in the queue.
		const reports = await db
			.select({ status: moderationReports.status })
			.from(moderationReports)
			.where(
				sql`${moderationReports.subjectType} = 'work' AND ${moderationReports.subjectId} = ${workId}`,
			);
		expect(reports.every((r) => r.status === "dismissed")).toBe(true);
	});
});

// ── The record outlives what it was about ────────────────────────────────────

describe("a notice survives the Work it named", () => {
	it("is not erased when the creator deletes the Work", async () => {
		const { workId } = await workWithBuyer(`Deleted work ${uid()}`);
		const noticeId = await takedown(workId);

		// 🚨 The whole point. `work_id` was `cascade` until 2026-08-16, which meant a
		// creator could erase the record of their own infringement by deleting the
		// Work — while the published terms say we judge a pattern. A pattern held in
		// rows the subject can delete is not a record.
		await db.delete(works).where(eq(works.id, workId));

		const notice = await reloadNotice(noticeId);
		expect(notice).toBeDefined();
		expect(notice?.workId).toBeNull();
		// And it is still readable: the title was snapshotted at filing, so the
		// operator queue does not render a nameless row.
		expect(notice?.workTitle).toContain("Deleted work");

		await db.delete(dmcaNotices).where(eq(dmcaNotices.id, noticeId));
	});
});

// ── The creator's own notices ────────────────────────────────────────────────

describe("a creator's own notices", () => {
	it("shows the creator the notice against their Work, and tells them who filed it", async () => {
		const { workId } = await workWithBuyer(`Mine ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		const res = await req("/api/dmca/notices/mine", { headers: { Cookie: creatorCookie } });
		expect(res.status).toBe(200);
		const mine = (await res.json()).notices as { id: number; complainantName: string }[];
		const found = mine.find((n) => n.id === noticeId);
		expect(found).toBeDefined();
		// Being accused without being told by whom is not answerable.
		expect(found?.complainantName).toBe("Copyright Holder");
	});

	it("never hands the creator the complainant's address or telephone", async () => {
		const { workId } = await workWithBuyer(`No address ${uid()}`);
		createdWorks.push(workId);
		await takedown(workId);

		const res = await req("/api/dmca/notices/mine", { headers: { Cookie: creatorCookie } });
		const text = JSON.stringify(await res.json());
		// 🚨 An absence, so it needs a test. The statute compels the disclosure in
		// exactly one direction — a counter-notice hands the CREATOR's details to
		// the complainant. Nothing compels the reverse, and shipping it by accident
		// would hand an address to the person most motivated to misuse it.
		expect(text).not.toContain("123 Main St");
		expect(text).not.toContain("555-0100");
		expect(text).not.toContain("holder@example.com");
	});

	it("shows a creator nothing about someone else's Work", async () => {
		const { workId } = await workWithBuyer(`Not mine ${uid()}`);
		createdWorks.push(workId);
		const noticeId = await takedown(workId);

		const res = await req("/api/dmca/notices/mine", { headers: { Cookie: buyerCookie } });
		expect(res.status).toBe(200);
		const mine = (await res.json()).notices as { id: number }[];
		expect(mine.some((n) => n.id === noticeId)).toBe(false);
	});

	it("requires signing in", async () => {
		const res = await req("/api/dmca/notices/mine");
		expect(res.status).toBe(401);
	});
});

// ── Transparency ─────────────────────────────────────────────────────────────

describe("the transparency counts", () => {
	it("are public — no auth, no admin", async () => {
		const res = await req("/api/dmca/transparency");
		expect(res.status).toBe(200);
		const body = await res.json();
		for (const key of ["received", "actioned", "rejected", "counterNoticed", "restored", "total"]) {
			expect(typeof body[key]).toBe("number");
		}
	});

	it("carry no per-notice detail — no names, no addresses", async () => {
		const res = await req("/api/dmca/transparency");
		const text = JSON.stringify(await res.json());
		// The complainant fixture's details must not appear in a public payload.
		expect(text).not.toContain("Copyright Holder");
		expect(text).not.toContain("holder@example.com");
		expect(text).not.toContain("123 Main St");
	});
});
