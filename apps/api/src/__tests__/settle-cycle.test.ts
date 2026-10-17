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
 * ⭐ Figures are asserted against `timePoolFor` and `paymentsSplit` wherever the model
 * defines the answer, and the free tier's pool against the Fund's ledger — a copied number
 * drifts exactly the way the code it was copied from does.
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accountCycles,
	badgeCharges,
	badges,
	billingAccounts,
	creatorCredits,
	crfLedger,
	invoiceLines,
	invoices,
	monthSettlements,
	poolDistributions,
	stickers,
	timePoolFundLedger,
	userBadges,
} from "@anthers/db/schema";
import { PUBLIC_ACCESS_PRICE, timePoolFor } from "@anthers/shared/constants";
import { paymentsSplit } from "@anthers/shared/fees";
import { SHARE_LINK_POOL_FRACTION } from "@anthers/shared/public-access";
import { timePoolFundPool } from "@anthers/shared/time-pool-fund";
import Decimal from "decimal.js";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import app from "../index";
import { distributePool } from "../jobs/distribute-pool";
import { settleCycle } from "../jobs/settle-cycle";
import { createAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { insertAttentionRange } from "./attention-fixture.js";
import { purgeAccountIds, purgeAccountsCreatedHere } from "./cleanup";

await ensureAnthersLadder();
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

/**
 * 🚨 The Fund's slice for a cycle is read across EVERY supporter of that cycle
 * (`services/time-pool-fund.ts`), so one test's fixtures leak into the next test's
 * denominators. Each test starts from the accounts and books nothing else wrote:
 * the previous test's users are purged (which cascades their `account_cycles` rows),
 * their ledger markers go, and the Fund's rows for the suite's months are cleared —
 * a test publishes the Fund state its own fixtures mean.
 */
beforeEach(async () => {
	const ids = [...madeUserIds];
	madeUserIds.length = 0;
	for (const userId of ids) {
		await db.delete(crfLedger).where(like(crfLedger.description, `[settle u${userId} %`));
	}
	await purgeAccountIds(ids);
	await db.delete(timePoolFundLedger).where(inArray(timePoolFundLedger.billingCycle, [MONTH]));
});

afterAll(async () => {
	// The ledger rows reference no user, so they are found by the marker they carry; the month
	// markers reference nothing at all. Both go before the accounts do.
	for (const userId of madeUserIds) {
		await db.delete(crfLedger).where(like(crfLedger.description, `[settle u${userId} %`));
	}
	if (markedMonths.length > 0) {
		await db.delete(monthSettlements).where(inArray(monthSettlements.billingCycle, markedMonths));
	}
	await db.delete(timePoolFundLedger).where(inArray(timePoolFundLedger.billingCycle, [MONTH]));
});

async function makeUser(kind: string): Promise<number> {
	return (await makeUserWithCookie(kind)).userId;
}

async function makeUserWithCookie(kind: string) {
	n += 1;
	const account = await createAccount(`${tag}_${kind}_${n}`);
	madeUserIds.push(account.userId);
	return account;
}

/**
 * A supporter whose holdings read `today` — deliberately NOT what the month paid, so that a
 * settlement reading the holdings instead of the invoice is caught. The "amount today" is
 * the Anthers rung held this cycle under the Badge model; the fixture writes it the way the
 * billing write would.
 */
async function makeSupporter(today = 12) {
	const userId = await makeUser("supporter");
	const [acct] = await db
		.insert(billingAccounts)
		.values({
			userId,
			currentPeriodStart: new Date(`${MONTH}T00:00:00Z`),
			currentPeriodEnd: new Date("2031-06-01T00:00:00Z"),
			isActive: true,
		})
		.returning({ id: billingAccounts.id });
	await holdOrgRung(userId, today.toFixed(2), MONTH);
	return { userId, accountId: acct.id };
}

/**
 * Give a user the Anthers Badge at `threshold` in `cycle` — find-or-create the rung (the
 * Anthers creator account is the Free rung's owner), then write the holding, replacing
 * the Anthers ladder's other rungs that cycle. The settlement suite's stand-in for the
 * amount write the webhooks made.
 */
async function holdOrgRung(userId: number, threshold: string, cycle: string): Promise<void> {
	const anthersId = await ensureAnthersLadder();
	const [rung] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, threshold)))
		.limit(1);
	const badge =
		rung ??
		(
			await db
				.insert(badges)
				.values({
					creatorId: anthersId,
					threshold,
					label: `$${threshold}`,
					description: "A fixture rung the settlement suite holds.",
				})
				.returning({ id: badges.id })
		)[0];
	await db
		.delete(userBadges)
		.where(
			and(
				eq(userBadges.userId, userId),
				eq(userBadges.billingCycle, cycle),
				sql`${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${anthersId})`,
			),
		);
	if (Number(threshold) > 0) {
		await db.insert(userBadges).values({ userId, badgeId: badge.id, billingCycle: cycle });
	}
}

/**
 * Publish a Fund row for the test month as the mechanism would have: a settled book
 * of `foundation` dollars (the books the ledger's settled basis reads), a frozen
 * active count of `active`, and the pool and slice the shared arithmetic derives
 * from them. Settlement reads the cycle's slice through the ledger; this is the
 * fixture for it — the same one write `services/time-pool-fund.ts` makes.
 */
async function publishFundRow(activeFreeAccounts: number, foundation = 100): Promise<void> {
	const { userId } = await makeSupporter(0);
	await db.insert(accountCycles).values({
		userId,
		billingCycle: MONTH,
		foundation: foundation.toFixed(2),
	});
	await db.insert(timePoolFundLedger).values({
		billingCycle: MONTH,
		status: "actual",
		charitableRevenue: foundation.toFixed(2),
		adminBudgetShare: 0.3,
		freeAccessShare: 0.1,
		poolAmount: "0.00",
		activeFreeAccounts,
		slicePerAccount: "0.00",
		actualizedAt: new Date("2031-06-02T02:00:00Z"),
	});
}

/** The Fund's slice the ledger's arithmetic derives for MONTH — the tests' expected free pool. */
function fundSlice(activeFreeAccounts: number, foundation = 100): Decimal {
	return timePoolFundPool({
		charitableRevenue: foundation,
		adminBudgetShare: 0.3,
		freeAccessShare: 0.1,
		activeFreeAccounts,
		rootPool: timePoolFor(PUBLIC_ACCESS_PRICE),
	}).slice;
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
	await insertAttentionRange({
		userId,
		creatorId,
		eventType: "watch",
		seconds,
		publicAccess: opts.publicAccess ?? true,
		viaShareLink: opts.viaShareLink ?? false,
		endsAt: WATCHED_AT,
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
		// The Fund's published slice for the month ($1.40 from a $100 book, 5 active)
		// is the free pool the cycle carries; the supporter draws it, Stickers draw none.
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		await publishFundRow(5);
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
		expect(total(creator, "time_pool")).toBe(fundSlice(5).toFixed(2));
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
		// and the free pool credited first stays where it was. Under the Fund that first pool
		// is $0: the cycle had no paid Anthers revenue in it, so the Fund's slice was $0 —
		// the doctrine working, not a failure of credit.
		const late = rows.filter((r) => r.settledAt.getTime() === LATER.getTime());
		expect(late.map((r) => r.amount)).toEqual([new Decimal(timePoolFor(6)).toFixed(2)]);
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

		// Nothing was paid, so the Fund's slice for the cycle is $0 — nothing from the
		// refunded invoice, and nothing from a Fund no revenue funded.
		expect((await creditsFrom(userId)).total(creator, "time_pool")).toBe("0.00");
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
		// The Fund's slice is live here ($1.40 from a $100 book, 5 active), so this
		// exercises a free account drawing real Fund money — and books none of it as
		// income, spent or not: it is the charitable remainder's money both ways.
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(0);
		await publishFundRow(5);
		await watch(userId, creator, 1800);
		await distributePool({ accountId });

		await settle(userId);

		expect((await creditsFrom(userId)).total(creator, "time_pool")).toBe(
			fundSlice(5).toFixed(2),
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

	it("🚨 tells a creator whether their month is still an estimate", async () => {
		const creator = await makeUserWithCookie("creator");
		const { userId, accountId } = await makeSupporter(6);
		await watch(userId, creator.userId, 1800);
		await distributePool({ accountId });
		await paidInvoice(userId, { anthers: 6 });

		const earnings = async () => {
			const res = await app.fetch(
				new Request(`http://localhost/api/subscriptions/earnings?cycle=${MONTH}`, {
					headers: { Cookie: creator.cookie },
				}),
			);
			return (await res.json()) as { settled: boolean; poolTotal: string };
		};

		expect((await earnings()).settled).toBe(false);
		await settle(userId);
		expect(await earnings()).toMatchObject({ settled: true });
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

/**
 * The Badge purchase rail settles beside the invoices (2026-10-15). A Badge bought through
 * the basket is this month's support money on a Checkout charge with no invoice row — its
 * own record is `badge_charges`, its fee is the PINNED pro-rata share the charge apportioned
 * at checkout, and the credit the issuer receives is the charged amount net of that share:
 * never the model's recomputation, because the charge may also have carried Works whose
 * shares amortized the flat fee with it.
 *
 * 🚨 **The invariant the cases below exist for is double rail accounting**: a badge line's
 * money must be credited exactly once, from ITS OWN charge's figures — not folded into an
 * invoice's split (where its presence would change the model's anthers share) and not
 * double-counted beside the holdings the estimate may already have credited.
 */
describe("settling the Badge purchase rail beside the invoices", () => {
	/** A completed Badge first transaction, as checkout's completion left it. */
	async function badgeCharge(
		userId: number,
		creatorId: number,
		opts: {
			charged: number;
			threshold: number;
			/** The pinned share of the charge's ONE card fee, as checkout wrote it. */
			feeShare: number;
			status?: string;
			cycle?: string;
		} = { charged: 6, threshold: 6, feeShare: 0.48 },
	) {
		await db.insert(badgeCharges).values({
			buyerId: userId,
			badgeId: null,
			creatorId,
			badgeLabel: "Sprout",
			threshold: opts.threshold.toFixed(2),
			chargedAmount: opts.charged.toFixed(2),
			processingFee: opts.feeShare.toFixed(2),
			salesTax: "0.00",
			billingCycle: opts.cycle ?? MONTH,
			stripePaymentIntentId: `pi_EXAMPLE_${crypto.randomUUID().slice(0, 10)}`,
			status: opts.status ?? "completed",
		});
	}

	it("🚨 credits a badge-only month net of the PINNED fee share — charged once, from the row", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		// The account's $6 Anthers rung is held, but the month's only paid money is a Badge
		// bought through the basket: charged $6.00, pinned fee $0.48, and settled net.
		await badgeCharge(userId, creator, { charged: 6, threshold: 6, feeShare: 0.48 });
		// The Sticker is the observable paid-ness: the allowance opens on a month
		// something was collected, whatever rail carried it.
		await db.insert(stickers).values({
			giverId: userId,
			creatorId: creator,
			subjectType: "work",
			subjectId: 1,
			billingCycle: MONTH,
			amount: "1.00",
		});
		await watch(userId, creator, 1800);
		await distributePool({ accountId });

		await settle(userId);

		const { rows, total } = await creditsFrom(userId);
		expect(total(creator, "support")).toBe("5.52");
		expect(total(creator, "sticker")).toBe("1.00");
		// The estimate credited the FULL threshold gross (its model has no checkout rail
		// to read); settlement recomputed from the charge and the month carries a
		// support row of its own — one, from one charge.
		expect(rows.filter((r) => r.kind === "support")).toHaveLength(1);
	});

	it("settles an invoice and a badge charge side by side, each charge's fee its own", async () => {
		const creatorA = await makeUser("creator");
		const creatorB = await makeUser("creator");
		const { userId } = await makeSupporter(6);
		await paidInvoice(userId, { anthers: 6, directed: [{ creatorId: creatorA, amount: 4 }] });
		// The badge rode a mixed basket, so its pinned share is a fraction of the charge's
		// total fee — smaller than a lone-charge model fee on $6 by the amortized part.
		await badgeCharge(userId, creatorB, { charged: 6, threshold: 6, feeShare: 0.24 });
		await watch(userId, creatorA, 1800);

		await settle(userId);

		const { total } = await creditsFrom(userId);
		// The invoice's creator share, from the model — an invoice carries no pinned fee.
		expect(total(creatorA, "support")).toBe(
			new Decimal(4).minus(paymentsSplit(6, 4).creator).toFixed(2),
		);
		// The badge charge's creator share, from its PINS — not paymentsSplit(0, 6),
		// whose $0.48 model fee would overstate by the amortization the works beside it
		// paid for.
		expect(total(creatorB, "support")).toBe("5.76");
		// Anthers' remainder is booked per charge: the invoice's own minus the free pool —
		// the badge charge contributes nothing to the remainder (its whole pinned fee went
		// to its creator), which is why it is NOT paymentsSplit(6, 10)'s anthers share.
		const remainder = new Decimal(6)
			.minus(timePoolFor(6))
			.minus(paymentsSplit(6, 4).anthers)
			.toFixed(2);
		expect(await inflowFrom(userId)).toBe(remainder);

		// And the badge-only charge leaves no invoice row to stamp — the settled stamp
		// touches only the invoice-backed charges.
		const stamped = await db
			.select({ settledAt: invoices.settledAt })
			.from(invoices)
			.where(eq(invoices.userId, userId));
		expect(stamped).toHaveLength(1);
		expect(stamped[0].settledAt).not.toBeNull();
	});

	it("ignores a badge charge still pending — a built checkout is not money", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		await badgeCharge(userId, creator, {
			charged: 6,
			threshold: 6,
			feeShare: 0.48,
			status: "pending",
		});
		// The Sticker is where a month's paid-ness shows: an uncollected badge row must
		// not open the allowance, exactly as an uncollected renewal does not.
		await db.insert(stickers).values({
			giverId: userId,
			creatorId: creator,
			subjectType: "work",
			subjectId: 1,
			billingCycle: MONTH,
			amount: "1.00",
		});
		await watch(userId, creator, 1800);
		await distributePool({ accountId });

		await settle(userId);

		// Nothing was paid on this rail — the buyer left the tab at the Pay screen.
		expect((await creditsFrom(userId)).total(creator, "support")).toBe("0.00");
		expect((await creditsFrom(userId)).total(creator, "sticker")).toBe("0.00");
	});

	it("is idempotent — a badge charge settles once, like an invoice", async () => {
		const creator = await makeUser("creator");
		const { userId, accountId } = await makeSupporter(6);
		await badgeCharge(userId, creator, { charged: 6, threshold: 6, feeShare: 0.48 });
		await watch(userId, creator, 1800);
		await distributePool({ accountId });

		await settle(userId);
		const first = await creditsFrom(userId);
		await settle(userId, LATER);

		const second = await creditsFrom(userId);
		expect(second.rows).toHaveLength(first.rows.length);
		expect(second.total(creator, "support")).toBe("5.52");
	});
});
