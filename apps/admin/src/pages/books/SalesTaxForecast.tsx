// SPDX-License-Identifier: Apache-2.0
/**
 * The sales-tax threshold forecast: each state's facilitated sales counted against its own
 * marketplace-facilitator threshold, with the trajectory into each state — because the move to
 * Stripe Tax Complete is decided ahead of the crossing, on each state's own short clock.
 *
 * The threshold table is the Sales Tax Playbook's, transcribed into
 * `@anthers/shared/sales-tax-thresholds`; the screen renders the transcription and never restates
 * a number. The transaction prong is the real tripwire at Anthers' ticket sizes, so both prongs
 * are shown with their percentage-of-threshold and the straight-line projection of where the
 * window ends — labeled as a projection rather than a prediction.
 *
 * 🚨 **Support renewals are not yet counted by state.** An invoice row records its tax but not
 * the buyer's location, so the renewal half of facilitated sales is missing from these counts
 * until the per-jurisdiction work lands. The response says so and this screen carries it, rather
 * than presenting an undercount as the whole picture.
 *
 * Copy is title case for labels ("Transactions", "Window") and sentence case for prose, per the
 * machine-wide rule. A state past a threshold says what crossing starts in one line, not a wall
 * of text — the Playbook's own clock line.
 */
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../../components/ui";
import { useAdminData } from "../../lib/load";

interface ForecastState {
	state: string;
	name: string;
	homeState: boolean;
	noSalesTax: boolean;
	verified: boolean;
	effectivelyAlwaysOn: boolean;
	/** Dollars in this state's window, two-place string. */
	dollars: string;
	transactions: number;
	dollarThreshold: number | null;
	transactionThreshold: number | null;
	relation: "or" | "and" | null;
	/** Fraction of each prong reached, 0–1+ (1 once the prong is over). */
	dollarFraction: number;
	transactionFraction: number;
	status: "clear" | "approaching" | "crossed";
	firesFirst: "dollar" | "transactions" | null;
	projection: { dollars: string; transactions: number; elapsedFraction: number } | null;
	window: { label: string; start: string; end: string } | null;
	note: string | null;
	crossingStarts: string | null;
}

interface Forecast {
	states: ForecastState[];
	notes: string[];
	asOf: string;
}

/** A percentage of a prong, one decimal place — the trajectory reads better than raw fractions. */
function pct(fraction: number): string {
	return `${(fraction * 100).toFixed(1)}%`;
}

/** A threshold's own line: "$100,000 OR 200 transactions" for the row's subtitle. */
function thresholdLine(row: ForecastState): string {
	const dollar =
		row.dollarThreshold !== null
			? `$${row.dollarThreshold.toLocaleString("en-US")}`
			: null;
	const tx = row.transactionThreshold !== null ? `${row.transactionThreshold} transactions` : null;
	if (dollar && tx) return `${dollar} ${row.relation === "and" ? "AND" : "OR"} ${tx}`;
	if (dollar) return dollar;
	if (tx) return tx;
	return "No threshold";
}

const STATUS_BADGE: Record<ForecastState["status"], string> = {
	crossed: "badge-error",
	approaching: "badge-warning",
	clear: "badge-ghost",
};

function StatusBadge({ row }: { row: ForecastState }) {
	return <span className={`badge badge-sm ${STATUS_BADGE[row.status]}`}>{row.status}</span>;
}

function StateRow({ row }: { row: ForecastState }) {
	// Colorado and the no-tax states: no window to count, so the row says why and stops.
	if (!row.window) {
		return (
			<tr>
				<td className="font-medium">{row.name}</td>
				<td colSpan={5} className="text-base-content/60">
					{row.homeState
						? "Home state — no threshold applies. Colorado's filing-frequency bands are the worksheet's job."
						: row.note ?? "No facilitator duty to forecast."}
				</td>
				<td />
			</tr>
		);
	}

	const projection = row.projection;
	return (
		<tr className={row.status === "crossed" ? "bg-error/10" : undefined}>
			<td className="font-medium">
				{row.name} <StatusBadge row={row} />
				{row.effectivelyAlwaysOn && (
					<span className="ml-1 text-xs text-base-content/60">effectively always-on</span>
				)}
				{!row.verified && (
					<span className="ml-1 text-xs text-warning" title="The Playbook marks this row unverified">
						unverified
					</span>
				)}
			</td>
			<td className="tabular-nums">
				<div>
					${row.dollars} {row.dollarThreshold !== null && <span className="text-base-content/50">({pct(row.dollarFraction)})</span>}
				</div>
				<div>
					{row.transactions.toLocaleString("en-US")}{" "}
					{row.transactionThreshold !== null && (
						<span className="text-base-content/50">({pct(row.transactionFraction)})</span>
					)}
				</div>
			</td>
			<td className="text-base-content/70">{thresholdLine(row)}</td>
			<td className="text-base-content/70">{row.window.label}</td>
			<td className="text-base-content/70">
				{projection ? (
					<div className="text-sm">
						<div>
							${projection.dollars} and {projection.transactions.toLocaleString("en-US")} tx at the
							current pace
						</div>
						<div className="text-base-content/50">
							straight-line projection, {pct(projection.elapsedFraction)} through the window
							{row.firesFirst && `; the ${row.firesFirst === "transactions" ? "transaction" : "dollar"} prong fires first`}
						</div>
					</div>
				) : (
					"—"
				)}
			</td>
			<td className="text-sm text-base-content/70">
				{row.status === "crossed" && row.crossingStarts && (
					<div className="font-medium text-error">{row.crossingStarts}</div>
				)}
				{row.note && <div>{row.note}</div>}
			</td>
			<td />
		</tr>
	);
}

export default function SalesTaxForecast() {
	const { data, loading, error, reload } = useAdminData<Forecast>(
		"/api/admin/books/sales-tax-forecast",
	);

	return (
		<div>
			<PageHeader
				title="Sales-Tax Forecast"
				description="Each state's facilitated sales counted against its marketplace-facilitator threshold, nearest state first. The transaction prong fires first at Anthers' ticket sizes, so both prongs carry their percentage-of-threshold and a straight-line projection of the window's end. This is the input to the move to Stripe Tax Complete, decided ahead of the crossing."
				onRefresh={reload}
				loading={loading}
			/>

			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data && (
					<div className="space-y-10">
						{data.states.some((s) => s.status === "crossed") && (
							<div role="alert" className="alert alert-error">
								<span>
									{data.states
										.filter((s) => s.status === "crossed" && !s.homeState)
										.map((s) => s.name)
										.join(" and ")}{" "}
									{"has crossed a threshold"}
									{data.states.filter((s) => s.status === "crossed").length > 1 ? " — registration runs on each state's own clock, and a Department of Revenue settles the row first." : " — registration runs on the state's own clock, and the Department of Revenue settles the row first."}
								</span>
							</div>
						)}

						<section>
							<SectionHeading>By State, Nearest First</SectionHeading>
							<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>State</th>
											<th>This Window</th>
											<th>Threshold</th>
											<th>Measured Over</th>
											<th>Trajectory</th>
											<th>Notes</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{data.states.map((row) => (
											<StateRow key={row.state} row={row} />
										))}
									</tbody>
								</table>
							</div>
						</section>

						<section>
							<SectionHeading>What These Counts Cannot Say</SectionHeading>
							<ul className="list-disc space-y-1 pl-5 text-sm text-base-content/70">
								{data.notes.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</section>
					</div>
				)
			)}
		</div>
	);
}