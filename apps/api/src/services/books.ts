// SPDX-License-Identifier: Apache-2.0
/**
 * The Books section's read side: the sales-tax return worksheet.
 *
 * Each filing period, the Colorado return is filed three ways from the same collected tax
 * (the plan's *Every Filing Period*): the state return through Revenue Online, the SUTS return
 * for the home-rule cities that participate, and a direct return to each self-collecting
 * home-rule city outside SUTS — today Delta and Telluride. This module assembles the numbers
 * from the rows the platform already holds, so the work is review rather than arithmetic.
 *
 * 🚨 **The boundary these rows cannot cross, stated plainly rather than papered over.** A
 * purchase row records ONE combined `sales_tax` figure — everything Stripe Tax calculated for
 * the charge, with no state/local decomposition — and an invoice row records its `tax` but not
 * the buyer's location at all. So the worksheet CAN total what was collected, split purchases
 * by buyer state, and flag the cities buyers named at checkout; it CANNOT say how much of a
 * charge's tax is the state's share versus a city's. That split stays in Stripe Tax's Colorado
 * location report, which the plan keeps as the source for the home-rule city lines. The
 * worksheet's `notes` carry these statements to the screen, because a total that looks more
 * authoritative than its rows is how a wrong return gets filed with confidence.
 *
 * ⚠️ **Read-only.** Nothing here writes; the rows it reads are written by the checkout webhook
 * (`purchases`) and `services/invoices.ts` (`invoices`), and reaching around them is the bug
 * the one-writer rule names.
 *
 * What counts, and why:
 * - Purchases: `completed` rows only. A refunded charge's tax is returned by Stripe, so
 *   remitting it forward would overpay; a `pending` row's tax has not been resolved yet.
 * - Invoices: `paid` and `paused` rows. A paused renewal was still charged on the card — the
 *   money moved, only the credit is held — so its tax was collected. Refunded, disputed and
 *   uncollectible rows gave the money back.
 * - A purchase is placed by `created_at`; an invoice by `billing_cycle`, the month it PAYS FOR
 *   rather than the day the card was charged, per the `invoices` schema's own rule — a renewal
 *   pays on the first of the month it covers, so the two nearly always agree, and keying by
 *   `paid_at` instead would put a mid-month start's tax in the wrong period.
 */

import { db } from "@anthers/db/client";
import {
	earliestWindowStart,
	STATE_THRESHOLDS,
	windowFor,
} from "@anthers/shared/sales-tax-thresholds";
import { sql } from "drizzle-orm";

/**
 * The home-rule cities Anthers files with directly because they are outside SUTS — the plan's
 * *Every Filing Period*: "Today that is Delta and Telluride."
 *
 * ⚠️ Which cities file outside SUTS is an open question in the plan, so this list is what the
 * plan currently says rather than a settled registry; when a city is added, it joins here.
 * Matched case-insensitively against `buyer_city` as the buyer entered it, which is why the
 * match is on the name alone and never on postal codes.
 */
const DIRECT_FILE_CITIES = ["Delta", "Telluride"] as const;

/** A filing period as the caller names it: a month (`2026-09`), quarter (`2026-Q3`) or year (`2026`). */
export interface FilingPeriod {
	kind: "month" | "quarter" | "year";
	/** For the screen: "September 2026", "Q3 2026", "2026". */
	label: string;
	/** The period's first instant, UTC. */
	start: Date;
	/** One past the period's last instant, UTC — the exclusive upper bound. */
	end: Date;
}

const MONTH_PERIOD = /^(\d{4})-(\d{2})$/;
const QUARTER_PERIOD = /^(\d{4})-Q([1-4])$/;
const YEAR_PERIOD = /^(\d{4})$/;

/** A month's `billing_cycle` key (`YYYY-MM-01`), which compares correctly as text. */
function cycleKey(year: number, month: number): string {
	return `${year}-${String(month).padStart(2, "0")}-01`;
}

/**
 * Parse a caller-named period, or return null when the shape or the date is not a real period
 * (`2026-13`, `2027-Q5`). The worksheet accepts whichever frequency the Department has
 * Anthers on rather than hardcoding one, because the bands move with average monthly tax.
 */
export function parseFilingPeriod(raw: string): FilingPeriod | null {
	const month = MONTH_PERIOD.exec(raw);
	if (month) {
		const y = Number(month[1]);
		const m = Number(month[2]);
		if (m < 1 || m > 12) return null;
		const start = new Date(Date.UTC(y, m - 1, 1));
		return {
			kind: "month",
			label: start.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
			start,
			end: new Date(Date.UTC(y, m, 1)),
		};
	}

	const quarter = QUARTER_PERIOD.exec(raw);
	if (quarter) {
		const y = Number(quarter[1]);
		const q = Number(quarter[2]);
		const startMonth = (q - 1) * 3;
		return {
			kind: "quarter",
			label: `Q${q} ${y}`,
			start: new Date(Date.UTC(y, startMonth, 1)),
			end: new Date(Date.UTC(y, startMonth + 3, 1)),
		};
	}

	const year = YEAR_PERIOD.exec(raw);
	if (year) {
		const y = Number(year[1]);
		return {
			kind: "year",
			label: String(y),
			start: new Date(Date.UTC(y, 0, 1)),
			end: new Date(Date.UTC(y + 1, 0, 1)),
		};
	}

	return null;
}

/** One state's or city's slice of the period, in dollars as two-place strings. */
export interface JurisdictionTotals {
	state: string;
	city: string | null;
	purchases: number;
	taxable: string;
	tax: string;
}

/** What the worksheet can and cannot tell the person filing, carried to the screen verbatim. */
const BOUNDARY_NOTES = [
	"Each purchase row records the combined state and local tax Stripe Tax calculated for the charge, so the state's share and each city's share cannot be separated from these rows. Stripe Tax's Colorado location report remains the source for the state-administered local and home-rule split.",
	"Subscription invoices record the tax on a renewal but not the buyer's location, so their tax is included in the period's total but cannot be placed in a state or a city.",
	"Delta and Telluride collect their own sales tax outside SUTS, so a return goes to each directly when it appears here.",
	"Refunded charges are excluded: their tax was returned to the buyer along with the sale.",
] as const;

/** The assembled worksheet for one filing period. */
export interface SalesTaxWorksheet {
	period: {
		kind: FilingPeriod["kind"];
		label: string;
		start: string;
		end: string;
	};
	/** True when the period holds no completed purchases and no collected invoices at all. */
	empty: boolean;
	totals: {
		taxCollected: string;
		taxableSales: string;
		purchaseTax: string;
		purchaseTaxable: string;
		purchaseCount: number;
		invoiceTax: string;
		invoiceTaxable: string;
		invoiceCount: number;
	};
	byState: JurisdictionTotals[];
	byCity: JurisdictionTotals[];
	/** Delta and Telluride, when a buyer named one at checkout — the direct-file flag. */
	directFileCities: JurisdictionTotals[];
	notes: string[];
}

// postgres-js returns the rows array directly from db.execute(); other drivers wrap
// them in { rows }. Normalized so this is driver-agnostic. Exported because the close
// package (`services/close-package.ts`) reads raw SQL the same way.
export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
	if (Array.isArray(res)) return res as T[];
	const maybe = (res as { rows?: T[] } | null)?.rows;
	return Array.isArray(maybe) ? maybe : [];
}

/**
 * Assemble the worksheet for a named filing period. An empty period is a complete zero
 * worksheet rather than an error, because a missed zero return accrues penalties the same as
 * a missed filing with tax due — an empty period is a deadline, not a quiet month.
 */
export async function salesTaxWorksheet(period: FilingPeriod): Promise<SalesTaxWorksheet> {
	const start = period.start.toISOString();
	const end = period.end.toISOString();
	// `billing_cycle` is the month the invoice pays for, as text, so the bounds are its own keys.
	const cycleStart = cycleKey(period.start.getUTCFullYear(), period.start.getUTCMonth() + 1);
	const cycleEnd = cycleKey(period.end.getUTCFullYear(), period.end.getUTCMonth() + 1);

	const stateRes = await db.execute(sql`
		SELECT
			buyer_state AS state,
			count(*)::int AS purchases,
			COALESCE(sum(amount), 0)::numeric(14, 2)::text AS taxable,
			COALESCE(sum(sales_tax), 0)::numeric(14, 2)::text AS tax
		FROM purchases
		WHERE status = 'completed'
			AND created_at >= ${start}::timestamptz
			AND created_at < ${end}::timestamptz
		GROUP BY buyer_state
		ORDER BY tax DESC, state ASC
	`);
	const byState: JurisdictionTotals[] = rowsOf<{
		state: string | null;
		purchases: number;
		taxable: string;
		tax: string;
	}>(stateRes).map((r) => ({
		state: r.state ?? "Unknown",
		city: null,
		purchases: r.purchases,
		taxable: r.taxable,
		tax: r.tax,
	}));

	// Cities as the buyer entered them, Colorado only: buyer_city is the record's own text and
	// no geocoder sits behind it, so a city appears here exactly when a buyer named it.
	const cityRes = await db.execute(sql`
		SELECT
			buyer_city AS city,
			count(*)::int AS purchases,
			COALESCE(sum(amount), 0)::numeric(14, 2)::text AS taxable,
			COALESCE(sum(sales_tax), 0)::numeric(14, 2)::text AS tax
		FROM purchases
		WHERE status = 'completed'
			AND buyer_state = 'CO'
			AND buyer_city IS NOT NULL
			AND created_at >= ${start}::timestamptz
			AND created_at < ${end}::timestamptz
		GROUP BY buyer_city
		ORDER BY tax DESC, city ASC
	`);
	const byCity: JurisdictionTotals[] = rowsOf<{
		city: string;
		purchases: number;
		taxable: string;
		tax: string;
	}>(cityRes).map((r) => ({
		state: "CO",
		city: r.city,
		purchases: r.purchases,
		taxable: r.taxable,
		tax: r.tax,
	}));

	const directFileCities = byCity.filter((row) =>
		DIRECT_FILE_CITIES.some((name) => row.city?.trim().toLowerCase() === name.toLowerCase()),
	);

	const [invoiceRow] = rowsOf<{
		invoices: number;
		taxable: string;
		tax: string;
	}>(
		await db.execute(sql`
			SELECT
				count(*)::int AS invoices,
				COALESCE(sum(subtotal), 0)::numeric(14, 2)::text AS taxable,
				COALESCE(sum(tax), 0)::numeric(14, 2)::text AS tax
			FROM invoices
			WHERE status IN ('paid', 'paused')
				AND billing_cycle >= ${cycleStart}
				AND billing_cycle < ${cycleEnd}
		`),
	);

	const purchaseTaxable = byState.reduce((sum, r) => sum + Number(r.taxable), 0);
	const purchaseTax = byState.reduce((sum, r) => sum + Number(r.tax), 0);
	const purchaseCount = byState.reduce((sum, r) => sum + r.purchases, 0);
	const invoiceTaxable = Number(invoiceRow?.taxable ?? "0");
	const invoiceTax = Number(invoiceRow?.tax ?? "0");
	const invoiceCount = invoiceRow?.invoices ?? 0;

	const money = (n: number) => n.toFixed(2);

	return {
		period: {
			kind: period.kind,
			label: period.label,
			start: period.start.toISOString(),
			end: period.end.toISOString(),
		},
		empty: purchaseCount === 0 && invoiceCount === 0,
		totals: {
			taxCollected: money(purchaseTax + invoiceTax),
			taxableSales: money(purchaseTaxable + invoiceTaxable),
			purchaseTax: money(purchaseTax),
			purchaseTaxable: money(purchaseTaxable),
			purchaseCount,
			invoiceTax: money(invoiceTax),
			invoiceTaxable: money(invoiceTaxable),
			invoiceCount,
		},
		byState,
		byCity,
		directFileCities,
		notes: [...BOUNDARY_NOTES],
	};
}

/**
 * 🚨 **The forecast counts a refunded charge, unlike the worksheet above.** The worksheet is
 * about money that still moves — a refunded charge's tax went back to the buyer, so remitting it
 * would overpay. The forecast is about whether a threshold was *crossed*, and a refunded charge
 * still crossed it when it was made: a state does not un-count a sale because the buyer returned
 * it. So the forecast reads `completed` AND `refunded` rows, and the two tools disagree on
 * purpose.
 */

/** The status band a state sits in, by how close the nearest prong is. */
export type ForecastStatus = "clear" | "approaching" | "crossed";

/** At or above this fraction of either prong, a state reads "approaching" — the vendor-decision band. */
export const APPROACHING_FRACTION = 0.7;

/** One state's forecast row. */
export interface StateForecast {
	state: string;
	name: string;
	homeState: boolean;
	noSalesTax: boolean;
	/** The Playbook's unverified mark, carried to the screen. */
	verified: boolean;
	effectivelyAlwaysOn: boolean;
	/** Dollars in this window, two-place string. */
	dollars: string;
	transactions: number;
	dollarThreshold: number | null;
	transactionThreshold: number | null;
	relation: "or" | "and" | null;
	/** Fraction of the dollar prong already reached, 0 when the prong does not exist. */
	dollarFraction: number;
	/** Fraction of the transaction prong already reached, 0 when the prong does not exist. */
	transactionFraction: number;
	/** `clear` / `approaching` (≥70% of either prong) / `crossed`. */
	status: ForecastStatus;
	/** Which prong fires first at the current run rate, or null where only one prong exists. */
	firesFirst: "dollar" | "transactions" | null;
	/**
	 * The straight-line projection: where the window's dollars and transactions land if the
	 * pace held, labeled as a projection rather than a prediction. Null where the window has
	 * not opened yet (the prior-year states in January), where there is nothing to project
	 * (no sales and no elapsed window), or where no threshold applies.
	 */
	projection: {
		dollars: string;
		transactions: number;
		/** How far through the window `now` is, 0–1. */
		elapsedFraction: number;
	} | null;
	/** The window these numbers are measured over — each state's own. */
	window: { label: string; start: string; end: string } | null;
	note: string | null;
	/** One line from the Playbook: what crossing starts, on the state's own clock. */
	crossingStarts: string | null;
}

/** What the forecast can and cannot count, carried to the screen verbatim. */
const FORECAST_BOUNDARY_NOTES = [
	"Support renewals are not yet counted by state: an invoice row records its tax but not the buyer's location, so renewal sales into a state are missing from these counts until the per-jurisdiction work lands. The Work-purchase half is complete; the renewal half joins it when invoice rows carry their jurisdiction.",
	"Refunded purchases still count toward these thresholds — a charge crossed a threshold when it was made, and a refund does not un-count it. This is the forecast's opposite of the worksheet's rule, which excludes refunded tax because the money went back.",
	"Whether a non-taxable transaction counts toward a transaction threshold varies by state; these counts are all facilitated charges, and the state's Department of Revenue settles a row before it is acted on.",
	"Every figure is a straight-line projection of the current pace, not a prediction — it says where the window ends if nothing changes, which is the input to the Stripe Tax decision rather than a forecast of it.",
	"The threshold table is research from secondary sources, and the rows marked unverified are flagged as such. A state's Department of Revenue settles any row before it is acted on.",
] as const;

/** The forecast response. */
export interface SalesTaxForecast {
	states: StateForecast[];
	/** The boundary notes, carried to the screen like the worksheet's. */
	notes: string[];
	/** The moment the forecast was computed — every window resolves around it. */
	asOf: string;
}

/**
 * Which prong crosses first at the current run rate — the trajectory's own answer, since the
 * transaction prong fires first at Anthers' ticket sizes and the operator needs to see that
 * rather than infer it. Returns null where a prong does not exist or nothing has elapsed.
 */
function firesFirst(
	row: { dollarThreshold: number | null; transactionThreshold: number | null },
	projection: { dollars: number; transactions: number } | null,
): "dollar" | "transactions" | null {
	const thresholds: { prong: "dollar" | "transactions"; value: number }[] = [];
	if (row.dollarThreshold !== null)
		thresholds.push({ prong: "dollar", value: row.dollarThreshold });
	if (row.transactionThreshold !== null)
		thresholds.push({ prong: "transactions", value: row.transactionThreshold });
	if (thresholds.length < 2 || !projection)
		return thresholds.length === 1 ? thresholds[0].prong : null;
	// Where each prong's projected end sits against its own threshold: the smaller overshoot is
	// the one that fires first at this pace. A prong already over has "0 left" and fires first.
	let best: { prong: "dollar" | "transactions"; left: number } | null = null;
	for (const t of thresholds) {
		const projected = t.prong === "dollar" ? projection.dollars : projection.transactions;
		const left = (t.value - projected) / t.value;
		if (!best || left < best.left) best = { prong: t.prong, left };
	}
	return best!.prong;
}

/**
 * Assemble the threshold forecast. Sales are counted by the buyer's state against each state's
 * own measurement window, so one fetch spans the widest window and each state's rows are cut
 * to its own span. The base is combined facilitated sales — every creator's sales plus
 * Anthers' own — which is what a facilitator threshold measures, so no per-creator cut is
 * made anywhere in the count.
 */
export async function salesTaxForecast(now: Date = new Date()): Promise<SalesTaxForecast> {
	// The one fetch: every purchase since the widest window opens, by buyer state and day.
	const counts = rowsOf<{
		state: string | null;
		day: string;
		purchases: number;
		dollars: string;
	}>(
		await db.execute(sql`
			SELECT
				buyer_state AS state,
				date_trunc('day', created_at)::text AS day,
				count(*)::int AS purchases,
				COALESCE(sum(amount), 0)::numeric(14, 2)::text AS dollars
			FROM purchases
			WHERE status IN ('completed', 'refunded')
				AND buyer_state IS NOT NULL
				AND created_at >= ${earliestWindowStart(now).toISOString()}::timestamptz
				AND created_at <= ${now.toISOString()}::timestamptz
			GROUP BY buyer_state, date_trunc('day', created_at)
			ORDER BY buyer_state
		`),
	);

	const states: StateForecast[] = STATE_THRESHOLDS.map((row) => {
		const w = windowFor(row.state, now);
		// The threshold states: nothing to count, and the row says why.
		if (!w) {
			return {
				state: row.state,
				name: row.name,
				homeState: row.homeState ?? false,
				noSalesTax: row.noSalesTax ?? false,
				verified: row.verified,
				effectivelyAlwaysOn: row.effectivelyAlwaysOn ?? false,
				dollars: "0.00",
				transactions: 0,
				dollarThreshold: null,
				transactionThreshold: null,
				relation: null,
				dollarFraction: 0,
				transactionFraction: 0,
				status: "clear" as const,
				firesFirst: null,
				projection: null,
				window: null,
				note: row.note,
				crossingStarts: null,
			};
		}

		// This state's rows: inside its own window only.
		const start = w.start.getTime();
		const end = w.end.getTime();
		let dollars = 0;
		let transactions = 0;
		for (const r of counts) {
			const t = new Date(`${r.day.slice(0, 10)}T00:00:00.000Z`).getTime();
			if (r.state === row.state && t >= start && t < end) {
				transactions += r.purchases;
				dollars += Number(r.dollars);
			}
		}

		const dollarFraction = row.dollarThreshold ? dollars / row.dollarThreshold : 0;
		const transactionFraction = row.transactionThreshold
			? transactions / row.transactionThreshold
			: 0;
		// The prong already crossed, under the row's own OR/AND relation. Under OR, either
		// prong crossing crosses the threshold; under AND both are required.
		const dollarOver = row.dollarThreshold !== null && dollars >= row.dollarThreshold;
		const txOver = row.transactionThreshold !== null && transactions >= row.transactionThreshold;
		const crossed =
			row.relation === "and"
				? dollarOver && txOver
				: row.relation === "or"
					? dollarOver || txOver
					: dollarOver || txOver;

		// The straight-line projection: where this window ends if the pace held. The elapsed
		// portion is the whole window's span, not the time since the first sale.
		const span = end - start;
		const elapsed = Math.min(Math.max(now.getTime() - start, 0), span);
		const elapsedFraction = span > 0 ? elapsed / span : 0;
		const projected = (n: number) => (elapsedFraction > 0 ? n / elapsedFraction : n);
		const projection =
			row.dollarThreshold === null && row.transactionThreshold === null
				? null
				: elapsedFraction > 0
					? {
							dollars: projected(dollars).toFixed(2),
							transactions: Math.floor(projected(transactions)),
							elapsedFraction,
						}
					: null;

		const approaching =
			crossed ||
			(row.dollarThreshold !== null && dollarFraction >= APPROACHING_FRACTION) ||
			(row.transactionThreshold !== null && transactionFraction >= APPROACHING_FRACTION);

		const first = firesFirst(
			row,
			projection
				? { dollars: Number(projection.dollars), transactions: projection.transactions }
				: null,
		);

		return {
			state: row.state,
			name: row.name,
			homeState: false,
			noSalesTax: false,
			verified: row.verified,
			effectivelyAlwaysOn: row.effectivelyAlwaysOn ?? false,
			dollars: dollars.toFixed(2),
			transactions,
			dollarThreshold: row.dollarThreshold,
			transactionThreshold: row.transactionThreshold,
			relation: row.relation,
			dollarFraction: dollarOver ? Math.max(dollarFraction, 1) : dollarFraction,
			transactionFraction: txOver ? Math.max(transactionFraction, 1) : transactionFraction,
			status: crossed
				? ("crossed" as const)
				: approaching
					? ("approaching" as const)
					: ("clear" as const),
			firesFirst: first,
			projection,
			window: { label: w.label, start: w.start.toISOString(), end: w.end.toISOString() },
			note: row.note,
			crossingStarts: crossed ? row.crossingStarts : null,
		};
	});

	// Sorted by proximity to threshold, nearest on top: max fraction first, so the state
	// nearest its line is what the operator reads first. Colorado and the no-tax states sink
	// to the bottom in code order.
	states.sort((a, b) => {
		const proximity = (r: StateForecast) => Math.max(r.dollarFraction, r.transactionFraction);
		if (proximity(b) !== proximity(a)) return proximity(b) - proximity(a);
		return a.state.localeCompare(b.state);
	});

	return { states, notes: [...FORECAST_BOUNDARY_NOTES], asOf: now.toISOString() };
}
