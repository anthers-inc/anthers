// SPDX-License-Identifier: Apache-2.0
/**
 * State marketplace-facilitator thresholds — the transcription of the Sales Tax Playbook's
 * threshold table (Anthers-Wiki, `Internal Wiki/10-19 Governance & Records/22 - Sales Tax
 * Playbook`, § The Threshold Table), and the place a value is added.
 *
 * Pure (no clock reads, no DOM, no I/O — `now` is always a parameter), like `content-rating.ts`
 * and `tax-codes.ts`, so the API and the admin app read the same table rather than each
 * hard-coding its own. The Playbook owns the numbers: it is research compiled from secondary
 * sources, it marks its own unverified entries, and **a state's Department of Revenue settles
 * a row before it is acted on** — a warning from the forecast is a prompt to verify with the
 * state, never a registration decision on its own.
 *
 * What the table encodes, and the choices frozen here:
 *
 * 1. **The base is combined facilitated sales** — Anthers' own direct sales plus every
 *    creator's sales into a state combined, because that is what a facilitator threshold
 *    measures. A single creator never reaches one alone.
 * 2. **The transaction prong is the real tripwire at Anthers' ticket sizes** (nearly every
 *    charge is under $20, so 200 transactions arrive long before $100,000), which is why both
 *    prongs are carried as data with their OR/AND relation rather than folding the tx count
 *    into a note.
 * 3. **The measurement window is data, not prose.** The windows genuinely differ by state —
 *    current-or-prior calendar year, previous calendar year, trailing 12 months (reviewed
 *    quarterly in some), 12 months ending a quarter boundary, Connecticut's 12 months ending
 *    September 30, New York's four sales-tax quarters, Puerto Rico's fiscal year — so each row
 *    carries a `window` kind that `windowFor` resolves into real dates, and the operator sees
 *    which window each number is measured over.
 * 4. **Unverified rows stay unverified.** Kentucky's repeal date and Michigan's transaction
 *    prong are flagged in the Playbook itself; they are transcribed with `verified: false`
 *    rather than resolved here. Michigan still counts transactions — a state with a live
 *    transaction prong is the expensive direction to be wrong in, so the Playbook's own
 *    instruction is followed and the row carries both prongs pending the Department of
 *    Revenue's answer.
 * 5. **Colorado is the home state.** No threshold applies; the row is marked rather than
 *    omitted so the forecast can say why Colorado's row reads differently. The four no-sales-tax
 *    states (and the Playbook's other no-threshold rows) are carried the same way.
 */

/**
 * How a state's threshold is measured, as the Playbook words it. Each kind is resolved by
 * `windowFor` into a real `[start, end)` span.
 *
 * - `current-calendar-year` — the Playbook's "current or prior calendar year" states: the live
 *   counting window is the current calendar year (a prior-year crossing is what the notes on
 *   the prior-year-only states warn about; these states cross in whichever year the sale lands).
 * - `previous-calendar-year` — measured over the last complete calendar year, so a state can
 *   start January already over.
 * - `trailing-12-months` — the 12 months before `now` (or before the last review boundary).
 * - `trailing-12-months-reviewed-quarterly` — same span, stepped to the most recent quarter
 *   boundary: Illinois and Missouri review at quarters, so the window ends at the last quarter
 *   end rather than today.
 * - `quarter-ending-12-months` — Minnesota: the 12 months ending on the last day of the most
 *   recent quarter.
 * - `sept30-12-months` — Connecticut: the 12 months ending September 30; cross both prongs by
 *   then and duty begins October 1.
 * - `four-sales-tax-quarters` — New York: the four preceding calendar quarters, ending at the
 *   most recent quarter boundary.
 * - `fiscal-year` — Puerto Rico: the seller's fiscal year, which for Anthers is the calendar
 *   year.
 * - `none` — no threshold to measure (the no-sales-tax states and Colorado).
 */
export type WindowKind =
	| "current-calendar-year"
	| "previous-calendar-year"
	| "trailing-12-months"
	| "trailing-12-months-reviewed-quarterly"
	| "quarter-ending-12-months"
	| "sept30-12-months"
	| "four-sales-tax-quarters"
	| "fiscal-year"
	| "none";

/** How the two threshold prongs combine. `null` where only one prong exists. */
export type ProngRelation = "or" | "and";

/** A calendar quarter boundary in UTC — the first instant of the quarter `offset` quarters before `ref`'s. */
function quarterStart(ref: Date, offset: number): Date {
	const q = Math.floor(ref.getUTCMonth() / 3) - offset;
	const year = ref.getUTCFullYear() + Math.floor(q / 4);
	const month = ((q % 4) + 4) % 4;
	return new Date(Date.UTC(year, month * 3, 1));
}

/** Midnight UTC on January 1 of `year`. */
function jan1(year: number): Date {
	return new Date(Date.UTC(year, 0, 1));
}

/**
 * The same instant 12 months earlier, in UTC calendar arithmetic — months rather than
 * `365 * 86400_000` so the span lands on the same calendar day the way a Department of Revenue
 * counts it (February 2026 minus 12 months is February 2025, not a day off).
 */
function minusTwelveMonths(date: Date): Date {
	return new Date(
		Date.UTC(
			date.getUTCFullYear() - 1,
			date.getUTCMonth(),
			date.getUTCDate(),
			date.getUTCHours(),
			date.getUTCMinutes(),
			date.getUTCSeconds(),
			date.getUTCMilliseconds(),
		),
	);
}

/** One state's threshold row, transcribed from the Playbook's table. */
export interface StateThreshold {
	/** Two-letter code as Stripe resolves `buyer_state` ("CO", "DC", "PR"). */
	state: string;
	name: string;
	/** Colorado: the home state, no threshold applies. */
	homeState?: boolean;
	/** A state with no sales tax at all, so no facilitator duty to forecast. */
	noSalesTax?: boolean;
	/** The dollar prong in whole dollars, or null where none applies. */
	dollarThreshold: number | null;
	/** The transaction prong, or null where none exists (or was repealed). */
	transactionThreshold: number | null;
	/** How the prongs combine — `null` where only one prong exists. */
	relation: ProngRelation | null;
	window: WindowKind;
	/** The Playbook's own wording of the window, for the operator's screen. */
	windowLabel: string;
	/**
	 * The Playbook's per-state note where it carries one — registration mechanics, GET/GRT
	 * rather than sales tax, certification duties, a repealed prong. Null where the row is
	 * standard and says so.
	 */
	note: string | null;
	/** What crossing starts, one line from the Playbook's clock table — registration, on the state's own clock. */
	crossingStarts: string;
	/** Mirrors the Playbook's own unverified marks; a Department of Revenue settles the row before it is acted on. */
	verified: boolean;
	/** Oklahoma: the $10,000 floor is the lowest in the country — effectively always-on at any platform size. */
	effectivelyAlwaysOn?: boolean;
}

/**
 * Every row of the Playbook's threshold table. Read a row, do not restatiate it: the whole
 * point of this module is that the forecast and the screen render the transcription rather
 * than each carrying a copy.
 */
export const STATE_THRESHOLDS: readonly StateThreshold[] = [
	{
		state: "AL",
		name: "Alabama",
		dollarThreshold: 250_000,
		transactionThreshold: null,
		relation: null,
		window: "previous-calendar-year",
		windowLabel: "Previous calendar year",
		note: "Must register under Simplified Sellers Use Tax (SSUT), a flat ~8% rate. Duty starts Jan 1 after the year of crossing.",
		crossingStarts: "Duty starts January 1 of the year after crossing.",
		verified: true,
	},
	{
		state: "AK",
		name: "Alaska",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "No state tax, but 100+ cities and boroughs tax via the Alaska Remote Seller Sales Tax Commission, one shared registration portal (arsstc.munirevs.com).",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "AZ",
		name: "Arizona",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "AR",
		name: "Arkansas",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Taxable-sales basis — keep records supporting exempt sales.",
		crossingStarts: "Registration is due on the next transaction or the next day after crossing.",
		verified: true,
	},
	{
		state: "CA",
		name: "California",
		dollarThreshold: 500_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Combined retail sales of tangible personal property; digital-only and services generally excluded. Once over, collect same day. Certain fees (e-waste, tire) also collect on applicable facilitated sales.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "CO",
		name: "Colorado",
		dollarThreshold: null,
		transactionThreshold: null,
		relation: null,
		window: "none",
		windowLabel: "—",
		note: "Home state — no threshold applies.",
		crossingStarts: "—",
		verified: true,
		homeState: true,
	},
	{
		state: "CT",
		name: "Connecticut",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "and",
		window: "sept30-12-months",
		windowLabel: "12 months ending Sept 30",
		note: "Both required. Cross both by Sept 30 and duty begins Oct 1.",
		crossingStarts: "Duty begins October 1 after both prongs are crossed by September 30.",
		verified: true,
	},
	{
		state: "DE",
		name: "Delaware",
		dollarThreshold: null,
		transactionThreshold: null,
		relation: null,
		window: "none",
		windowLabel: "—",
		note: "No sales tax.",
		crossingStarts: "—",
		verified: true,
		noSalesTax: true,
	},
	{
		state: "DC",
		name: "District of Columbia",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Digital products and many subscriptions are taxable, which matters for the product mix.",
		crossingStarts: "Registration is due on the next transaction or the next day after crossing.",
		verified: true,
	},
	{
		state: "FL",
		name: "Florida",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "previous-calendar-year",
		windowLabel: "Previous calendar year",
		note: "Prior-year measurement: Anthers may start January already over.",
		crossingStarts: "Duty starts January 1 of the year after crossing.",
		verified: true,
	},
	{
		state: "GA",
		name: "Georgia",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "No transaction count for facilitators. A separate return for facilitated sales is required.",
		crossingStarts: "Registration is due on the next transaction or the next day after crossing.",
		verified: true,
	},
	{
		state: "HI",
		name: "Hawaii",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "GET, not sales tax — ~4% collected plus a 0.5% Oahu surcharge; creator payouts are generally taxed at the 0.5% wholesale rate, and creators may still have their own GET filing.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "ID",
		name: "Idaho",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "If Anthers ever has Idaho presence, a separate facilitator permit is required.",
		crossingStarts: "Registration is due on the next transaction or the next day after crossing.",
		verified: true,
	},
	{
		state: "IL",
		name: "Illinois",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months-reviewed-quarterly",
		windowLabel: "Preceding 12 months, reviewed quarterly",
		note: "200-tx prong removed 1/1/2026. Facilitators collect local use taxes too.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "IN",
		name: "Indiana",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "IA",
		name: "Iowa",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Counts own plus facilitated combined.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "KS",
		name: "Kansas",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Facilitator threshold measured on taxable sales (Notice 21-14).",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "KY",
		name: "Kentucky",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "200-tx prong removed effective 8/1/2026 (verify). A separate return for facilitated sales is required.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: false,
	},
	{
		state: "LA",
		name: "Louisiana",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Register via the Louisiana Remote Seller Commission — a simplified single-rate collection instead of parish-by-parish.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "ME",
		name: "Maine",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "MD",
		name: "Maryland",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "MA",
		name: "Massachusetts",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Creator marketplace sales are excluded from a registered creator's own threshold once Anthers collects.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "MI",
		name: "Michigan",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "previous-calendar-year",
		windowLabel: "Previous calendar year",
		note: "Whether a transaction prong exists is unverified — this table and the Sales Tax Institute chart disagree, so the Playbook counts transactions meanwhile, because a live prong is the expensive direction to be wrong in.",
		crossingStarts: "Duty starts January 1 of the year after crossing.",
		verified: false,
	},
	{
		state: "MN",
		name: "Minnesota",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "quarter-ending-12-months",
		windowLabel: "12 months ending the last day of the most recent quarter",
		note: "Rolling window; a written agreement can let a registered creator collect instead.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "MS",
		name: "Mississippi",
		dollarThreshold: 250_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months",
		windowLabel: "Prior 12 months",
		note: "Gross-sales basis.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "MO",
		name: "Missouri",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months-reviewed-quarterly",
		windowLabel: "Prior 12 months, reviewed quarterly",
		note: "Taxable tangible personal property sales.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "MT",
		name: "Montana",
		dollarThreshold: null,
		transactionThreshold: null,
		relation: null,
		window: "none",
		windowLabel: "—",
		note: "No sales tax.",
		crossingStarts: "—",
		verified: true,
		noSalesTax: true,
	},
	{
		state: "NE",
		name: "Nebraska",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "NV",
		name: "Nevada",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Opt-out possible: a written agreement, filed with the DOR, under which a Nevada-registered creator assumes collection. Separate subaccounts for facilitated returns.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "NH",
		name: "New Hampshire",
		dollarThreshold: null,
		transactionThreshold: null,
		relation: null,
		window: "none",
		windowLabel: "—",
		note: "No sales tax.",
		crossingStarts: "—",
		verified: true,
		noSalesTax: true,
	},
	{
		state: "NJ",
		name: "New Jersey",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Anthers must collect even if the creator is New Jersey-registered (agreements permitted).",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "NM",
		name: "New Mexico",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "previous-calendar-year",
		windowLabel: "Previous calendar year",
		note: "GRT — tax on the seller's receipts, remitted by Anthers as facilitator. Destination sourcing.",
		crossingStarts: "Duty starts January 1 of the year after crossing.",
		verified: true,
	},
	{
		state: "NY",
		name: "New York",
		dollarThreshold: 500_000,
		transactionThreshold: 100,
		relation: "and",
		window: "four-sales-tax-quarters",
		windowLabel: "Preceding four sales-tax quarters",
		note: "Both required. Register within 30 days of crossing. SaaS and digital count as tangible personal property here.",
		crossingStarts: "Register within 30 days of crossing.",
		verified: true,
	},
	{
		state: "NC",
		name: "North Carolina",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "200-tx prong removed 7/1/2024. Register within 60 days of crossing.",
		crossingStarts: "Register within 60 days of crossing.",
		verified: true,
	},
	{
		state: "ND",
		name: "North Dakota",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Must certify collection to creators. A separate facilitated-sales account is allowed.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "OH",
		name: "Ohio",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Two accounts requested: one for direct sales, one flagged as facilitator. (The Commercial Activity Tax applies only at much higher receipts.)",
		crossingStarts: "Registration is due on the next transaction or the next day after crossing.",
		verified: true,
	},
	{
		state: "OK",
		name: "Oklahoma",
		dollarThreshold: 10_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months",
		windowLabel: "Immediately preceding 12 months",
		note: "The lowest facilitator threshold in the country — effectively always-on for a platform of any size. Check monthly.",
		crossingStarts: "The earliest of all. Check monthly.",
		verified: true,
		effectivelyAlwaysOn: true,
	},
	{
		state: "OR",
		name: "Oregon",
		dollarThreshold: null,
		transactionThreshold: null,
		relation: null,
		window: "none",
		windowLabel: "—",
		note: "No sales tax.",
		crossingStarts: "—",
		verified: true,
		noSalesTax: true,
	},
	{
		state: "PA",
		name: "Pennsylvania",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months",
		windowLabel: "Prior 12 months",
		note: "Must certify collection to creators. Digital goods and subscriptions taxable.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "PR",
		name: "Puerto Rico",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "fiscal-year",
		windowLabel: "Seller's fiscal year (the calendar year, for Anthers)",
		note: "Applies only if Anthers serves Puerto Rico buyers.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "RI",
		name: "Rhode Island",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "previous-calendar-year",
		windowLabel: "Immediately preceding calendar year",
		note: "Prior-year measurement — check each December.",
		crossingStarts: "Duty starts January 1 of the year after crossing.",
		verified: true,
	},
	{
		state: "SC",
		name: "South Carolina",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Inclusion state: facilitated sales also count toward each creator's own threshold — expect creator questions.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "SD",
		name: "South Dakota",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Must give creators conspicuous and direct notice when Anthers collects.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "TN",
		name: "Tennessee",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months",
		windowLabel: "Previous 12 months",
		note: "A separate location ID is required for facilitated sales on the return.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "TX",
		name: "Texas",
		dollarThreshold: 500_000,
		transactionThreshold: null,
		relation: null,
		window: "trailing-12-months",
		windowLabel: "Preceding 12 months",
		note: "Combined gross revenue including exempt sales. Must certify to creators. Duty starts the 4th month after crossing.",
		crossingStarts: "Duty starts the fourth month after crossing.",
		verified: true,
	},
	{
		state: "UT",
		name: "Utah",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "200-tx prong removed 7/2025.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "VT",
		name: "Vermont",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "trailing-12-months",
		windowLabel: "Previous 12 months",
		note: "Must certify collection to creators.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "VA",
		name: "Virginia",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Retail-sales basis.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "WA",
		name: "Washington",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Gross-income basis including wholesale. B&O is a separate layer: facilitated sales are deducted from Anthers' own B&O, but Anthers owes B&O on its own receipts (the Small Business Credit may offset).",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "WV",
		name: "West Virginia",
		dollarThreshold: 100_000,
		transactionThreshold: 200,
		relation: "or",
		window: "current-calendar-year",
		windowLabel: "Preceding or current calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "WI",
		name: "Wisconsin",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: "Must notify creators that Anthers is collecting.",
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
	{
		state: "WY",
		name: "Wyoming",
		dollarThreshold: 100_000,
		transactionThreshold: null,
		relation: null,
		window: "current-calendar-year",
		windowLabel: "Current or prior calendar year",
		note: null,
		crossingStarts: "Register within the state's clock — most give 30–60 days of crossing.",
		verified: true,
	},
];

/** Look up one state's row by its two-letter code, or null for a code the table does not carry. */
export function thresholdFor(state: string): StateThreshold | null {
	return STATE_THRESHOLDS.find((row) => row.state === state.toUpperCase()) ?? null;
}

/** A resolved measurement window: the half-open span `[start, end)`, in UTC. */
export interface ThresholdWindow {
	kind: WindowKind;
	/** The Playbook's wording of the window. */
	label: string;
	start: Date;
	/** Exclusive — one instant past the window's last day. */
	end: Date;
}

/**
 * Resolve a state's measurement window around `now`, which is a parameter so a test can stand
 * anywhere. For the "current or prior calendar year" states the window returned is the current
 * calendar year — the live counting window; for the prior-year states it is the last complete
 * calendar year, which is what those states actually measure.
 *
 * The quarterly-reviewed and quarter-ending windows end at the most recent quarter boundary
 * rather than at `now`, because that is when the state's review steps: a sale today counts
 * toward the window that the next quarter's review will close.
 *
 * Returns null only for `window: "none"` — Colorado and the no-sales-tax states, where there is
 * nothing to measure.
 */
export function windowFor(state: string, now: Date): ThresholdWindow | null {
	const row = thresholdFor(state);
	if (!row) return null;
	const label = row.windowLabel;

	switch (row.window) {
		case "none":
			return null;
		case "current-calendar-year":
		case "fiscal-year":
			// Puerto Rico's "seller's fiscal year" is the calendar year for Anthers.
			return {
				kind: row.window,
				label,
				start: jan1(now.getUTCFullYear()),
				end: jan1(now.getUTCFullYear() + 1),
			};
		case "previous-calendar-year":
			return {
				kind: row.window,
				label,
				start: jan1(now.getUTCFullYear() - 1),
				end: jan1(now.getUTCFullYear()),
			};
		case "trailing-12-months":
			return { kind: row.window, label, start: minusTwelveMonths(now), end: now };
		case "trailing-12-months-reviewed-quarterly":
		case "quarter-ending-12-months":
		case "four-sales-tax-quarters": {
			// The window ends at the most recent quarter boundary; a sale made inside the
			// current, still-open quarter counts toward the window that boundary closed.
			const end = quarterStart(now, 0);
			return { kind: row.window, label, start: minusTwelveMonths(end), end };
		}
		case "sept30-12-months": {
			// The most recent Sept 30 that has passed: duty for the year ending Sept 30
			// begins Oct 1, so before Oct 1 the current window is still the previous one.
			const y = now.getUTCFullYear();
			const oct1 = new Date(Date.UTC(y, 9, 1));
			const end = now < oct1 ? new Date(Date.UTC(y - 1, 9, 1)) : oct1;
			return { kind: row.window, label, start: minusTwelveMonths(end), end };
		}
	}
}

/**
 * The earliest instant any state's window can reach, given `now` — the widest span a caller
 * must fetch rows for to count every state against its own window. That is January 1 of last
 * year: the previous-calendar-year states reach back to it, and no window reaches further.
 */
export function earliestWindowStart(now: Date): Date {
	return jan1(now.getUTCFullYear() - 1);
}