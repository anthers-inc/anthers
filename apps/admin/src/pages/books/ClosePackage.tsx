// SPDX-License-Identifier: Apache-2.0
/**
 * The monthly close package: one settled month's journal entry, the schedules behind it, the
 * two reconciliation controls, and the CSV export a person posts into the books — Wave since
 * 2026-10-04 (the bookkeeping decision), where the person posts the entry by hand.
 *
 * The entry is what a person checks line by line before posting, so it reads first and the
 * schedules — the audit trail an accountant asks for — sit behind disclosures. Debits and
 * credits are totaled and the balance stated plainly, because an entry that does not say
 * whether it balances has not been checked.
 *
 * 🚨 **The defect this screen exists to prevent** is booking creators' money as Anthers' own
 * revenue or spending: creator-directed support and Work purchases are a liability to the
 * creator and never touch the profit and loss; Badge money is program-service revenue; Time
 * Pool distributions are a program-service expense. The notes carry that statement, and the
 * entry's account names are the decision's own.
 *
 * The four events whose builds do not exist yet (the 14-day transfer, the payout-fee
 * recharge, chargebacks, and Stripe's payout to the bank) are shown at zero and said so,
 * never silently omitted — a confident entry with missing money is worse than a hole.
 *
 * Copy is title case for labels ("Entry Lines", "Due to Creators") and sentence case for
 * prose, per the machine-wide rule.
 */
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { useAdminData } from "../../lib/load";

interface CloseLine {
	event: string;
	account: string;
	debit: string;
	credit: string;
	memo: string;
	unbuilt?: boolean;
}

interface InvoiceScheduleRow {
	id: number;
	stripeInvoiceId: string;
	status: string;
	subtotal: string;
	tax: string;
	total: string;
	processingFee: string;
	discount: string;
	creatorLines: string;
	anthersLine: string;
	settled: boolean;
	paidAt: string | null;
}

interface PurchaseScheduleRow {
	id: number;
	type: string;
	amount: string;
	salesTax: string;
	processingFee: string;
	creatorEarnings: string;
	status: string;
	createdAt: string;
	refundedAt: string | null;
}

interface ClosePackage {
	period: { key: string; label: string; cycle: string; settledAt: string };
	empty: boolean;
	entry: { lines: CloseLine[]; totalDebits: string; totalCredits: string; balanced: boolean };
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
				creatorEarnings: string;
			};
		};
		settlement: {
			credits: { kind: string; fundedBy: string; count: number; total: string }[];
			remainder: { id: number; amount: string; description: string; createdAt: string }[];
			refundShortfalls: { id: number; amount: string; description: string; createdAt: string }[];
		};
	};
	controls: {
		stripeClearing: {
			monthMovement: string;
			impliedBalance: string;
			verifiable: boolean;
			note: string;
		};
		dueToCreators: {
			opening: string;
			movement: string;
			implied: string;
			expected: string;
			difference: string;
			pass: boolean;
			note: string;
		};
	};
	notes: string[];
}

/** The last month that has plausibly settled: two back, since settlement runs on the 2nd. */
function defaultPeriodKey(): string {
	const now = new Date();
	const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The journal-import CSV: Date, Description, Account, Debits, Credits, Memo. */
function journalCsv(pkg: ClosePackage): string {
	const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
	// The posting date is the settlement date — the month's books close when it settles.
	const date = pkg.period.settledAt.slice(0, 10);
	const head = ["Date", "Description", "Account", "Debits", "Credits", "Memo"];
	const rows = pkg.entry.lines
		// An unbuilt line is a stated absence, not money — exporting it would post a zero row
		// for an event that never happened.
		.filter((line) => !line.unbuilt)
		.map((line) => [
			date,
			`Close ${pkg.period.label}`,
			line.account,
			line.debit,
			line.credit,
			line.memo,
		]);
	return `${[head, ...rows].map((row) => row.map(esc).join(",")).join("\r\n")}\r\n`;
}

function Disclosure({
	title,
	summary,
	children,
}: {
	title: string;
	summary: string;
	children: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	return (
		<section>
			<div className="flex items-center justify-between">
				<SectionHeading>{title}</SectionHeading>
				<button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
					{open ? "Hide" : "Show"}
				</button>
			</div>
			<p className="mb-3 text-sm text-base-content/60">{summary}</p>
			{open && children}
		</section>
	);
}

function ControlCard({
	title,
	pass,
	value,
	label,
	note,
}: {
	title: string;
	pass: boolean;
	value: string;
	label: string;
	note: string;
}) {
	return (
		<div className="rounded-box border border-base-300 bg-base-100 p-4">
			<div className="mb-1 flex items-center justify-between gap-3">
				<span className="font-medium">{title}</span>
				<span className={`badge badge-sm ${pass ? "badge-success" : "badge-error"}`}>
					{pass ? "Pass" : "Fail"}
				</span>
			</div>
			<div className="mb-2 text-2xl font-bold tabular-nums">{value}</div>
			<div className="text-xs uppercase tracking-wide text-base-content/50">{label}</div>
			<p className="mt-3 text-sm text-base-content/70">{note}</p>
		</div>
	);
}

export default function ClosePackage() {
	const [periodInput, setPeriodInput] = useState(defaultPeriodKey());
	const [submittedPeriod, setSubmittedPeriod] = useState(defaultPeriodKey());

	const { data, loading, error, reload } = useAdminData<ClosePackage>(
		`/api/admin/books/close-package?period=${encodeURIComponent(submittedPeriod)}`,
	);

	function submit(e: React.FormEvent) {
		e.preventDefault();
		setSubmittedPeriod(periodInput.trim());
	}

	function downloadCsv() {
		if (!data) return;
		const blob = new Blob([journalCsv(data)], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `anthers-close-${data.period.key}.csv`;
		a.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div>
			<PageHeader
				title="Monthly Close Package"
				description="One settled month as a journal entry, the schedules behind every figure, and the reconciliation controls. The export posts into the books — Wave — by hand; nothing writes to its API."
				onRefresh={reload}
				loading={loading}
			/>

			<form className="mb-6 flex flex-wrap items-end gap-3" onSubmit={submit}>
				<label className="form-control">
					<div className="mb-1 text-xs uppercase tracking-wide text-base-content/50">
						Close Period
					</div>
					<input
						className="input input-bordered input-sm w-36"
						placeholder="2026-09"
						value={periodInput}
						onChange={(e) => setPeriodInput(e.target.value)}
					/>
				</label>
				<button type="submit" className="btn btn-sm btn-primary">
					Show Package
				</button>
				{data && (
					<button type="button" className="btn btn-sm" onClick={downloadCsv}>
						Download CSV
					</button>
				)}
			</form>

			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data && (
					<div className="space-y-10">
						<div className="grid grid-cols-3 gap-3">
							<StatCard title="Period" value={data.period.label} />
							<StatCard title="Settled At" value={data.period.settledAt.slice(0, 10)} />
							<StatCard
								title="Entry Balances"
								value={data.entry.balanced ? "Yes" : "No"}
								sub={`Debits $${data.entry.totalDebits} — Credits $${data.entry.totalCredits}`}
							/>
						</div>

						{data.empty && (
							<div role="alert" className="alert alert-info">
								<span>
									This settled month holds no charges, no settlement and no purchases. The package
									is stated empty rather than in error — a zero month still closes.
								</span>
							</div>
						)}

						{!data.entry.balanced && (
							<div role="alert" className="alert alert-error">
								<span>
									The entry does not balance: debits ${data.entry.totalDebits} against credits $
									{data.entry.totalCredits}. Do not post it — find the difference first.
								</span>
							</div>
						)}

						{!data.controls.dueToCreators.pass && (
							<div role="alert" className="alert alert-error">
								<span>
									Due to creators disagrees with the creator balances in Anthers' database by $
									{data.controls.dueToCreators.difference}. The control's note names the two causes;
									do not post the entry until it is resolved.
								</span>
							</div>
						)}

						<section>
							<SectionHeading>Entry Lines</SectionHeading>
							<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>Event</th>
											<th>Account</th>
											<th className="text-right">Debit</th>
											<th className="text-right">Credit</th>
											<th>Memo</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{data.entry.lines.map((line) => (
											<tr
												key={`${line.event}|${line.account}|${line.debit}|${line.credit}`}
												className={line.unbuilt ? "text-base-content/50" : undefined}
											>
												<td className="font-medium">{line.event}</td>
												<td>{line.account}</td>
												<td className="text-right tabular-nums">
													{line.debit === "0.00" ? "—" : `$${line.debit}`}
												</td>
												<td className="text-right tabular-nums">
													{line.credit === "0.00" ? "—" : `$${line.credit}`}
												</td>
												<td className="text-sm">{line.memo}</td>
												<td>
													{line.unbuilt && (
														<span className="badge badge-ghost badge-sm">Not Built Yet</span>
													)}
												</td>
											</tr>
										))}
										<tr className="font-bold">
											<td>Totals</td>
											<td />
											<td className="text-right tabular-nums">${data.entry.totalDebits}</td>
											<td className="text-right tabular-nums">${data.entry.totalCredits}</td>
											<td />
											<td />
										</tr>
									</tbody>
								</table>
							</div>
						</section>

						<section>
							<SectionHeading>Reconciliation Controls</SectionHeading>
							<div className="grid gap-3 md:grid-cols-2">
								<ControlCard
									title="Stripe Clearing"
									pass={data.entry.balanced}
									value={`$${data.controls.stripeClearing.impliedBalance}`}
									label="Implied Balance, All Recorded Rows"
									note={data.controls.stripeClearing.note}
								/>
								<ControlCard
									title="Due to Creators"
									pass={data.controls.dueToCreators.pass}
									value={`$${data.controls.dueToCreators.difference === "0.00" ? data.controls.dueToCreators.expected : data.controls.dueToCreators.difference}`}
									label={
										data.controls.dueToCreators.pass
											? "Ties to Creator Balances"
											: "Difference From Creator Balances"
									}
									note={data.controls.dueToCreators.note}
								/>
							</div>
						</section>

						<Disclosure
							title="Invoice Schedule"
							summary={`${data.schedules.invoices.count} invoice(s) recorded for this month, with totals.`}
						>
							<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>Stripe Invoice</th>
											<th>Status</th>
											<th className="text-right">Subtotal</th>
											<th className="text-right">Creator Lines</th>
											<th className="text-right">Badge Line</th>
											<th className="text-right">Tax</th>
											<th className="text-right">Total</th>
											<th className="text-right">Processing Fee</th>
											<th>Settled</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{data.schedules.invoices.rows.map((row) => (
											<tr key={row.id}>
												<td className="font-mono text-xs">{row.stripeInvoiceId}</td>
												<td>{row.status}</td>
												<td className="text-right tabular-nums">${row.subtotal}</td>
												<td className="text-right tabular-nums">${row.creatorLines}</td>
												<td className="text-right tabular-nums">${row.anthersLine}</td>
												<td className="text-right tabular-nums">${row.tax}</td>
												<td className="text-right tabular-nums">${row.total}</td>
												<td className="text-right tabular-nums">${row.processingFee}</td>
												<td>{row.settled ? "Yes" : "No"}</td>
												<td />
											</tr>
										))}
										<tr className="font-bold">
											<td>Totals ({data.schedules.invoices.count})</td>
											<td />
											<td className="text-right tabular-nums">
												${data.schedules.invoices.totals.subtotal}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.invoices.totals.creatorLines}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.invoices.totals.anthersLine}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.invoices.totals.tax}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.invoices.totals.total}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.invoices.totals.processingFee}
											</td>
											<td />
											<td />
										</tr>
									</tbody>
								</table>
							</div>
						</Disclosure>

						<Disclosure
							title="Purchase Schedule"
							summary={`${data.schedules.purchases.count} purchase(s) charged this month, with the platform side and the creator's share of each.`}
						>
							<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>Purchase</th>
											<th>Type</th>
											<th>Status</th>
											<th className="text-right">Price</th>
											<th className="text-right">Tax</th>
											<th className="text-right">Processing Fee</th>
											<th className="text-right">Delivery Fee</th>
											<th className="text-right">Creator Share</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{data.schedules.purchases.rows.map((row) => (
											<tr key={row.id}>
												<td className="font-mono text-xs">#{row.id}</td>
												<td>{row.type}</td>
												<td>{row.status}</td>
												<td className="text-right tabular-nums">${row.amount}</td>
												<td className="text-right tabular-nums">${row.salesTax}</td>
												<td className="text-right tabular-nums">${row.processingFee}</td>
												<td className="text-right tabular-nums">${row.creatorEarnings}</td>
												<td />
											</tr>
										))}
										<tr className="font-bold">
											<td>Totals ({data.schedules.purchases.count})</td>
											<td />
											<td />
											<td className="text-right tabular-nums">
												${data.schedules.purchases.totals.amount}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.purchases.totals.salesTax}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.purchases.totals.processingFee}
											</td>
											<td className="text-right tabular-nums">
												${data.schedules.purchases.totals.creatorEarnings}
											</td>
											<td />
										</tr>
									</tbody>
								</table>
							</div>
						</Disclosure>

						<Disclosure
							title="Settlement Schedule"
							summary="The month's creator credits by kind and funding, and the charitable ledger movements — the figures the entry's settlement lines come from."
						>
							<div className="space-y-6">
								<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
									<table className="table table-sm">
										<thead>
											<tr>
												<th>Kind</th>
												<th>Funding</th>
												<th className="text-right">Credits</th>
												<th className="text-right">Total</th>
												<th />
											</tr>
										</thead>
										<tbody>
											{data.schedules.settlement.credits.map((row) => (
												<tr key={`${row.kind}-${row.fundedBy}`}>
													<td className="font-medium">{row.kind}</td>
													<td>{row.fundedBy}</td>
													<td className="text-right tabular-nums">{row.count}</td>
													<td className="text-right tabular-nums">${row.total}</td>
													<td />
												</tr>
											))}
										</tbody>
									</table>
								</div>
								{[
									...data.schedules.settlement.remainder,
									...data.schedules.settlement.refundShortfalls,
								].length > 0 && (
									<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
										<table className="table table-sm">
											<thead>
												<tr>
													<th>Ledger Row</th>
													<th className="text-right">Amount</th>
													<th>Description</th>
													<th />
												</tr>
											</thead>
											<tbody>
												{[
													...data.schedules.settlement.remainder,
													...data.schedules.settlement.refundShortfalls,
												].map((row) => (
													<tr key={row.id}>
														<td className="font-mono text-xs">#{row.id}</td>
														<td className="text-right tabular-nums">${row.amount}</td>
														<td className="text-sm">{row.description}</td>
														<td />
													</tr>
												))}
											</tbody>
										</table>
									</div>
								)}
							</div>
						</Disclosure>

						<section>
							<SectionHeading>What This Package Cannot Say</SectionHeading>
							<ul className="list-disc space-y-1 pl-5 text-sm text-base-content/70">
								{data.notes.map((note) => (
									<li key={note}>{note}</li>
								))}
							</ul>
						</section>

						<section>
							<SectionHeading>Posting the Export</SectionHeading>
							<p className="text-sm text-base-content/70">
								Download CSV produces a journal-import file — one row per entry line, with the
								date, description, account, debit, credit and memo columns. The books live in
								Wave, where a person posts the entry by hand (Accounting → Transactions → Add
								journal entry); the CSV serves as the schedule of record rather than a file Wave
								imports. An account name must already exist in Wave's chart of accounts before
								you type the line — it cannot create one, so add any missing account first.
							</p>
						</section>
					</div>
				)
			)}
		</div>
	);
}
