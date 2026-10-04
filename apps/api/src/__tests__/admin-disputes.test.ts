// SPDX-License-Identifier: Apache-2.0
/**
 * The admin disputes surface — the list a person evaluates a chargeback against, its
 * flags, the standing panel, and the evidence deadline's place on the deadline list.
 *
 * The decisions under test are Parker's, not this suite's: Anthers never contests by
 * default and a person evaluates an exceptional one (2026-09-15); the admin app flags
 * repeated disputes on one creator's sales, a single large dispute, and any pattern
 * that looks like a creator paying themselves (2026-09-14); and the alert's lines are
 * Visa's VAMP rule — 0.5% or 5 in a month, applied as an early warning with
 * "approaching" at half (2026-10-02).
 *
 * What is worth pinning here, because every one of these fails silently:
 *
 *   • the gate holds — no session → 401, an Anthers account → 401, off the admin host → 404;
 *   • the flags are computed at read time and scoped honestly: repeat and self-pay to
 *     purchase disputes only (a support charge's creator is not knowable from the
 *     record), large to every dispute over the line, in cents;
 *   • the standing states fire from EITHER half of the line — the count is what a small
 *     account trips first, so a state computed from the ratio alone would stay quiet
 *     through it;
 *   • the standing count is tested in an ERA the suite owns (rows stamped into an empty
 *     era, read through the service's own `now`), so the window arithmetic — both edges,
 *     the `warning_*` exclusion, closed rows still counting — is exact and provable
 *     without depending on what any other suite left in the real window, which is where
 *     the old whole-table `before + 1` delta broke (order-dependent greenness, audit
 *     finding 8's unit half);
 *   • ratio null is "nothing to say," never 0%;
 *   • an open dispute's evidence deadline joins the deadline list through the existing
 *     gather, and a closed dispute's does not.
 *
 * Rows are written directly rather than driven through the webhook: the webhook path
 * is `disputes.test.ts`'s subject (child 1's), and this suite tests the reading of
 * rows that already carry their dates.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { disputes, invoices, purchases, users, works } from "@anthers/db/schema";
import { DISPUTE_WINDOW_DAYS } from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

/**
 * 🚨 **Naming `ADMIN_URL` is what makes the wrong-host refusal real here.** With it unset
 * the admin host falls back to "any host in a checkout" (`isAdminHost`), so nothing can
 * 404 — the same reason `admin-deadlines.test.ts` pins it before asserting host behavior.
 */
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `adsp_cr_${run}`;
const buyerName = `adsp_buy_${run}`;
const otherBuyerName = `adsp_ob_${run}`;
const supporterName = `adsp_sup_${run}`;
const creator2Name = `adsp_c2_${run}`;

const DAY_MS = 86_400_000;

interface DisputeItem {
	id: number;
	stripeDisputeId: string;
	kind: "purchase" | "support" | "unlinked";
	amount: string;
	reason: string;
	status: string;
	outcome: string | null;
	evidenceDueBy: string | null;
	createdAt: string;
	workTitle: string | null;
	creator: { id: number; handle: string } | null;
	buyer: { id: number; handle: string } | null;
	flags: string[];
}

interface Standing {
	count: number;
	ratio: number | null;
	openCount: number;
	state: "quiet" | "approaching" | "early-warning";
}

interface DisputesResponse {
	items: DisputeItem[];
	standing: Standing;
}

interface DeadlineRow {
	source: string;
	key: string;
	title: string;
	dueAt: string;
	actUrl: string | null;
}

let adminCookie: string;
let plainCookie: string;
let creatorId: number;
let creator2Id: number;
let buyerId: number;
let otherBuyerId: number;
let workId: number;
let supporterInvoiceId: number;
/** The highest `disputes.id` before this suite ran — everything above is ours to take. */
let disputeWater = 0;
const fixtureDisputeIds: number[] = [];
const fixturePurchaseIds: number[] = [];
const fixtureInvoiceIds: number[] = [];
const accountIds: number[] = [];

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("disputes")).cookie;

	const creator = await createAccount(creatorName);
	const buyer = await createAccount(buyerName);
	const otherBuyer = await createAccount(otherBuyerName);
	const supporter = await createAccount(supporterName);
	const creator2 = await createAccount(creator2Name);
	accountIds.push(
		creator.userId,
		buyer.userId,
		otherBuyer.userId,
		supporter.userId,
		creator2.userId,
	);
	creatorId = creator.userId;
	buyerId = buyer.userId;
	otherBuyerId = otherBuyer.userId;
	creator2Id = creator2.userId;
	plainCookie = buyer.cookie;

	const work = await insertWork({
		creatorId,
		type: "game",
		title: `Admin disputes work ${run}`,
		streamEnabled: false,
		downloadEnabled: true,
		access: [],
	});
	workId = work.id;

	// A support invoice, for the support-charge row: one paid invoice keyed to a fake
	// Stripe id, the shape `markInvoiceMoneyReturned` resolves by.
	const [invoice] = await db
		.insert(invoices)
		.values({
			userId: supporter.userId,
			stripeInvoiceId: `in_adsp_${uid()}`,
			stripePaymentIntentId: `pi_adsp_inv_${uid()}`,
			billingCycle: "2026-09-01",
			status: "paid",
			subtotal: "3.00",
			tax: "0.00",
			total: "3.00",
		})
		.returning({ id: invoices.id });
	supporterInvoiceId = invoice.id;
	fixtureInvoiceIds.push(invoice.id);

	const [tallest] = await db
		.select({ id: disputes.id })
		.from(disputes)
		.orderBy(sql`${disputes.id} DESC`)
		.limit(1);
	disputeWater = tallest?.id ?? 0;
}, DB_SETUP_TIMEOUT);

/** A completed purchase row by this suite's creator, on a fresh PaymentIntent. */
async function purchase(opts: { buyer?: number; creator?: number; amount?: string } = {}) {
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId: opts.buyer ?? buyerId,
			workId,
			creatorId: opts.creator ?? creatorId,
			workTitle: `Admin disputes work ${run}`,
			workType: "game",
			workPublicId: null,
			type: "digital",
			amount: opts.amount ?? "5.00",
			processingFee: "0.45",
			salesTax: "0.00",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_adsp_${uid()}`,
			status: "completed",
		})
		.returning({ id: purchases.id, stripePaymentIntentId: purchases.stripePaymentIntentId });
	fixturePurchaseIds.push(row.id);
	return row;
}

/** A dispute row, shaped the way `recordDisputeCreated` writes it. */
async function dispute(opts: {
	purchaseId?: number | null;
	invoiceId?: number | null;
	userId?: number | null;
	amount?: string;
	status?: string;
	outcome?: string | null;
	evidenceDueBy?: Date | null;
	/**
	 * Stamps the row into an era the suite owns — the standing panel's test (below)
	 * counts a window no other fixture can enter. Undefined keeps the column's own
	 * default (now), which is what the real path writes.
	 */
	createdAt?: Date;
}) {
	const [row] = await db
		.insert(disputes)
		.values({
			stripeDisputeId: `dp_adsp_${uid()}`,
			stripeChargeId: `ch_adsp_${uid()}`,
			stripePaymentIntentId: `pi_adsp_${uid()}`,
			amount: opts.amount ?? "5.00",
			currency: "usd",
			reason: "fraudulent",
			status: opts.status ?? "needs_response",
			purchaseId: opts.purchaseId ?? null,
			invoiceId: opts.invoiceId ?? null,
			userId: opts.userId ?? null,
			evidenceDueBy:
				opts.evidenceDueBy === undefined ? new Date(Date.now() + 10 * DAY_MS) : opts.evidenceDueBy,
			outcome: opts.outcome ?? null,
			...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
		})
		.returning({ id: disputes.id });
	fixtureDisputeIds.push(row.id);
	return row;
}

async function disputesList(): Promise<DisputesResponse> {
	const res = await req("/api/admin/disputes", { headers: { Cookie: adminCookie } });
	expect(res.status).toBe(200);
	return (await res.json()) as DisputesResponse;
}

async function deadlines(): Promise<{ deadlines: DeadlineRow[] }> {
	const res = await req("/api/admin/deadlines", { headers: { Cookie: adminCookie } });
	expect(res.status).toBe(200);
	return (await res.json()) as { deadlines: DeadlineRow[] };
}

afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	// The dispute rows are swept by high-water mark first — `disputes.user_id` is
	// `set null`, so purging the account would orphan them, the same shape
	// `disputes.test.ts` uses. Then the rows that point at the accounts, then the
	// accounts.
	if (fixtureDisputeIds.length > 0) {
		await db.delete(disputes).where(inArray(disputes.id, fixtureDisputeIds));
	}
	const strays = await db
		.select({ id: disputes.id })
		.from(disputes)
		.where(sql`${disputes.id} > ${disputeWater}`);
	if (strays.length > 0) {
		await db.delete(disputes).where(
			sql`${disputes.id} IN (${sql.join(
				strays.map((d) => sql`${d.id}`),
				sql`, `,
			)})`,
		);
	}
	await db.delete(purchases).where(inArray(purchases.id, fixturePurchaseIds));
	await db.delete(invoices).where(inArray(invoices.id, fixtureInvoiceIds));
	await db.delete(works).where(eq(works.id, workId));
	await db.delete(users).where(inArray(users.id, accountIds));
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/admin/disputes — the gate", () => {
	it("401s with no session", async () => {
		const res = await req("/api/admin/disputes");
		expect(res.status).toBe(401);
	});

	it("401s a signed-in Anthers account", async () => {
		const res = await req("/api/admin/disputes", { headers: { Cookie: plainCookie } });
		expect(res.status).toBe(401);
	});

	it("404s off the admin host", async () => {
		const res = await testFetch(new Request(`${SITE_HOST}/api/admin/disputes`));
		expect(res.status).toBe(404);
	});
});

describe("GET /api/admin/disputes — the flags", () => {
	it("labels a purchase dispute with its Work, creator and buyer, unflagged when ordinary", async () => {
		const p = await purchase({ buyer: otherBuyerId });
		const d = await dispute({ purchaseId: p.id, userId: otherBuyerId });
		const body = await disputesList();
		const row = body.items.find((i) => i.id === d.id);
		expect(row).toBeDefined();
		expect(row?.kind).toBe("purchase");
		expect(row?.workTitle).toBe(`Admin disputes work ${run}`);
		expect(row?.creator?.id).toBe(creatorId);
		expect(row?.buyer?.id).toBe(otherBuyerId);
		expect(row?.flags).toEqual([]);
	});

	it("flags large over the line, in cents — 50.00 flags and 49.99 does not", async () => {
		const under = await dispute({ amount: "49.99" });
		const over = await dispute({ amount: "50.00" });
		const body = await disputesList();
		expect(body.items.find((i) => i.id === under.id)?.flags).toEqual([]);
		expect(body.items.find((i) => i.id === over.id)?.flags).toContain("large");
	});

	it("flags repeat when the same creator has 2+ purchase disputes in the window", async () => {
		const p1 = await purchase({ buyer: otherBuyerId });
		const p2 = await purchase({ buyer: otherBuyerId });
		const d1 = await dispute({ purchaseId: p1.id, userId: otherBuyerId });
		const d2 = await dispute({ purchaseId: p2.id, userId: otherBuyerId });
		const body = await disputesList();
		expect(body.items.find((i) => i.id === d1.id)?.flags).toContain("repeat");
		expect(body.items.find((i) => i.id === d2.id)?.flags).toContain("repeat");
	});

	it("does not flag repeat across creators, and scopes it to purchase disputes", async () => {
		// A second creator's purchase: one dispute each is not a repeat.
		const pOther = await purchase({ creator: creator2Id, buyer: otherBuyerId });
		const dOther = await dispute({ purchaseId: pOther.id, userId: otherBuyerId });

		// A support-charge dispute: no creator attribution exists, so no repeat flag even
		// though the platform has several disputes.
		const dSupport = await dispute({ invoiceId: supporterInvoiceId, userId: buyerId });

		const body = await disputesList();
		expect(body.items.find((i) => i.id === dOther.id)?.flags).not.toContain("repeat");
		expect(body.items.find((i) => i.id === dSupport.id)?.kind).toBe("support");
		expect(body.items.find((i) => i.id === dSupport.id)?.flags).not.toContain("repeat");
	});

	it("flags self-pay when the dispute's buyer is the Work's creator", async () => {
		const p = await purchase({ buyer: creatorId, creator: creatorId });
		const d = await dispute({ purchaseId: p.id, userId: creatorId });
		const body = await disputesList();
		const row = body.items.find((i) => i.id === d.id);
		expect(row?.flags).toContain("self-pay");
		expect(row?.buyer?.id).toBe(creatorId);
		expect(row?.creator?.id).toBe(creatorId);
	});

	it("sorts flagged rows above unflagged ones", async () => {
		const body = await disputesList();
		const firstUnflagged = body.items.findIndex((i) => i.flags.length === 0);
		if (firstUnflagged === -1) return;
		for (const after of body.items.slice(firstUnflagged)) {
			expect(after.flags.length).toBe(0);
		}
	});
});

describe("the standing panel", () => {
	it("states every threshold state, and either half of the line fires it", async () => {
		const { disputeStandingState } = await import("../services/admin-disputes.js");
		const ratio = new Decimal(1).dividedBy(200); // exactly 0.5%

		// Quiet: below both halves.
		expect(disputeStandingState(0, null)).toBe("quiet");
		expect(disputeStandingState(2, new Decimal("0.001"))).toBe("quiet");

		// Approaching at HALF of either line — and from either half alone, which is the
		// small-account case: the count trips before the ratio does.
		expect(disputeStandingState(2, new Decimal("0.001"))).toBe("quiet");
		expect(disputeStandingState(3, new Decimal("0.001"))).toBe("approaching");
		expect(disputeStandingState(0, new Decimal("0.0025"))).toBe("approaching");

		// Early-warning at the full line, from either half.
		expect(disputeStandingState(5, new Decimal("0"))).toBe("early-warning");
		expect(disputeStandingState(0, ratio)).toBe("early-warning");
	});

	it("treats a null ratio as nothing to say rather than 0%", async () => {
		const { disputeStandingState } = await import("../services/admin-disputes.js");
		// A null ratio is not 0%: with a quiet count it is quiet, and the count half
		// still stands on its own — a null ratio never *suppresses* a crossed count,
		// which is the small-account case the two halves exist for.
		expect(disputeStandingState(0, null)).toBe("quiet");
		expect(disputeStandingState(4, null)).toBe("approaching");
		expect(disputeStandingState(5, null)).toBe("early-warning");
	});

	it("counts the window's disputes and names the state from them", async () => {
		// 🚨 The count is read in an ERA this suite owns rather than the real one, which
		// is the standing-test audit's cure for order-dependent greenness (finding 8's
		// unit half): the old form read the whole table's `before + 1`, green only while
		// every other suite's cleanup happened to keep the window still — and it flaked
		// live in a full-suite run on 2026-10-04, passing isolated. These rows are
		// stamped into an empty era and read through `disputeStanding`'s own `now`, so
		// every figure below is exactly this suite's, whatever any other suite left in
		// the real window.
		const { disputeStanding } = await import("../services/admin-disputes.js");
		const ERA_NOW = new Date("2020-07-01T00:00:00Z");
		const windowStartMs = ERA_NOW.getTime() - DISPUTE_WINDOW_DAYS * DAY_MS;

		// The era is empty before we furnish it — the assertion that makes every later
		// figure exact. Its ratio is also null: no successful payments exist in the era,
		// which is the small-account case the count half exists for — the state can
		// fire on the count while the ratio has nothing to say.
		const before = await disputeStanding(ERA_NOW);
		expect(before.count).toBe(0);
		expect(before.ratio).toBeNull();
		expect(before.state).toBe("quiet");

		// One second before the window's start: outside, never counted — the window's
		// opening edge. (One second after its end is furnished below, for the same
		// proof at the closing edge.)
		await dispute({ createdAt: new Date(windowStartMs - 1000) });

		// Three open rows inside the window. A count of 3 is half of Visa's VAMP line
		// (5 a month) with the ratio still null — "approaching" from the count half
		// alone, the trip the pure tests above pin and this proves the query serves.
		const inWindow = new Date("2020-06-15T12:00:00Z");
		for (let i = 0; i < 3; i += 1) {
			await dispute({ createdAt: new Date(inWindow.getTime() + i * 1000) });
		}
		const approaching = await disputeStanding(ERA_NOW);
		expect(approaching.count).toBe(3);
		expect(approaching.ratio).toBeNull();
		expect(approaching.state).toBe("approaching");

		// A closed dispute still counts — the window's rows are disputes that landed,
		// not only ones a person still owes evidence on (that is `openCount`'s read).
		await dispute({
			createdAt: new Date(inWindow.getTime() + 10 * 1000),
			status: "lost",
			outcome: "lost",
		});
		// A fourth open row carries the count across the full line: early-warning from
		// the count half alone.
		await dispute({ createdAt: new Date(inWindow.getTime() + 20 * 1000) });
		const warning = await disputeStanding(ERA_NOW);
		expect(warning.count).toBe(5);
		expect(warning.ratio).toBeNull();
		expect(warning.state).toBe("early-warning");

		// A `warning_*` row in the window is radar, not a dispute that landed — the
		// exclusion every count here and in `disputeActivityRatio` carries. It sits in
		// the window and the count stays at 5.
		await dispute({
			createdAt: new Date(inWindow.getTime() + 30 * 1000),
			status: "warning_closed",
		});
		const excluding = await disputeStanding(ERA_NOW);
		expect(excluding.count).toBe(5);
		expect(excluding.state).toBe("early-warning");

		// One second after the era's end: outside, never counted — the window's
		// closing edge.
		await dispute({ createdAt: new Date(ERA_NOW.getTime() + 1000) });
		const edges = await disputeStanding(ERA_NOW);
		expect(edges.count).toBe(5);
	});

	it("the panel and the list read the same rows on one request", async () => {
		// Same single request, two halves — so no suite-order or cleanup timing can move
		// them apart, which is what the old whole-table `before + 1` delta left the
		// coupling exposed to. `openCount` is an all-time read (no window), and the
		// list is an all-time list (loadDisputes filters nothing), so the panel's open
		// count is exactly the rows the list shows as open, warning radar excluded.
		const p = await purchase({ buyer: otherBuyerId });
		const d = await dispute({ purchaseId: p.id, userId: otherBuyerId });
		const body = await disputesList();
		// The row the list reads and the row the panel reads are the same row.
		expect(body.items.find((i) => i.id === d.id)).toBeDefined();
		const openShown = body.items.filter(
			(i) => i.outcome === null && !i.status.startsWith("warning_"),
		).length;
		expect(body.standing.openCount).toBe(openShown);
		// And the row just inserted is inside the panel's window count, whatever else
		// the window holds: standing is not asserted against a whole-table delta any
		// more (the era test above owns the arithmetic), but a landed dispute must
		// still stand in it.
		expect(body.standing.count).toBeGreaterThanOrEqual(1);
	});
});

describe("GET /api/admin/deadlines — the dispute evidence deadline", () => {
	it("places an open dispute's evidence deadline on the list", async () => {
		const due = new Date(Date.now() + 7 * DAY_MS);
		const p = await purchase({ buyer: otherBuyerId });
		const d = await dispute({ purchaseId: p.id, userId: otherBuyerId, evidenceDueBy: due });
		const body = await deadlines();
		const row = body.deadlines.find((r) => r.key === `dispute-evidence:${d.id}`);
		expect(row).toBeDefined();
		expect(row?.source).toBe("dispute-evidence");
		expect(new Date(row!.dueAt).toISOString()).toBe(due.toISOString());
		expect(row?.actUrl).toBe("/books/disputes");
	});

	it("leaves a closed dispute off the list", async () => {
		const p = await purchase({ buyer: otherBuyerId });
		const d = await dispute({
			purchaseId: p.id,
			userId: otherBuyerId,
			status: "lost",
			outcome: "lost",
			// The close write nulls the deadline; the row here mirrors that shape.
			evidenceDueBy: null,
		});
		const body = await deadlines();
		expect(body.deadlines.find((r) => r.key === `dispute-evidence:${d.id}`)).toBeUndefined();
	});

	it("leaves a warning-needs-response dispute off the list — radar carries no evidence window", async () => {
		const p = await purchase({ buyer: otherBuyerId });
		const d = await dispute({
			purchaseId: p.id,
			userId: otherBuyerId,
			status: "warning_needs_response",
			evidenceDueBy: null,
		});
		const body = await deadlines();
		expect(body.deadlines.find((r) => r.key === `dispute-evidence:${d.id}`)).toBeUndefined();
	});
});
