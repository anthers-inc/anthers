// SPDX-License-Identifier: Apache-2.0
/**
 * The Financial Plan — the admin console's planning tool.
 *
 * A table of editable phases (the raw data host), each with its computed ledger
 * beside it; selecting a row draws that phase as a flow diagram — the drawing the
 * public Sankey resource later generates from. Inputs edit inline; computed
 * values never do, because they come from `planLedger` at read time.
 *
 * The plan's settled shape (2026-10-07): admin budgeted at the full 30% ceiling
 * — the growth budget, because covering out-of-pocket infrastructure and
 * eventually compensation is the sustainability the org grows into; the Time
 * Pool Fund at a stated share of the remainder after admin; programs the
 * residual. The projection horizon is inflection 1 and stops there.
 *
 * Every figure is % of charitable revenue AND $/month, both, everywhere — the
 * operator reads a plan in dollars and audits it in shares.
 */

import { apiFetch } from "@anthers/web-shared/rpc";
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../components/ui";
import { useAdminData } from "../lib/load";

interface Ledger {
	accounts: number;
	creators: number;
	payingAccounts: number;
	freeAccounts: number;
	charitableRevenue: number;
	adminBudget: number;
	adminActual: number;
	adminWithinCeiling: boolean;
	fund: number;
	freeSlice: number;
	freeStorage: number;
	programs: number;
	solvent: boolean;
	timePoolToCreators: number;
	adminCeiling: number;
}

interface PhaseRow {
	id: number;
	phase: number;
	label: string;
	accounts: number;
	payingShare: number;
	staff: number;
	tooling: number;
	services: number;
	adminBudgetShare: number | null;
	fundShare: number | null;
	ledger: Ledger;
}

interface PlanPayload {
	settings: { adminBudgetShare: number; fundShare: number };
	phases: PhaseRow[];
}

interface DraftInputs {
	label?: string;
	accounts?: number;
	payingShare?: number;
	staff?: number;
	tooling?: number;
	services?: number;
}

/** Both forms, always: "54.2% · $27,332/mo" — percentage and dollars. */
function both(revenue: number, dollars: number): string {
	const pct = revenue > 0 ? `${((dollars / revenue) * 100).toFixed(1)}%` : "—";
	return `${pct} · $${Math.round(dollars).toLocaleString("en-US")}`;
}

function shareLabel(share: number): string {
	return `${(share * 100).toFixed(1)}%`;
}

async function send(path: string, method: "PUT" | "POST" | "DELETE", body?: unknown) {
	const res = await apiFetch(path, {
		method,
		// 🚨 Content-Type is load-bearing: without it zValidator does not parse the body at
		// all, the handler receives an empty object, and the write silently changes nothing
		// while answering 200 — found by the browser pass (a persisted-nothing edit that
		// still moved the row's updatedAt). `adminPost` in lib/load carries the same header.
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) throw new Error((await res.text()).slice(0, 300));
	return res.status === 204 ? null : res.json();
}

export default function FinancialPlan() {
	const plan = useAdminData<PlanPayload>("/api/admin/financial-plan");
	const [selected, setSelected] = useState<number | null>(null);
	const [editing, setEditing] = useState<number | null>(null);
	const [draft, setDraft] = useState<DraftInputs | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (plan.loading) return <Loading />;
	if (plan.error) return <ErrorAlert>{plan.error}</ErrorAlert>;
	if (!plan.data) return <Loading />;
	const { settings, phases } = plan.data;

	const reload = () => void plan.reload();
	const sel = phases.find((p) => p.phase === selected) ?? phases[phases.length - 1] ?? null;

	async function commit(id: number) {
		if (!draft) return;
		setBusy(true);
		setError(null);
		try {
			await send(`/api/admin/financial-plan/phases/${id}`, "PUT", {
				label: draft.label,
				accounts: draft.accounts,
				payingShare: draft.payingShare,
				staff: draft.staff,
				tooling: draft.tooling,
				services: draft.services,
			});
			setEditing(null);
			setDraft(null);
			reload();
		} catch (e) {
			setError(e instanceof Error ? e.message : "The edit was refused.");
		} finally {
			setBusy(false);
		}
	}

	async function saveSettings(body: { adminBudgetShare: number; fundShare: number }) {
		setBusy(true);
		setError(null);
		try {
			await send("/api/admin/financial-plan/settings", "PUT", body);
			reload();
		} catch (e) {
			setError(e instanceof Error ? e.message : "The settings edit was refused.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<PageHeader
				title="Financial Plan"
				description="The plan from here through full-time — admin budgeted at the ceiling, the Fund beside it, programs the residual. Every figure is a share of revenue and dollars per month. Edits here are the plan; public resources generate from this data."
				onRefresh={reload}
				loading={plan.loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}

			<SectionHeading>
				Settings — the shares every phase defaults to (a phase may override)
			</SectionHeading>
			<SettingsEditor settings={settings} onSave={saveSettings} busy={busy} />

			<SectionHeading>
				The path — select a row to draw its phase; Edit changes the plan, and computed columns
				restate on save
			</SectionHeading>
			<div className="overflow-x-auto">
				<table className="table table-sm">
					<thead>
						<tr>
							<th>Phase</th>
							<th className="text-right">Accounts</th>
							<th className="text-right">Paying</th>
							<th className="text-right">Revenue/mo</th>
							<th className="text-right">Admin budget</th>
							<th className="text-right">Actual ops</th>
							<th className="text-right">Time Pool Fund</th>
							<th className="text-right">Free storage</th>
							<th className="text-right">Programs</th>
							<th className="text-right">Slice/free acct</th>
							<th />
						</tr>
					</thead>
					<tbody>
						{phases.map((p) => {
							const L = p.ledger;
							const editingThis = editing === p.id;
							return (
								<tr
									key={p.id}
									className={`${sel?.phase === p.phase ? "bg-primary/10 " : ""}${!L.solvent ? "bg-error/10 " : ""}cursor-pointer hover:bg-base-200`}
									onClick={() => setSelected(p.phase)}
								>
									<td>
										<strong>{p.phase}</strong> {editingThis ? "" : p.label}
										{!L.solvent && <span className="badge badge-error badge-sm ml-1">deficit</span>}
										{!L.adminWithinCeiling && (
											<span className="badge badge-warning badge-sm ml-1">ops over</span>
										)}
									</td>
									{editingThis && draft ? (
										<EditableCells
											draft={draft}
											setDraft={setDraft}
											onCommit={() => void commit(p.id)}
											onCancel={() => {
												setEditing(null);
												setDraft(null);
											}}
											busy={busy}
										/>
									) : (
										<>
											<td className="text-right tabular-nums">
												{p.accounts.toLocaleString("en-US")}
											</td>
											<td className="text-right tabular-nums">{shareLabel(p.payingShare)}</td>
											<td className="text-right tabular-nums">
												${Math.round(L.charitableRevenue).toLocaleString("en-US")}
											</td>
											<td className="text-right tabular-nums">
												{both(L.charitableRevenue, L.adminBudget)}
											</td>
											<td className="text-right tabular-nums">
												{both(L.charitableRevenue, L.adminActual)}
											</td>
											<td className="text-right tabular-nums">
												{both(L.charitableRevenue, L.fund)}
											</td>
											<td className="text-right tabular-nums">
												{both(L.charitableRevenue, L.freeStorage)}
											</td>
											<td className="text-right tabular-nums">
												{both(L.charitableRevenue, L.programs)}
											</td>
											<td className="text-right tabular-nums">${L.freeSlice.toFixed(3)}</td>
											<td className="text-right">
												<button
													type="button"
													className="btn btn-ghost btn-xs"
													onClick={(e) => {
														e.stopPropagation();
														setEditing(p.id);
														setDraft({
															label: p.label,
															accounts: p.accounts,
															payingShare: p.payingShare,
															staff: p.staff,
															tooling: p.tooling,
															services: p.services,
														});
													}}
												>
													Edit
												</button>
											</td>
										</>
									)}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{sel && (
				<>
					<PhaseEditorHeading
						phase={sel}
						onNext={() => setSelected(Math.min(sel.phase + 1, phases.length))}
						onPrev={() => setSelected(Math.max(sel.phase - 1, 1))}
					/>
					<PhaseDiagram ledger={sel.ledger} phase={sel} />
					<PhaseDetail ledger={sel.ledger} />
				</>
			)}
		</>
	);
}

function SettingsEditor({
	settings,
	onSave,
	busy,
}: {
	settings: { adminBudgetShare: number; fundShare: number };
	onSave: (b: { adminBudgetShare: number; fundShare: number }) => void;
	busy: boolean;
}) {
	const [admin, setAdmin] = useState(settings.adminBudgetShare);
	const [fund, setFund] = useState(settings.fundShare);
	return (
		<div className="flex gap-4 items-end mb-6 flex-wrap">
			<label className="text-sm" htmlFor="fp-admin-share">
				<div>Admin budget (share of revenue)</div>
				<input
					className="input input-bordered input-sm w-28 tabular-nums"
					type="number"
					step="0.01"
					min="0"
					max="1"
					id="fp-admin-share"
					value={admin}
					onChange={(e) => setAdmin(Number(e.target.value))}
				/>
			</label>
			<label className="text-sm" htmlFor="fp-fund-share">
				<div>Time Pool Fund (share of remainder)</div>
				<input
					className="input input-bordered input-sm w-28 tabular-nums"
					type="number"
					step="0.01"
					min="0"
					max="1"
					id="fp-fund-share"
					value={fund}
					onChange={(e) => setFund(Number(e.target.value))}
				/>
			</label>
			<button
				type="button"
				className="btn btn-primary btn-sm"
				disabled={busy}
				onClick={() => onSave({ adminBudgetShare: admin, fundShare: fund })}
			>
				Save settings
			</button>
			<span className="text-xs text-base-content/60">
				Locked 30% is the plan: budgeted at the ceiling, so reality can only be more charitable than
				this.
			</span>
		</div>
	);
}

function EditableCells({
	draft,
	setDraft,
	onCommit,
	onCancel,
	busy,
}: {
	draft: DraftInputs;
	setDraft: (d: DraftInputs) => void;
	onCommit: () => void;
	onCancel: () => void;
	busy: boolean;
}) {
	const numCell = (
		key: "accounts" | "payingShare" | "staff" | "tooling" | "services",
		step?: string,
	) => (
		<input
			className="input input-bordered input-xs w-24 text-right tabular-nums"
			type="number"
			step={step}
			value={draft[key] === undefined ? "" : String(draft[key])}
			onChange={(e) =>
				setDraft({ ...draft, [key]: e.target.value === "" ? undefined : Number(e.target.value) })
			}
		/>
	);
	return (
		<>
			<td>
				<input
					className="input input-bordered input-xs w-44"
					value={draft.label ?? ""}
					onChange={(e) => setDraft({ ...draft, label: e.target.value })}
				/>
			</td>
			<td className="text-right">{numCell("accounts")}</td>
			<td className="text-right">{numCell("payingShare", "0.01")}</td>
			<td colSpan={3} className="text-right">
				<div className="grid grid-cols-3 gap-1">
					{(["staff", "tooling", "services"] as const).map((k) => (
						<span key={k} className="text-xs whitespace-nowrap">
							{k}{" "}
							<input
								className="input input-bordered input-xs w-20 text-right tabular-nums"
								type="number"
								aria-label={`${k}, dollars per month`}
								value={draft[k] === undefined ? "" : String(draft[k])}
								onChange={(e) =>
									setDraft({
										...draft,
										[k]: e.target.value === "" ? undefined : Number(e.target.value),
									})
								}
							/>
						</span>
					))}
				</div>
			</td>
			<td colSpan={4} className="text-right">
				<button type="button" className="btn btn-primary btn-xs" disabled={busy} onClick={onCommit}>
					Commit
				</button>
				<button type="button" className="btn btn-ghost btn-xs ml-1" onClick={onCancel}>
					Cancel
				</button>
			</td>
		</>
	);
}

function PhaseEditorHeading({
	phase,
	onPrev,
	onNext,
}: {
	phase: PhaseRow;
	onPrev: () => void;
	onNext: () => void;
}) {
	return (
		<div className="flex items-center gap-3 mt-8">
			<button type="button" className="btn btn-ghost btn-xs" onClick={onPrev}>
				&larr;
			</button>
			<SectionHeading>{`Phase ${phase.phase} — ${phase.label}`}</SectionHeading>
			<button type="button" className="btn btn-ghost btn-xs" onClick={onNext}>
				&rarr;
			</button>
		</div>
	);
}

/** The phase as a flow: revenue in, the three obligations and the residual out. Sankey-shaped. */
function PhaseDiagram({ ledger: L, phase: p }: { ledger: Ledger; phase: PhaseRow }) {
	const rev = L.charitableRevenue;
	const bands = [
		{
			label: "Admin",
			value: L.adminBudget,
			color: "#6d28d9",
			note: `budget ${(L.adminCeiling * 100).toFixed(0)}% · actual ops ${rev > 0 ? sharePct(rev, L.adminActual) : "—"}`,
		},
		{
			label: "Time Pool Fund",
			value: L.fund,
			color: "#2563eb",
			note: `$${L.freeSlice.toFixed(3)} per free account · ${Math.round(L.freeAccounts).toLocaleString("en-US")} free accounts`,
		},
		{
			label: "Free storage",
			value: L.freeStorage,
			color: "#0891b2",
			note: "combined floors and paying rungs' allowances",
		},
		{
			label: "Programs",
			value: L.programs,
			color: "#059669",
			note: L.solvent ? "the residual" : "DEFICIT — this row cannot be afforded",
		},
	];
	const width = 720;
	const drawn = bands.reduce((a, b) => a + b.value, 0);
	const scale = 160 / Math.max(rev, drawn);
	const gap = 2;
	return (
		<figure className="mb-4">
			<svg
				viewBox={`0 0 ${width} 200`}
				className="w-full max-w-3xl"
				role="img"
				aria-label="The phase as a flow: revenue in, Admin, the Time Pool Fund, free storage and programs out"
			>
				<rect x={0} y={0} width={40} height={160} fill="#4f46e5" opacity={0.85} />
				<text x={4} y={175} fontSize={11} className="fill-current">
					Revenue ${Math.round(rev).toLocaleString("en-US")}/mo
				</text>
				<text x={4} y={190} fontSize={11} className="fill-current" opacity={0.6}>
					{p.accounts.toLocaleString("en-US")} accounts · {shareLabel(p.payingShare)} paying
				</text>
				{bands.map((b, i) => {
					const y = bands.slice(0, i).reduce((a, bb) => a + bb.value * scale + gap, 0);
					const h = Math.max(2, b.value * scale);
					return (
						<g key={b.label}>
							<rect x={120} y={y} width={120} height={h} fill={b.color} opacity={0.85} />
							<line
								x1={40}
								y1={80}
								x2={120}
								y2={y + h / 2}
								stroke={b.color}
								strokeWidth={Math.max(2, h / 4)}
								opacity={0.4}
							/>
							<text x={250} y={y + Math.min(h / 2, 12)} fontSize={12} className="fill-current">
								{b.label} — {rev > 0 ? sharePct(rev, b.value) : "0%"} · $
								{Math.round(b.value).toLocaleString("en-US")}/mo
							</text>
							<text
								x={250}
								y={y + Math.min(h / 2, 12) + 14}
								fontSize={11}
								className="fill-current"
								opacity={0.6}
							>
								{b.note}
							</text>
						</g>
					);
				})}
			</svg>
		</figure>
	);
}

function sharePct(revenue: number, dollars: number): string {
	return revenue > 0 ? `${((dollars / revenue) * 100).toFixed(1)}%` : "—";
}

function PhaseDetail({ ledger: L }: { ledger: Ledger }) {
	return (
		<div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-8">
			<Fact
				label="Paying / free accounts"
				value={`${Math.round(L.payingAccounts).toLocaleString("en-US")} / ${Math.round(L.freeAccounts).toLocaleString("en-US")}`}
			/>
			<Fact label="Creators (modeled cap)" value={Math.round(L.creators).toLocaleString("en-US")} />
			<Fact
				label="Paid to creators by time"
				value={`$${Math.round(L.timePoolToCreators).toLocaleString("en-US")}/mo`}
			/>
			<Fact
				label="Admin: actual vs budget"
				value={`${both(L.charitableRevenue, L.adminActual)} vs ${both(L.charitableRevenue, L.adminBudget)}`}
			/>
		</div>
	);
}

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div className="border border-base-300 rounded-lg p-3">
			<div className="text-xs text-base-content/60">{label}</div>
			<div className="tabular-nums">{value}</div>
		</div>
	);
}
