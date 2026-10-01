// SPDX-License-Identifier: Apache-2.0
/**
 * The monthly close package — the Books section's third tool, and the reason the subledger
 * exists (the bookkeeping decision, 2026-09-15): Anthers' own database is the subledger,
 * QuickBooks Online is the general ledger, and what passes between them each month is one
 * summary journal entry plus the schedules that tie every figure back to the invoices,
 * purchases, settlements and refunds that produced it. Nothing here writes to QuickBooks
 * Online through any API — the export is a CSV a person posts by hand, deliberately.
 *
 * 🚨 **The defect this package exists to prevent, in the decision's own terms:** booking
 * creators' money as Anthers' own revenue or spending. Creator-directed support and Work
 * purchases are a liability to the creator and never touch the profit and loss; Badge money
 * is program-service revenue; Time Pool distributions are a program-service expense. The
 * account names below are transcribed from the decision's entry table exactly.
 *
 * ⚠️ **A sibling of `books.ts` rather than an extension of it.** The worksheet and the
 * forecast are about tax exposure; this is the books themselves, and its docblock carries
 * the judgment calls the decision's entry table does not name. `rowsOf` is shared.
 *
 * The judgment calls, each made because the decision's table names the accounts but not the
 * arithmetic:
 *
 * 1. **A purchase never moves Due to creators.** The destination charge sent the creator's
 *    share straight to the creator's own Stripe balance, where it is already theirs — Anthers
 *    never held it, so no liability arises. The purchase debits Stripe clearing for Anthers'
 *    share only (the tax plus the fee figures the row recorded — `amount − creator_earnings`
 *    is the platform side of the price), and the fee is CREDITED against payment processing
 *    expense rather than debited: creators bear card processing at cost, so the profit and
 *    loss carries only Anthers' own processing, never a creator's. The Due-to-creators
 *    control confirms the treatment — purchases write no `creator_credits` rows, and the
 *    liability ties to those rows alone.
 *    ⚠️ This is the one place this module departs from the decision's entry table, which
 *    lists "due to creators" in a purchase's credit column. Taken literally that cell does
 *    not balance against the table's own debit ("Stripe clearing, Anthers' share only" —
 *    the platform side of the price plus tax — versus a credit of the creator's whole
 *    share), and booking it would make the reconciliation control disagree with the
 *    `creator_credits` rows permanently. The departure is recorded in the task note.
 *
 * 2. **The settlement bridges gross to net through the processing expense account.** The
 *    invoice event credits Support collected not yet settled with the creator lines gross;
 *    settlement credits Due to creators net of the creator-borne share of card processing,
 *    which is how `settle-cycle` writes `creator_credits`. The difference is credited back
 *    to payment processing expense, so Anthers' processing expense ends at its own share of
 *    the fee and a creator's share never inflates it.
 *
 * 3. **The charitable ledger draws no journal line.** Badge revenue already books the
 *    supporter's whole Anthers line and the Time Pool expense debits against it, so a
 *    remainder line would double-count; the `crf_ledger` movements are carried in the
 *    settlement schedule as supporting detail instead. The Anthers-funded free Time Pool —
 *    a free account's pool, Anthers' own money spent on their behalf — is a genuine
 *    program-service expense against that same revenue, booked on its own line so the two
 *    fundings never blur.
 *
 * 4. **Paused renewals are held, not booked.** A paused renewal was charged on the card but
 *    credits nobody while the suspension stands, and `resumePausedRenewals` re-keys it to
 *    `paid` at reinstatement — booking it here would leave its relief stranded in whatever
 *    month this package closed. It appears in the invoice schedule, and the tax worksheet
 *    counts its tax; a note says the books wait for the re-key.
 *
 * 5. **The clearing control is entry-implied and cannot be verified from these rows.**
 *    Anthers records nothing about what Stripe's dashboard reports, so the package states
 *    the balance its own lines imply and the operator reconciles against Stripe's number by
 *    hand. The implied figure debits the platform side of each purchase gross of the fee
 *    Stripe deducts from the platform balance, so it runs above the dashboard by the
 *    accumulated purchase-side fee figures — the first live reconciliation will size that
 *    gap, and the note says so rather than hiding it.
 *
 * 6. **The Due-to-creators control compares the entries against the `creator_credits`
 *    rows**, the schema's own definition of a creator's balance: credits not yet
 *    transferred, and no transfer job exists, so today that is every row. It fails plainly
 *    when the two disagree, and the note names the two causes a difference can have —
 *    settlement rows for cycles after the month being closed (regenerating an old package),
 *    and a settled invoice refunded while its ledger credits still stand, which is the
 *    reversal build the 2026-09-14 decision left open.
 *
 * ⚠️ **Read-only.** Nothing here writes; the rows it reads are written by the checkout
 * webhook (`purchases`), `services/invoices.ts` (`invoices`), `jobs/settle-cycle.ts`
 * (`creator_credits`, `month_settlements`, `crf_ledger`) and `services/refunds.ts`, and
 * reaching around them is the bug the one-writer rule names.
 */

import { db } from "@anthers/db/client";
import { crfLedger, invoiceLines } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { inArray, sql } from "drizzle-orm";
import { parseFilingPeriod, rowsOf } from "./books.js";

const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const D = (v: unknown) => new Decimal(v == null || v === "" ? 0 : (v as string));
const money = (d: Decimal) => CENTS(d).toFixed(2);
const ZERO = new Decimal(0);

/** One journal line, as a person checks it and as the CSV export carries it. */
export interface ClosePackageLine {
	/** The event that produced the line, transcribed from the decision's entry table. */
	event: string;
	/** The decision's account name, transcribed exactly. */
	account: string;
	debit: string;
	credit: string;
	memo: string;
	/** What separates genuinely different money under the same event and account. */
	key?: string;
	/** An event with no supporting rows yet — shown at zero, never invented, never exported. */
	unbuilt?: boolean;
}

export interface InvoiceScheduleRow {
	id: number;
	stripeInvoiceId: string;
	status: string;
	subtotal: string;
	tax: string;
	total: string;
	processingFee: string;
	discount: string;
	/** The creator-directed lines, gross. */
	creatorLines: string;
	/** The Badge (Anthers) line, as the residual of the subtotal. */
	anthersLine: string;
	settled: boolean;
	paidAt: string | null;
}

export interface PurchaseScheduleRow {
	id: number;
	type: string;
	amount: string;
	salesTax: string;
	processingFee: string;
	deliveryFee: string;
	creatorEarnings: string;
	status: string;
	createdAt: string;
	refundedAt: string | null;
}

/** Settlement's credits for the month, grouped the way the books read them. */
export interface CreditGroupRow {
	kind: string;
	fundedBy: string;
	count: number;
	total: string;
}

/** A `crf_ledger` movement — supporting detail for the schedules, never a journal line. */
export interface LedgerRow {
	id: number;
	amount: string;
	description: string;
	createdAt: string;
}

export interface ClosePackage {
	period: { key: string; label: string; cycle: string; settledAt: string };
	/** True when the settled month holds no charge, no settlement and no purchase at all. */
	empty: boolean;
	entry: {
		lines: ClosePackageLine[];
		totalDebits: string;
		totalCredits: string;
		balanced: boolean;
	};
	schedules: {
		invoices: {
			rows: InvoiceScheduleRow[];
			count: number;
			totals: {
				subtotal: string;
				tax: string;
				total: string;
				processingFee: string;
				creatorLines: string;
				anthersLine: string;
			};
		};
		purchases: {
			rows: PurchaseScheduleRow[];
			count: number;
			totals: {
				amount: string;
				salesTax: string;
				processingFee: string;
				deliveryFee: string;
				creatorEarnings: string;
			};
		};
		settlement: {
			credits: CreditGroupRow[];
			remainder: LedgerRow[];
			refundShortfalls: LedgerRow[];
		};
	};
	controls: {
		stripeClearing: {
			monthMovement: string;
			/** Everything the recorded rows imply, from the first row through this period. */
			impliedBalance: string;
			/** Always false: Anthers' rows cannot verify Stripe's own reported balance. */
			verifiable: boolean;
			note: string;
		};
		dueToCreators: {
			opening: string;
			movement: string;
			implied: string;
			/** The sum of creator balances in Anthers' database — every `creator_credits` row. */
			expected: string;
			difference: string;
			pass: boolean;
			note: string;
		};
	};
	notes: string[];
}

export type ClosePackageResult =
	| { ok: true; package: ClosePackage }
	| { ok: false; code: "bad_period" | "not_settled"; error: string };

/** The events the decision's table names whose builds do not exist yet, with the why. */
const UNBUILT_EVENTS: { event: string; account: string; memo: string }[] = [
	{
		event: "A transfer reaches a creator's balance, 14 days later",
		account: "Due to creators",
		memo: "No transfer job exists yet — nothing records a transfer — so this line stays zero until the 2026-09-14 collect-and-pay-out decision's transfer build lands.",
	},
	{
		event: "Stripe's payout fees are recharged to a creator",
		account: "Stripe clearing",
		memo: "No recharge path exists yet, so this line stays zero until the payout-fee recharge is built.",
	},
	{
		event: "A refund or chargeback",
		account: "Dispute fees",
		memo: "Refunds are recorded, but no dispute webhook exists — there are no dispute rows and no dispute fees anywhere in Anthers' database — so the dispute half of this line and the Dispute fees account stay zero.",
	},
	{
		event: "Stripe pays out to the operating bank",
		account: "Operating bank",
		memo: "Anthers' rows record nothing about Stripe's payouts to the bank, so this line stays zero; the payout is what the operator sees on Stripe's dashboard when reconciling the clearing control.",
	},
];

/** What the package always says, carried to the screen verbatim like the worksheet's notes. */
const BOUNDARY_NOTES = [
	"Creator-directed support and Work purchases are a liability to the creator and never touch the profit and loss; Badge money is program-service revenue; Time Pool distributions are a program-service expense.",
	"The 14-day transfer to a creator's balance, the payout-fee recharge and chargeback handling are not built yet, from the 2026-09-14 decision on collecting and paying out — those lines are shown at zero and the omission closes when those jobs land.",
	"Paused renewals were charged on the card but credit nobody while the suspension stands; they enter the books when reinstatement re-keys them to paid, so their tax appears on the sales-tax worksheet before it appears here.",
	"An account name must already exist in QuickBooks Online's chart of accounts before the line imports — the CSV cannot create it.",
	"Nothing in this package writes to QuickBooks Online through any API, deliberately: the export is a CSV a person posts by hand (Settings → Import Data → Journal Entries).",
] as const;

/**
 * Assemble the close package for one settled month, named as `2026-09`. A month that has not
 * settled is refused rather than estimated, because `month_settlements` is the explicit
 * state the 2026-09-14 decision settled on and an estimated close would state creator
 * balances the settlement run has not written.
 */
export async function closePackage(rawPeriod: string): Promise<ClosePackageResult> {
	const period = parseFilingPeriod(rawPeriod);
	if (!period || period.kind !== "month") {
		return {
			ok: false,
			code: "bad_period",
			error: "Name the close period as a month (2026-09) — the package closes one settled month at a time.",
		};
	}

	const cycle = `${period.start.getUTCFullYear()}-${String(period.start.getUTCMonth() + 1).padStart(2, "0")}-01`;
	const start = period.start.toISOString();
	const end = period.end.toISOString();

	const [marker] = rowsOf<{ settled_at: string }>(
		await db.execute(sql`
			SELECT settled_at FROM month_settlements WHERE billing_cycle = ${cycle} LIMIT 1
		`),
	);
	if (!marker) {
		return {
			ok: false,
			code: "not_settled",
			error: `${period.label} has not settled yet. Settlement runs on the 2nd after a month ends, and the close package refuses to estimate an unsettled month.`,
		};
	}
	const settledAt = new Date(marker.settled_at).toISOString();

	// ── The rows ───────────────────────────────────────────────────────────────────
	// Every money event is keyed to the month it belongs to: invoices and settlement by
	// `billing_cycle` (the month the invoice PAYS FOR — the worksheet's own rule), purchases
	// by `created_at`, purchase refunds by `refunded_at` (a refund reverses money in the
	// month it returns it, which is not always the month of the sale).
	const invoiceRows = rowsOf<{
		id: number;
		stripe_id: string;
		status: string;
		subtotal: string;
		tax: string;
		total: string;
		processing_fee: string;
		discount: string;
		settled_at: string | null;
		paid_at: string | null;
	}>(
		await db.execute(sql`
			SELECT
				id,
				stripe_invoice_id AS stripe_id,
				status,
				subtotal,
				tax,
				total,
				processing_fee,
				discount,
				settled_at,
				paid_at
			FROM invoices
			WHERE billing_cycle = ${cycle}
				AND status IN ('paid', 'paused', 'refunded', 'disputed')
			ORDER BY id
		`),
	);

	const lineRows = invoiceRows.length
		? await db
				.select({
					invoiceId: invoiceLines.invoiceId,
					creatorId: invoiceLines.creatorId,
					amount: invoiceLines.amount,
				})
				.from(invoiceLines)
				.where(
					inArray(
						invoiceLines.invoiceId,
						invoiceRows.map((r) => r.id),
					),
				)
		: [];

	// Per invoice: the creator-directed lines gross, and the Badge line as the residual of
	// the subtotal — the Anthers line is whatever the charge was not directed at, which is
	// how `recordPaidInvoice` splits it and what makes the entry balance by construction.
	const creatorByInvoice = new Map<number, Decimal>();
	for (const line of lineRows) {
		if (line.creatorId == null) continue;
		creatorByInvoice.set(
			line.invoiceId,
			(creatorByInvoice.get(line.invoiceId) ?? ZERO).plus(D(line.amount)),
		);
	}
	const creatorOf = (id: number) => creatorByInvoice.get(id) ?? ZERO;
	const anthersOf = (row: (typeof invoiceRows)[number]) =>
		D(row.subtotal).minus(creatorOf(row.id));

	// The purchases charged in the month — `completed`, plus `refunded` rows whose charge
	// happened in this month (their refund is a separate event below, so the pair nets).
	const purchaseRows = rowsOf<{
		id: number;
		type: string;
		amount: string;
		sales_tax: string;
		processing_fee: string;
		delivery_fee: string;
		creator_earnings: string;
		status: string;
		created_at: string;
	}>(
		await db.execute(sql`
			SELECT
				id, type, amount, sales_tax, processing_fee, delivery_fee,
				creator_earnings, status, created_at
			FROM purchases
			WHERE status IN ('completed', 'refunded')
				AND created_at >= ${start}::timestamptz
				AND created_at < ${end}::timestamptz
			ORDER BY id
		`),
	);

	const refundedPurchases = rowsOf<{
		id: number;
		sales_tax: string;
		processing_fee: string;
		delivery_fee: string;
		downloaded_at: string | null;
		refunded_at: string | null;
	}>(
		await db.execute(sql`
			SELECT id, sales_tax, processing_fee, delivery_fee, downloaded_at, refunded_at
			FROM purchases
			WHERE status = 'refunded'
				AND refunded_at >= ${start}::timestamptz
				AND refunded_at < ${end}::timestamptz
			ORDER BY id
		`),
	);

	const creditGroups = rowsOf<{
		kind: string;
		funded_by: string;
		n: number;
		total: string;
	}>(
		await db.execute(sql`
			SELECT
				kind,
				funded_by,
				count(*)::int AS n,
				COALESCE(sum(amount), 0)::numeric(14, 2)::text AS total
			FROM creator_credits
			WHERE billing_cycle = ${cycle}
			GROUP BY kind, funded_by
			ORDER BY kind, funded_by
		`),
	);

	// The Due-to-creators control's ledger side: every credit, cut by where its cycle sits
	// against the month being closed.
	const [creditTotals] = rowsOf<{
		before: string;
		during: string;
		after: string;
		all: string;
	}>(
		await db.execute(sql`
			SELECT
				COALESCE(sum(amount) FILTER (WHERE billing_cycle < ${cycle}), 0)::numeric(14, 2)::text AS before,
				COALESCE(sum(amount) FILTER (WHERE billing_cycle = ${cycle}), 0)::numeric(14, 2)::text AS during,
				COALESCE(sum(amount) FILTER (WHERE billing_cycle > ${cycle}), 0)::numeric(14, 2)::text AS after,
				COALESCE(sum(amount), 0)::numeric(14, 2)::text AS all
			FROM creator_credits
		`),
	);

	// The charitable ledger for the month: settlement's remainder rows carry the
	// `[settle u<id> <cycle>]` marker, and refund shortfalls point at the refunded purchases.
	const remainderRows = rowsOf<{
		id: number;
		amount: string;
		description: string;
		created_at: string;
	}>(
		await db.execute(sql`
			SELECT id, amount, description, created_at
			FROM crf_ledger
			WHERE description LIKE ${`[settle u% ${cycle}] %`}
			ORDER BY id
		`),
	);
	const shortfallRows = refundedPurchases.length
		? await db
				.select({
					id: crfLedger.id,
					amount: crfLedger.amount,
					description: crfLedger.description,
					createdAt: crfLedger.createdAt,
				})
				.from(crfLedger)
				.where(
					inArray(
						crfLedger.purchaseId,
						refundedPurchases.map((r) => r.id),
					),
				)
		: [];

	// The clearing balance every recorded row implies, from the first row through this
	// period — the books start empty, so the whole database is the ledger's history.
	const [invoiceImplied] = rowsOf<{ implied: string }>(
		await db.execute(sql`
			SELECT COALESCE(sum(CASE
				WHEN status = 'paid' THEN total - processing_fee
				-- A refunded or disputed renewal was paid before its money went back, so its
				-- whole life nets to minus the fee Stripe kept — the arrival and the return.
				WHEN status IN ('refunded', 'disputed') THEN -processing_fee
				ELSE 0
			END), 0)::numeric(14, 2)::text AS implied
			FROM invoices
			WHERE billing_cycle <= ${cycle}
		`),
	);
	const [purchaseImplied] = rowsOf<{ implied: string }>(
		await db.execute(sql`
			SELECT COALESCE(sum(CASE
				WHEN status = 'completed' THEN sales_tax + processing_fee + delivery_fee
				WHEN status = 'refunded' THEN
					(sales_tax + processing_fee + delivery_fee)
					- (sales_tax + processing_fee + CASE WHEN downloaded_at IS NOT NULL THEN delivery_fee ELSE 0 END)
				ELSE 0
			END), 0)::numeric(14, 2)::text AS implied
			FROM purchases
			WHERE (status IN ('completed', 'refunded') AND created_at < ${end}::timestamptz)
				OR (status = 'refunded' AND refunded_at < ${end}::timestamptz)
		`),
	);

	// ── The entry ───────────────────────────────────────────────────────────────────
	// A refunded or disputed renewal was paid before its money went back, so it rides both
	// events and nets to the processing fee — the same keying the schedules show.
	const entryInvoices = invoiceRows.filter((r) => r.status !== "paused");
	const settledInvoices = entryInvoices.filter((r) => r.settled_at != null);
	const refundedInvoices = entryInvoices.filter((r) => r.status === "refunded" || r.status === "disputed");

	const lines: ClosePackageLine[] = [];
	const push = (
		event: string,
		account: string,
		side: "debit" | "credit",
		amount: Decimal,
		memo: string,
		/**
		 * What separates this line from another under the same event and account when the
		 * two are genuinely different money — the Time Pool's two fundings, whose memos
		 * name different kinds of money and must never merge into one line.
		 */
		key?: string,
	) => {
		if (amount.isZero()) return;
		lines.push({
			event,
			account,
			debit: side === "debit" ? money(amount) : "0.00",
			credit: side === "credit" ? money(amount) : "0.00",
			memo,
			key,
		});
	};

	// 1. An invoice is paid — money in, for every invoice that was charged (a refunded one
	//    was paid before its money returned, and its refund event below reverses it).
	const invNet = entryInvoices.reduce((s, r) => s.plus(D(r.total).minus(D(r.processing_fee))), ZERO);
	const invFee = entryInvoices.reduce((s, r) => s.plus(D(r.processing_fee)), ZERO);
	const invTax = entryInvoices.reduce((s, r) => s.plus(D(r.tax)), ZERO);
	const invCreator = entryInvoices.reduce((s, r) => s.plus(creatorOf(r.id)), ZERO);
	const invAnthers = entryInvoices.reduce((s, r) => s.plus(anthersOf(r)), ZERO);
	push("An invoice is paid", "Stripe clearing", "debit", invNet,
		`Invoices paid for ${period.label}, net of processing fees — the fee never reached the clearing balance.`);
	push("An invoice is paid", "Payment processing expense", "debit", invFee,
		"Card processing recorded on the month's paid invoices — Anthers' own charge.");
	push("An invoice is paid", "Sales tax payable", "credit", invTax,
		"Sales tax collected on the month's paid invoices — the only thing added on top.");
	push("An invoice is paid", "Support collected not yet settled", "credit", invCreator,
		"The creator-directed lines, gross — held until the month settles.");
	push("An invoice is paid", "Badge revenue", "credit", invAnthers,
		"The Badge (Anthers) line of the month's paid invoices — program-service revenue.");

	// 2. A month settles — the bridge from gross to net, through the expense account.
	const supportCredits = creditGroups
		.filter((g) => g.kind === "support")
		.reduce((s, g) => s.plus(D(g.total)), ZERO);
	const settledGross = settledInvoices.reduce((s, r) => s.plus(creatorOf(r.id)), ZERO);
	// The creator-borne share of card processing is the difference between what settlement
	// relieved and what it credited — derived from the rows, never recomputed from a rate.
	const feeShare = Decimal.max(0, settledGross.minus(supportCredits));
	push("A month settles", "Support collected not yet settled", "debit", supportCredits.plus(feeShare),
		"The settled invoices' directed lines, relieved from the holding account.");
	push("A month settles", "Due to creators", "credit", supportCredits,
		"Support credited at settlement, net of the creator-borne share of card processing.");
	push("A month settles", "Payment processing expense", "credit", feeShare,
		"The creator-borne share of card processing, credited back — creators bear it at cost, so it never touches the profit and loss.");

	// 3. The Time Pool is distributed — one line per funding, because the two are different
	//    kinds of money that happen to settle identically (the schema's own ⭐ note).
	const poolSupporter = creditGroups
		.filter((g) => g.kind !== "support" && g.funded_by === "supporter")
		.reduce((s, g) => s.plus(D(g.total)), ZERO);
	const poolAnthers = creditGroups
		.filter((g) => g.kind !== "support" && g.funded_by === "anthers")
		.reduce((s, g) => s.plus(D(g.total)), ZERO);
	push("The Time Pool is distributed", "Time Pool distributions (program)", "debit", poolSupporter,
		"Time Pool and Stickers paid by time this month, from what supporters gave — a program-service expense against the Badge revenue that funded it.",
		"supporter");
	push("The Time Pool is distributed", "Due to creators", "credit", poolSupporter,
		"The pool's credits at settlement, from the supporters' own money.",
		"supporter");
	push("The Time Pool is distributed", "Time Pool distributions (program)", "debit", poolAnthers,
		"The free accounts' Time Pool — Anthers' own money spent on their behalf, a genuine program-service expense.",
		"anthers");
	push("The Time Pool is distributed", "Due to creators", "credit", poolAnthers,
		"The free pool's credits at settlement, from Anthers' own funds.",
		"anthers");

	// 4. A Work is purchased — Anthers' share only; the destination charge sent the
	//    creator's share straight to the creator's own balance, so no liability arises.
	const purClearing = purchaseRows.reduce(
		(s, r) => s.plus(D(r.sales_tax)).plus(D(r.processing_fee)).plus(D(r.delivery_fee)),
		ZERO,
	);
	const purTax = purchaseRows.reduce((s, r) => s.plus(D(r.sales_tax)), ZERO);
	const purFee = purchaseRows.reduce(
		(s, r) => s.plus(D(r.processing_fee)).plus(D(r.delivery_fee)),
		ZERO,
	);
	push("A Work is purchased", "Stripe clearing", "debit", purClearing,
		"Purchases charged this month — Anthers' share only: the tax plus the platform side of the price. The destination charge sent the creator's share straight to the creator's balance.");
	push("A Work is purchased", "Sales tax payable", "credit", purTax,
		"Sales tax collected on purchases — Anthers is the marketplace facilitator.");
	push("A Work is purchased", "Payment processing expense", "credit", purFee,
		"Card processing on purchases, borne by the creator's share of the price — credited, never an Anthers expense.");

	// 5. Purchase refunds in the month — the buyer's charge returns and the creator's
	//    transfer is clawed back in their own balance, which the books never held.
	const refPurTax = refundedPurchases.reduce((s, r) => s.plus(D(r.sales_tax)), ZERO);
	const refPurShortfall = refundedPurchases.reduce(
		(s, r) =>
			s
				.plus(D(r.processing_fee))
				.plus(r.downloaded_at ? D(r.delivery_fee) : ZERO),
		ZERO,
	);
	push("A refund or chargeback", "Sales tax payable", "debit", refPurTax,
		"Tax returned with refunded purchases.");
	push("A refund or chargeback", "Payment processing expense", "debit", refPurShortfall,
		"What the refund could not recover — the sunk processing fee, absorbed by the remainder.");
	push("A refund or chargeback", "Stripe clearing", "credit", refPurTax.plus(refPurShortfall),
		"Purchase refunds this month — the buyer's charge returned; the creator's transfer was clawed back in their own balance.");

	// 6. Subscription refunds and disputes — the buyer's renewal charge returns in full,
	//    with the relief booked where the money was sitting when it returned.
	const refInvTax = refundedInvoices.reduce((s, r) => s.plus(D(r.tax)), ZERO);
	const refInvUnsettled = refundedInvoices
		.filter((r) => r.settled_at == null)
		.reduce((s, r) => s.plus(creatorOf(r.id)), ZERO);
	const refInvSettled = refundedInvoices
		.filter((r) => r.settled_at != null)
		.reduce((s, r) => s.plus(creatorOf(r.id)), ZERO);
	const refInvAnthers = refundedInvoices.reduce((s, r) => s.plus(anthersOf(r)), ZERO);
	const refInvTotal = refundedInvoices.reduce((s, r) => s.plus(D(r.total)), ZERO);
	push("A refund or chargeback", "Sales tax payable", "debit", refInvTax,
		"Tax returned with refunded and disputed renewals.");
	push("A refund or chargeback", "Support collected not yet settled", "debit", refInvUnsettled,
		"Directed support returned before its month settled — it never credited anybody.");
	push("A refund or chargeback", "Due to creators", "debit", refInvSettled,
		"Directed support returned after settlement — the ledger's credits stand until the reversal build lands, and the Due-to-creators control flags that gap.");
	push("A refund or chargeback", "Badge revenue", "debit", refInvAnthers,
		"Badge revenue returned with the refunded renewals.");
	push("A refund or chargeback", "Stripe clearing", "credit", refInvTotal,
		"The buyer's renewal charge returned in full; Stripe kept its fee, which the entry expensed when the invoice was paid.");

	// 7. The events whose builds do not exist yet — shown at zero, never invented.
	for (const unbuilt of UNBUILT_EVENTS) {
		lines.push({
			event: unbuilt.event,
			account: unbuilt.account,
			debit: "0.00",
			credit: "0.00",
			memo: unbuilt.memo,
			unbuilt: true,
		});
	}

	// The decision calls for "about eight lines a month": a summary entry, not a
	// transaction-per-row ledger — so the same account under the same event merges into
	// one line, with its memos combined. The schedules carry the per-row detail; the
	// entry is what a person checks and posts.
	const merged = new Map<string, ClosePackageLine>();
	for (const line of lines) {
		const key = `${line.event}||${line.account}||${line.key ?? ""}`;
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { ...line });
			continue;
		}
		existing.debit = money(D(existing.debit).plus(D(line.debit)));
		existing.credit = money(D(existing.credit).plus(D(line.credit)));
		if (line.memo !== existing.memo) existing.memo = `${existing.memo} ${line.memo}`;
	}

	const entryLines = [...merged.values()].map(({ key, ...line }) => line);

	const totalDebits = entryLines.reduce((s, l) => s.plus(D(l.debit)), ZERO);
	const totalCredits = entryLines.reduce((s, l) => s.plus(D(l.credit)), ZERO);

	// ── The reconciliation controls ────────────────────────────────────────────────
	const clearingMovement = entryLines
		.filter((l) => l.account === "Stripe clearing" && !l.unbuilt)
		.reduce((s, l) => s.plus(D(l.debit)).minus(D(l.credit)), ZERO);
	const impliedClearing = D(invoiceImplied?.implied ?? 0).plus(D(purchaseImplied?.implied ?? 0));

	const opening = D(creditTotals?.before ?? 0);
	const during = D(creditTotals?.during ?? 0);
	const expectedCredits = D(creditTotals?.all ?? 0);
	// The entry's own Due-to-creators movement: what settlement credited, less what the
	// settled refunds relieved.
	const dueMovement = during.minus(refInvSettled);
	const impliedDue = opening.plus(dueMovement);
	const dueDifference = expectedCredits.minus(impliedDue);

	const empty =
		entryInvoices.length === 0 && purchaseRows.length === 0 && refundedPurchases.length === 0 && creditGroups.length === 0;

	return {
		ok: true,
		package: {
			period: { key: rawPeriod.trim(), label: period.label, cycle, settledAt },
			empty,
			entry: {
				lines: entryLines,
				totalDebits: money(totalDebits),
				totalCredits: money(totalCredits),
				balanced: money(totalDebits) === money(totalCredits),
			},
			schedules: {
				invoices: {
					rows: invoiceRows.map((r) => ({
						id: r.id,
						stripeInvoiceId: r.stripe_id,
						status: r.status,
						subtotal: money(D(r.subtotal)),
						tax: money(D(r.tax)),
						total: money(D(r.total)),
						processingFee: money(D(r.processing_fee)),
						discount: money(D(r.discount)),
						creatorLines: money(creatorOf(r.id)),
						anthersLine: money(anthersOf(r)),
						settled: r.settled_at != null,
						paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
					})),
					count: invoiceRows.length,
					totals: {
						subtotal: money(invoiceRows.reduce((s, r) => s.plus(D(r.subtotal)), ZERO)),
						tax: money(invTaxPlus(invoiceRows)),
						total: money(invoiceRows.reduce((s, r) => s.plus(D(r.total)), ZERO)),
						processingFee: money(invoiceRows.reduce((s, r) => s.plus(D(r.processing_fee)), ZERO)),
						creatorLines: money(invoiceRows.reduce((s, r) => s.plus(creatorOf(r.id)), ZERO)),
						anthersLine: money(invoiceRows.reduce((s, r) => s.plus(anthersOf(r)), ZERO)),
					},
				},
				purchases: {
					rows: purchaseRows.map((r) => ({
						id: r.id,
						type: r.type,
						amount: money(D(r.amount)),
						salesTax: money(D(r.sales_tax)),
						processingFee: money(D(r.processing_fee)),
						deliveryFee: money(D(r.delivery_fee)),
						creatorEarnings: money(D(r.creator_earnings)),
						status: r.status,
						createdAt: new Date(r.created_at).toISOString(),
						refundedAt:
							refundedPurchases.find((p) => p.id === r.id)?.refunded_at
								? new Date(
										refundedPurchases.find((p) => p.id === r.id)!.refunded_at!,
									).toISOString()
								: null,
					})),
					count: purchaseRows.length,
					totals: {
						amount: money(purchaseRows.reduce((s, r) => s.plus(D(r.amount)), ZERO)),
						salesTax: money(purTax),
						processingFee: money(purchaseRows.reduce((s, r) => s.plus(D(r.processing_fee)), ZERO)),
						deliveryFee: money(purchaseRows.reduce((s, r) => s.plus(D(r.delivery_fee)), ZERO)),
						creatorEarnings: money(purchaseRows.reduce((s, r) => s.plus(D(r.creator_earnings)), ZERO)),
					},
				},
				settlement: {
					credits: creditGroups.map((g) => ({
						kind: g.kind,
						fundedBy: g.funded_by,
						count: g.n,
						total: money(D(g.total)),
					})),
					remainder: remainderRows.map((r) => ({
						id: r.id,
						amount: money(D(r.amount)),
						description: r.description,
						createdAt: new Date(r.created_at).toISOString(),
					})),
					refundShortfalls: shortfallRows.map((r) => ({
						id: r.id,
						amount: money(D(r.amount)),
						description: r.description,
						createdAt: r.createdAt.toISOString(),
					})),
				},
			},
			controls: {
				stripeClearing: {
					monthMovement: money(clearingMovement),
					impliedBalance: money(impliedClearing),
					verifiable: false,
					note: "This balance is implied by Anthers' own entries, from the first recorded row through this period; Anthers' rows cannot verify Stripe's own reported balance, so reconciling it against the Stripe dashboard is the operator's step. The implied figure carries the platform side of each purchase gross of the fee Stripe deducts from the platform balance, so it runs above the dashboard by the accumulated purchase-side fee figures — the first live reconciliation sizes that gap.",
				},
				dueToCreators: {
					opening: money(opening),
					movement: money(dueMovement),
					implied: money(impliedDue),
					expected: money(expectedCredits),
					difference: money(dueDifference),
					pass: dueDifference.isZero(),
					note: "Expected is the sum of creator balances in Anthers' database — every creator_credits row, since credits not yet transferred are a creator's balance and no transfer job exists. A difference means either settlement rows for cycles after this month (regenerating an old package after later months settled) or a settled invoice refunded while its ledger credits still stand, which is the reversal build the 2026-09-14 decision left open.",
				},
			},
			notes: [...BOUNDARY_NOTES],
		},
	};
}

/** The schedule's tax total covers every row shown, paused included — the schedule is the record. */
function invTaxPlus(rows: { tax: string }[]): Decimal {
	return rows.reduce((s, r) => s.plus(D(r.tax)), ZERO);
}