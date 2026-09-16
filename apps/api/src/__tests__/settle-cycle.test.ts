// SPDX-License-Identifier: Apache-2.0
/**
 * Settlement — a month's money credited once, after it ends, from the invoices paid for it.
 *
 * 🚨 **The defect this suite exists for is money credited that nobody paid.** The nightly
 * distribution credited a whole month's Time Pool from its first night whether or not the renewal
 * was ever collected, and settled against the account's Badge today rather than the one the month
 * was paid at. Every case below therefore sets the account's amount today to something the month
 * did NOT pay, so a settlement reading the account instead of the invoice fails here.
 *
 * ⚠️ **Each run is scoped to one supporter**, because a settlement run finds every unsettled
 * month in the database and this suite shares its database with every other suite in the run.
 *
 * ⭐ Figures are asserted against `timePoolFor`, `paymentsSplit` and `FREE_TIME_POOL` wherever the
 * model defines the answer — a copied number drifts exactly the way the code it was copied from
 * does.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accounts,
	attentionEvents,
	creatorCredits,
	crfLedger,
	invoiceLines,
	invoices,
	monthSettlements,
	poolDistributions,
	stickers,
} from "@anthers/db/schema";
import { FREE_TIME_POOL, timePoolFor } from "@anthers/shared/constants";
import { paymentsSplit } from "@anthers/shared/fees";
import { SHARE_LINK_POOL_FRACTION } from "@anthers/shared/public-access";
import Decimal from "decimal.js";
import { and, eq, inArray, like } from "drizzle-orm";
import { distributePool } from "../jobs/distribute-pool";
import { settleCycle } from "../jobs/settle-cycle";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

/** A month far enough out that it cannot collide with fixture or dev data. */
const MONTH = "2031-05-01";
const WATCHED_AT = new Date("2031-05-15T12:00:00Z");
/** Inside the month, when nothing may settle yet. */
const DURING = new Date("2031-05-20T02:00:00Z");
/** The run on the 2nd after the month ends. */
const AFTER = new Date("2031-06-02T02:00:00Z");
/** A later run, as the one that settles an invoice paid late in Stripe's retries. */
const LATER = new Date("2031-07-02T02:00:00Z");

const tag = `sc_${Date.now().toString(36)}`;
const madeUserIds: number[] = [];
const markedMonths: string[] = [];
let n = 0;

afterAll(async () => {
	// The ledger rows reference no user, so they are found by the marker they carry; the month
	// markers reference nothing at all. Both go before the accounts do.
	for (const userId of madeUserIds) {
		await db.delete(crfLedger).where(like(crfLedger.description, `[settle u${userId} %`));
	}
	if (markedMonths.length > 0) {
		await db.delete(monthSettlements).where(inArray(monthSettlements.billingCycle, markedMonths));
	}
});

async function makeUser(kind: string): Promise<number> {
	n += 1;
	const { userId } = await createAccount(`${tag}_${kind}_${n}`);
	madeUserIds.push(userId);
	return userId;
}

/**
 * A supporter whose account reads `today` — deliberately NOT what the month paid, so that a
 * settlement reading the account rather than the invoice is caught.
 */
async function makeSupporter(today = 12) {
	const userId = await makeUser("supporter");
	const [acct] = await db
		.insert(accounts)
		.values({
			userId,
			anthersSupport: today.toFixed(2),
			currentPeriodStart: new Date(`${MONTH}T00:00:00Z`),
			currentPeriodEnd: new Date("2031-06-01T00:00:00Z"),
			isActive: true,
		})
		.returning({ id: accounts.id });
	return { userId, accountId: acct.id };
}

/** A paid invoice for the month, with its lines, as the webhook would have recorded it. */
async function paidInvoice(
	userId: number,
	opts: {
		anthers?: number;
		directed?: { creatorId: number; amount: number }[];
		fee?: number;
		status?: string;
		month?: string;
	} = {},
) {
	const anthers = opts.anthers ?? 6;
	const directed = opts.directed ?? [];
	const subtotal = directed.reduce((s, d) => s + d.amount, anthers);
	const [row] = await db
		.insert(invoices)
		.values({
			userId,
			stripeInvoiceId: `in_EXAMPLE_${crypto.randomUUID().slice(0, 12)}`,
			billingCycle: opts.month ?? MONTH,
			status: opts.status ?? "paid",
			subtotal: subtotal.toFixed(2),
			total: subtotal.toFixed(2),
			processingFee: (
				opts.fee ?? paymentsSplit(anthers, subtotal - anthers).total.toNumber()
			).toFixed(2),
			paidAt: new Date("2031-05-01T03:00:00Z"),
		})
		.returning({ id: invoices.id });
	await db.insert(invoiceLines).values([
		...(anthers > 0 ? [{ invoiceId: row.id, creatorId: null, amount: anthers.toFixed(2) }] : []),
		...directed.map((d) => ({
			invoiceId: row.id,
			creatorId: d.creatorId,
			amount: d.amount.toFixed(2),
		})),
	]);
	return row.id;
}

async function watch(
	userId: number,
	creatorId: number,
	seconds: number,
	opts: { publicAccess?: boolean; viaShareLink?: boolean } = {},
) {
	await db.insert(attentionEvents).values({
		userId,
		creatorId,
		eventType: "watch",
		durationSeconds: seconds,
		publicAccess: opts.publicAccess ?? true,
		viaShareLink: opts.viaShareLink ?? false,
		createdAt: WATCHED_AT,
	});
}

/** What has been credited to each creator from this supporter's month, by kind. */
async function creditsFrom(userId: number) {
	const rows = await db
		.select()
		.from(creatorCredits)
		.where(and(eq(creatorCredits.subscriberId, userId), eq(creatorCredits.billingCycle, MONTH)));
	const total = (creatorId: number, kind: string) =>
		rows
			.filter((r) => r.creatorId === creatorId && r.kind === kind)
			.reduce((sum, r) => sum.plus(r.amount), new Decimal(0))
			.toFixed(2);
	return { rows, total };
}

/** Everything settlement booked to the charitable ledger for this supporter's month. */
async function inflowFrom(userId: number): Promise<string> {
	const rows = await db
		.select({ amount: crfLedger.amount })
		.from(crfLedger)
		.where(like(crfLedger.description, `[settle u${userId} ${MONTH}]%`));
	return rows.reduce((sum, r) => sum.plus(r.amount), new Decimal(0)).toFixed(2);
}

/** A $6 month's own remainder: what it gave, less its Time Pool and Anthers' share of the fee. */
function ownRemainder(anthers: number, directed = 0): Decimal {
	const split = paymentsSplit(anthers, directed);
	return new Decimal(anthers).minus(timePoolFor(anthers)).minus(split.anthers);
}

const settle = (userId: number, now: Date = AFTER) => settleCycle({ userId, now });

describe("settling a month from what was paid for it", () => {
	it("🚨 credits the month the invoice paid for, not the account's amount today", async () => {
		const creatorA = await makeUser("creator");
		const creatorB = await makeUser("creator");
		const { userId } = await makeSupporter(12);
		await paidInvoice(userId, { anthers: 6, directed: [{ creatorId: creatorA, amount: 4 }] });
		await watch(userId, creatorB, 1800);

		await settle(userId);

		const { total } = await creditsFrom(userId);
		expect(total(creatorB, "time_pool")).toBe(new Decimal(timePoolFor(6)).toFixed(2));
		expect(total(creatorA, "support")).toBe(
			new Decimal(4).minus(paymentsSplit(6, 4).creator).toFixed(2),
		);
	});

	it("credits nothing while the month is still running", async () => {
		const creator = await makeUser("creator");
		const { userId } = await makeSupporter(6);
		await paidInvoice(userId, { anthers: 6 });
		await watch(userId, creator, 1800);

		await settle(userId, DURING);

		expect((await creditsFrom(userId)).rows).toHaveLength(0);
	});

	it("🚨 credits only the free Time Pool for a month nothing was paid for, and pays no Stickers", async () => {
		// The renewal failed and never cleared. The estimate credited this supporter's whole $6
		// pool and their Sticker from the first night; none of it was ever collected.
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		await watch(userId, creator, 1800);
		await db.insert(stickers).values({
			giverId: userId,
			creatorId: creator,
			subjectType: "work",
			subjectId: 1,
			billingCycle: MONTH,
			amount: "1.00",
		});
		await distributePool({ accountId });

		await settle(userId);

		const { rows, total } = await creditsFrom(userId);
		expect(total(creator, "time_pool")).toBe(new Decimal(FREE_TIME_POOL).toFixed(2));
		expect(total(creator, "sticker")).toBe("0.00");
		expect(rows.every((r) => r.fundedBy === "anthers")).toBe(true);
		// Nobody paid, so nothing is income.
		expect(await inflowFrom(userId)).toBe("0.00");
	});

	it("🚨 settles an invoice paid late in a later run, adding only the difference", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		await watch(userId, creator, 1800);
		await distributePool({ accountId });
		await settle(userId, AFTER);

		// The September renewal clears in October's retries, and is recorded against September.
		await paidInvoice(userId, { anthers: 6 });
		await settle(userId, LATER);

		const { rows, total } = await creditsFrom(userId);
		expect(total(creator, "time_pool")).toBe(new Decimal(timePoolFor(6)).toFixed(2));
		// The late money is its own row with its own settlement time, so its hold starts then —
		// and the free pool credited first stays where it was.
		const late = rows.filter((r) => r.settledAt.getTime() === LATER.getTime());
		expect(late.map((r) => r.amount)).toEqual([
			new Decimal(timePoolFor(6)).minus(FREE_TIME_POOL).toFixed(2),
		]);
		expect(await inflowFrom(userId)).toBe(ownRemainder(6).toFixed(2));
	});

	it("writes nothing when a run finds a settled month again", async () => {
		const creator = await makeUser("creator");
		const other = await makeUser("creator");
		const { userId } = await makeSupporter(6);
		await paidInvoice(userId, { anthers: 6 });
		await watch(userId, creator, 1800);

		await settle(userId);
		const first = await creditsFrom(userId);
		// An estimate row appearing after settlement — a period that never advanced — brings the
		// supporter back into the next run, which must recompute the month and find nothing owed.
		await db
			.insert(poolDistributions)
			.values({ subscriberId: userId, creatorId: other, billingCycle: MONTH, poolAmount: "1.00" });
		await settle(userId, LATER);

		expect((await creditsFrom(userId)).rows).toHaveLength(first.rows.length);
		const ledger = await db
			.select()
			.from(crfLedger)
			.where(like(crfLedger.description, `[settle u${userId} ${MONTH}]%`));
		expect(ledger).toHaveLength(1);
	});

	it("never credits a refunded invoice", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		await paidInvoice(userId, { anthers: 6, status: "refunded" });
		await watch(userId, creator, 1800);
		await distributePool({ accountId });

		await settle(userId);

		expect((await creditsFrom(userId)).total(creator, "time_pool")).toBe(
			new Decimal(FREE_TIME_POOL).toFixed(2),
		);
	});
});

describe("the remainder", () => {
	it("books a $3 month's own remainder however much of it was watched", async () => {
		// Hand-computed: $3.00 − $1.50 Time Pool − $0.39 card fee = $1.11. A heavy streamer's
		// Public Access time moves where the pool goes, never how much of the $3 is Anthers'.
		const creator = await makeUser("creator");
		const { userId } = await makeSupporter(12);
		await paidInvoice(userId, { anthers: 3 });
		await watch(userId, creator, 120 * 3600);

		await settle(userId);

		expect(await inflowFrom(userId)).toBe("1.11");
	});

	it("🚨 books the WHOLE pool to the remainder when the supporter streamed no Public Access", async () => {
		const creator = await makeUser("creator");
		const { userId } = await makeSupporter(12);
		await paidInvoice(userId, { anthers: 6 });
		await watch(userId, creator, 1800, { publicAccess: false });

		await settle(userId);

		expect(await inflowFrom(userId)).toBe(ownRemainder(6).plus(timePoolFor(6)).toFixed(2));
	});

	it("🚨 books a Sticker as paid, never as a pool that reached nobody", async () => {
		const creator = await makeUser("creator");
		const { userId } = await makeSupporter(12);
		await paidInvoice(userId, { anthers: 12 });
		await watch(userId, creator, 1800);
		await db.insert(stickers).values({
			giverId: userId,
			creatorId: creator,
			subjectType: "work",
			subjectId: 1,
			billingCycle: MONTH,
			amount: "1.00",
		});

		await settle(userId);

		expect((await creditsFrom(userId)).total(creator, "sticker")).toBe("1.00");
		expect(await inflowFrom(userId)).toBe(ownRemainder(12).toFixed(2));
	});

	it("🚨 books only the part a share-link ceiling left behind", async () => {
		const creator = await makeUser("creator");
		const { userId } = await makeSupporter(6);
		await paidInvoice(userId, { anthers: 12 });
		await watch(userId, creator, 3600, { viaShareLink: true });

		await settle(userId);

		const pool = new Decimal(timePoolFor(12));
		const slice = pool.mul(SHARE_LINK_POOL_FRACTION).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
		expect(await inflowFrom(userId)).toBe(ownRemainder(12).plus(pool.minus(slice)).toFixed(2));
	});

	it("🚨 lets creators bear the model's card fee, and the remainder absorb what Stripe took beyond it", async () => {
		// Stripe charged 15¢ more than the model — the fee on the sales tax, say. A creator is
		// credited what their take-home display showed them, and Anthers absorbs the difference.
		const creator = await makeUser("creator");
		const { userId } = await makeSupporter(12);
		const model = paymentsSplit(6, 4);
		await paidInvoice(userId, {
			anthers: 6,
			directed: [{ creatorId: creator, amount: 4 }],
			fee: model.total.plus(0.15).toNumber(),
		});
		await watch(userId, creator, 1800, { publicAccess: false });

		await settle(userId);

		expect((await creditsFrom(userId)).total(creator, "support")).toBe(
			new Decimal(4).minus(model.creator).toFixed(2),
		);
		expect(await inflowFrom(userId)).toBe(
			ownRemainder(6, 4).minus(0.15).plus(timePoolFor(6)).toFixed(2),
		);
	});

	it("books no income from a free account's pool, spent or not", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(0);
		await watch(userId, creator, 1800);
		await distributePool({ accountId });

		await settle(userId);

		expect((await creditsFrom(userId)).total(creator, "time_pool")).toBe(
			new Decimal(FREE_TIME_POOL).toFixed(2),
		);
		expect(await inflowFrom(userId)).toBe("0.00");
	});
});

describe("the month's rows and its marker", () => {
	it("makes the distribution rows final, and the nightly estimate never writes over them", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(12);
		await watch(userId, creator, 1800);
		// The estimate credits the $12 the account reads today …
		await distributePool({ accountId });
		// … while the month was paid at $6.
		await paidInvoice(userId, { anthers: 6 });

		await settle(userId);
		// The account's period never advanced, so the nightly job still points at the month.
		await distributePool({ accountId });

		const [row] = await db
			.select()
			.from(poolDistributions)
			.where(
				and(
					eq(poolDistributions.subscriberId, userId),
					eq(poolDistributions.creatorId, creator),
					eq(poolDistributions.billingCycle, MONTH),
				),
			);
		expect(row.settledAt).not.toBeNull();
		expect(new Decimal(row.poolAmount).toFixed(2)).toBe(new Decimal(timePoolFor(6)).toFixed(2));
	});

	it("marks a month settled on a full run, and a scoped run marks nothing", async () => {
		// A month of its own, early enough that a full run finds nothing else unsettled before it.
		const month = "2020-01-01";
		markedMonths.push(month);
		const { userId } = await makeSupporter(6);
		await paidInvoice(userId, { anthers: 6, month });
		const inFebruary = new Date("2020-02-02T02:00:00Z");

		await settleCycle({ userId, now: inFebruary });
		expect(
			await db.select().from(monthSettlements).where(eq(monthSettlements.billingCycle, month)),
		).toHaveLength(0);

		await settleCycle({ now: inFebruary });
		const [marker] = await db
			.select()
			.from(monthSettlements)
			.where(eq(monthSettlements.billingCycle, month));
		expect(marker?.settledAt.getTime()).toBe(inFebruary.getTime());
	});
});
