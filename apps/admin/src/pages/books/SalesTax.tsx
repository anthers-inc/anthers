// SPDX-License-Identifier: Apache-2.0
/**
 * The sales-tax return worksheet: totals by jurisdiction for one filing period, assembled from
 * the purchase and invoice rows so filing is review rather than arithmetic.
 *
 * Each period Anthers files three returns from the same collected tax — the Colorado state
 * return through Revenue Online, the SUTS return for the home-rule cities, and a direct return
 * to each self-collecting city outside SUTS (today Delta and Telluride). This screen totals
 * what the rows hold and flags those cities when a buyer named one; the state-vs-city split of
 * each charge's tax is not in the rows, and the screen says so rather than inventing it.
 *
 * 🚨 **An empty period renders as a complete zero worksheet, not an error.** A missed zero
 * return accrues penalties the same as a missed filing with tax due, so a quiet month is a
 * deadline and the screen has to be reachable for it.
 *
 * Copy is title case for labels ("Filing Period", "State Tax", "Home-Rule Cities") and sentence
 * case for prose, per the machine-wide rule.
 */
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { useAdminData } from "../../lib/load";

/** One state's or city's slice of the period, in dollars as two-place strings. */
interface JurisdictionTotals {
	state: string;
	city: string | null;
	purchases: number;
	taxable: string;
	tax: string;
}

interface SalesTaxWorksheet {
	period: {
		kind: "month" | "quarter" | "year";
		label: string;
		start: string;
		end: string;
	};
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
	directFileCities: JurisdictionTotals[];
	notes: string[];
}

/** This month, as the worksheet's first guess — the period most likely to be filed next. */
function currentMonthKey(): string {
	const now = new Date();
	return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function JurisdictionTable({
	title,
	rows,
	emptyLine,
}: {
	title: string;
	rows: JurisdictionTotals[];
	emptyLine: string;
}) {
	return (
		<section>
			<SectionHeading>{title}</SectionHeading>
			{rows.length === 0 ? (
				<p className="text-sm text-base-content/60">{emptyLine}</p>
			) : (
				<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Jurisdiction</th>
								<th className="text-right">Charges</th>
								<th className="text-right">Taxable Sales</th>
								<th className="text-right">Tax Collected</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={`${row.state}-${row.city ?? ""}`}>
									<td className="font-medium">{row.city ?? row.state}</td>
									<td className="text-right tabular-nums">{row.purchases}</td>
									<td className="text-right tabular-nums">${row.taxable}</td>
									<td className="text-right tabular-nums">${row.tax}</td>
									<td />
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

export default function SalesTaxWorksheet() {
	const [periodInput, setPeriodInput] = useState(currentMonthKey());
	const [submittedPeriod, setSubmittedPeriod] = useState(currentMonthKey());

	const { data, loading, error, reload } = useAdminData<SalesTaxWorksheet>(
		`/api/admin/books/sales-tax-worksheet?period=${encodeURIComponent(submittedPeriod)}`,
	);

	function submit(e: React.FormEvent) {
		e.preventDefault();
		setSubmittedPeriod(periodInput.trim());
	}

	return (
		<div>
			<PageHeader
				title="Sales-Tax Worksheet"
				description="Totals by jurisdiction for one filing period, assembled from the purchase and invoice records. Delta and Telluride are flagged when they appear, because each is filed with directly."
				onRefresh={reload}
				loading={loading}
			/>

			<form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={submit}>
				<label className="form-control">
					<div className="mb-1 text-xs uppercase tracking-wide text-base-content/50">
						Filing Period
					</div>
					<input
						className="input input-bordered input-sm w-48"
						placeholder="2026-09, 2026-Q3 or 2026"
						value={periodInput}
						onChange={(e) => setPeriodInput(e.target.value)}
					/>
				</label>
				<button type="submit" className="btn btn-sm btn-primary">
					Show Worksheet
				</button>
			</form>

			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data && (
					<div className="space-y-10">
						<div className="grid grid-cols-3 gap-3">
							<StatCard title="Tax Collected" value={`$${data.totals.taxCollected}`} />
							<StatCard title="Taxable Sales" value={`$${data.totals.taxableSales}`} />
							<StatCard title="Period" value={data.period.label} />
						</div>

						{data.empty && (
							<div role="alert" className="alert alert-info">
								<span>
									No taxable sales this period. This is a complete zero worksheet — a zero return is
									still owed, since a missed one accrues penalties the same as a missed filing with
									tax due.
								</span>
							</div>
						)}

						{data.directFileCities.length > 0 && (
							<div role="alert" className="alert alert-warning">
								<span>
									This period saw buyers in {data.directFileCities.map((c) => c.city).join(" and ")}
									, which collect their own sales tax outside SUTS — file each city's return
									directly.
								</span>
							</div>
						)}

						<section>
							<SectionHeading>Charge Totals</SectionHeading>
							<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>Source</th>
											<th className="text-right">Charges</th>
											<th className="text-right">Taxable Sales</th>
											<th className="text-right">Tax Collected</th>
											<th />
										</tr>
									</thead>
									<tbody>
										<tr>
											<td className="font-medium">Work Purchases</td>
											<td className="text-right tabular-nums">{data.totals.purchaseCount}</td>
											<td className="text-right tabular-nums">${data.totals.purchaseTaxable}</td>
											<td className="text-right tabular-nums">${data.totals.purchaseTax}</td>
											<td />
										</tr>
										<tr>
											<td className="font-medium">Support Renewals</td>
											<td className="text-right tabular-nums">{data.totals.invoiceCount}</td>
											<td className="text-right tabular-nums">${data.totals.invoiceTaxable}</td>
											<td className="text-right tabular-nums">${data.totals.invoiceTax}</td>
											<td />
										</tr>
									</tbody>
								</table>
							</div>
						</section>

						<JurisdictionTable
							title="By State"
							rows={data.byState}
							emptyLine="No completed purchases this period."
						/>

						<JurisdictionTable
							title="Home-Rule Cities"
							rows={data.byCity}
							emptyLine="No Colorado purchase this period names a city."
						/>

						{data.directFileCities.length > 0 && (
							<section>
								<SectionHeading>Direct-File Cities</SectionHeading>
								<p className="mb-2 text-sm text-base-content/60">
									Each city below is filed with directly, outside SUTS.
								</p>
								<div className="flex flex-wrap gap-2">
									{data.directFileCities.map((c) => (
										<span key={c.city} className="badge badge-warning">
											{c.city} — ${c.tax} on ${c.taxable}
										</span>
									))}
								</div>
							</section>
						)}

						<section>
							<SectionHeading>What These Rows Cannot Say</SectionHeading>
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
