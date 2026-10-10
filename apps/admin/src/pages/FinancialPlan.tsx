// SPDX-License-Identifier: Apache-2.0
/**
 * The Financial Plan — the admin console's planning tool.
 *
 * A table of phases (the raw data host), always editable: the inputs live in the
 * cells at all times and save as they change, and a radio at each row's left edge
 * picks the phase the flow diagram draws. The computed ledger comes from
 * `planLedger` in `@anthers/shared/financial-plan` — the same math the server
 * serves and every generator runs — computed against the local draft, so the
 * computed columns restate as fast as typing with no round trip. The server stays
 * the source of truth for what persists: edits PUT through as they settle, and a
 * reload replaces local state wholesale. Inputs save; computed values never do.
 *
 * The plan's settled shape (2026-10-07): admin budgeted at the full 30% ceiling
 * — the growth budget, because covering out-of-pocket infrastructure and
 * eventually compensation is the sustainability the org grows into; the Time
 * Pool Fund at a stated share of the remainder after admin; programs the
 * residual. A phase may override either share; blank means "use the settings".
 * The projection horizon is inflection 1 and stops there.
 *
 * Every figure is % of charitable revenue AND $/month, both, everywhere — the
 * operator reads a plan in dollars and audits it in shares.
 */

import { type PlanLedger, planLedger } from "@anthers/shared/financial-plan";
import { apiFetch } from "@anthers/web-shared/rpc";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveContainer, Sankey, type SankeyLinkProps, type SankeyNodeProps } from "recharts";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../components/ui";
import { useAdminData } from "../lib/load";

interface Settings {
	adminBudgetShare: number;
	fundShare: number;
}

/** One phase's editable inputs — what the operator edits and what saves. */
interface RowDraft {
	id: number;
	phase: number;
	label: string;
	accounts: number | null;
	payingShare: number | null;
	staff: number | null;
	tooling: number | null;
	services: number | null;
	/** Overrides of the settings' shares; null inherits (and an emptied input clears back). */
	adminBudgetShare: number | null;
	fundShare: number | null;
}

interface PlanPayload {
	settings: Settings;
	phases: Array<RowDraft & { ledger: PlanLedger }>;
}

/** Both forms, always: "54.2% · $27,332/mo" — percentage and dollars. */
function both(revenue: number, dollars: number): string {
	const pct = revenue > 0 ? `${((dollars / revenue) * 100).toFixed(1)}%` : "—";
	return `${pct} · $${Math.round(dollars).toLocaleString("en-US")}`;
}

function usd(n: number): string {
	return `$${Math.round(n).toLocaleString("en-US")}`;
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

const SAVE_DEBOUNCE_MS = 700;
const AUTO_SAVE_ERROR = "The last edit was refused — it is still pending on this row.";

export default function FinancialPlan() {
	const plan = useAdminData<PlanPayload>("/api/admin/financial-plan");
	const [settings, setSettings] = useState<Settings | null>(null);
	const [rows, setRows] = useState<RowDraft[]>([]);
	const [selectedId, setSelectedId] = useState<number | null>(null);
	const [saveState, setSaveState] = useState<{
		saving: boolean;
		error: string | null;
		savedAt: Date | null;
	}>({ saving: false, error: null, savedAt: null });
	/** Rows with edits not yet confirmed by the server. */
	const [pending, setPending] = useState<Set<number>>(new Set());
	const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	/** An error from an explicit action (settings save, add, delete) rather than an autosave. */
	const [actionError, setActionError] = useState<string | null>(null);

	// Refs the debounced savers read so a timer always saves the newest state.
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	/** Last values the server is known to hold, per row: dirty = draft differs from it. */
	const savedRef = useRef<Map<number, RowDraft>>(new Map());
	const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

	// Adopt server data wholesale. A reload is an explicit action (initial load,
	// Refresh, a settings save, add/delete) and pending edits are flushed first,
	// so this never clobbers typing in flight.
	useEffect(() => {
		const data = plan.data;
		if (!data) return;
		setSettings(data.settings);
		setRows(data.phases.map(toDraft));
		savedRef.current = new Map(data.phases.map((p) => [p.id, toDraft(p)]));
		setSelectedId((prev) =>
			prev !== null && data.phases.some((p) => p.id === prev)
				? prev
				: (data.phases.at(-1)?.id ?? null),
		);
	}, [plan.data]);

	// Persist nothing mid-flight at unmount.
	useEffect(
		() => () => {
			for (const t of timersRef.current.values()) clearTimeout(t);
			timersRef.current.clear();
		},
		[],
	);

	/** The ledger of the draft as it stands — the shared math, computed locally. */
	const ledgers = useMemo(() => {
		const m = new Map<number, PlanLedger>();
		for (const r of rows) {
			m.set(
				r.id,
				planLedger({
					accounts: r.accounts ?? 1,
					payingShare: r.payingShare ?? 0,
					staffing: {
						staff: r.staff ?? 0,
						tooling: r.tooling ?? 0,
						services: r.services ?? 0,
					},
					adminBudgetShare: r.adminBudgetShare ?? settings?.adminBudgetShare ?? undefined,
					fundShare: r.fundShare ?? settings?.fundShare ?? undefined,
				}),
			);
		}
		return m;
	}, [rows, settings]);

	const dirty = (r: RowDraft): boolean => {
		const s = savedRef.current.get(r.id);
		if (!s) return true;
		return (
			r.label.trim() !== s.label.trim() ||
			r.accounts !== s.accounts ||
			r.payingShare !== s.payingShare ||
			r.staff !== s.staff ||
			r.tooling !== s.tooling ||
			r.services !== s.services ||
			r.adminBudgetShare !== s.adminBudgetShare ||
			r.fundShare !== s.fundShare
		);
	};

	/** Whether the draft can be sent at all: every required input a valid number/label. */
	const valid = (r: RowDraft): boolean =>
		r.label.trim().length >= 1 &&
		r.accounts !== null &&
		r.payingShare !== null &&
		r.staff !== null &&
		r.tooling !== null &&
		r.services !== null &&
		r.accounts >= 1 &&
		r.payingShare >= 0 &&
		r.payingShare <= 1;

	const saveRowNow = async (id: number): Promise<boolean> => {
		const r = rowsRef.current.find((x) => x.id === id);
		if (!r) return false;
		const t = timersRef.current.get(id);
		if (t) {
			clearTimeout(t);
			timersRef.current.delete(id);
		}
		if (!dirty(r)) {
			setPending((p) => drop(p, id));
			return true;
		}
		if (!valid(r)) return false; // stays pending until the operator finishes the edit
		const draft: RowDraft = { ...r, label: r.label.trim() };
		setSaveState((s) => ({ ...s, saving: true, error: null }));
		try {
			await send(`/api/admin/financial-plan/phases/${id}`, "PUT", {
				label: draft.label,
				accounts: draft.accounts,
				payingShare: draft.payingShare,
				staff: draft.staff,
				tooling: draft.tooling,
				services: draft.services,
				adminBudgetShare: draft.adminBudgetShare,
				fundShare: draft.fundShare,
			});
			savedRef.current.set(id, { ...draft, adminBudgetShare: draft.adminBudgetShare });
			setPending((p) => drop(p, id));
			setSaveState({ saving: false, error: null, savedAt: new Date() });
			return true;
		} catch (e) {
			setSaveState({
				saving: false,
				error: e instanceof Error ? e.message : AUTO_SAVE_ERROR,
				savedAt: null,
			});
			return false;
		}
	};

	/** Schedule (or reschedule) this row's debounced save. */
	const scheduleSave = (id: number) => {
		setPending((p) => new Set(p).add(id));
		const t = timersRef.current.get(id);
		if (t) clearTimeout(t);
		timersRef.current.set(
			id,
			setTimeout(() => {
				timersRef.current.delete(id);
				void saveRowNow(id);
			}, SAVE_DEBOUNCE_MS),
		);
	};

	/** One field's edit: update the draft, then queue the save. */
	const edit = (id: number, patch: Partial<RowDraft>, schedule = true) => {
		setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
		if (schedule) scheduleSave(id);
	};

	/** Flush every pending row save; true only when everything landed. */
	const flushAll = async (): Promise<boolean> => {
		const ids = [...pending];
		if (ids.length === 0) return true;
		const results = await Promise.all(ids.map((id) => saveRowNow(id)));
		return results.every(Boolean);
	};

	/** Reload the plan from the server, first giving pending edits the chance to land. */
	const reloadPreservingEdits = async () => {
		if (await flushAll()) void plan.reload();
	};

	async function saveSettings(next: Settings) {
		setBusy(true);
		setActionError(null);
		try {
			if (!(await flushAll())) throw new Error(AUTO_SAVE_ERROR);
			const res = (await send("/api/admin/financial-plan/settings", "PUT", next)) as Settings;
			setSettings(res);
			setSaveState((s) => ({ ...s, savedAt: new Date() }));
			reloadPreservingEdits();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "The settings edit was refused.");
		} finally {
			setBusy(false);
		}
	}

	async function addPhase() {
		const last = rows.at(-1);
		setBusy(true);
		setActionError(null);
		try {
			if (!(await flushAll())) throw new Error(AUTO_SAVE_ERROR);
			await send("/api/admin/financial-plan/phases", "POST", {
				label: "New phase",
				accounts: Math.max(1_000, Math.round(((last?.accounts ?? 1_000) || 1_000) * 1.5)),
				payingShare: last?.payingShare ?? 0.3,
				staff: 0,
				tooling: 0,
				services: 0,
			});
			void plan.reload();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "The phase was not created.");
		} finally {
			setBusy(false);
		}
	}

	async function deleteRow(id: number) {
		setBusy(true);
		setActionError(null);
		try {
			if (!(await flushAll())) throw new Error(AUTO_SAVE_ERROR);
			await send(`/api/admin/financial-plan/phases/${id}`, "DELETE");
			if (selectedId === id) setSelectedId(null); // the sync effect reselects the last row
			void plan.reload();
		} catch (e) {
			setActionError(e instanceof Error ? e.message : "The phase was not deleted.");
		} finally {
			setBusy(false);
		}
	}

	// The early returns sit after the hooks; a background refresh failing over
	// existing data keeps that data on screen rather than tearing the page down.
	if (plan.error && !plan.data) return <ErrorAlert>{plan.error}</ErrorAlert>;
	if (!plan.data || !settings) return <Loading />;

	const sel = rows.find((r) => r.id === selectedId) ?? rows.at(-1) ?? null;

	return (
		<>
			<PageHeader
				title="Financial Plan"
				description="The plan from here through full-time — admin budgeted at the ceiling, the Fund beside it, programs the residual. Every figure is a share of revenue and dollars per month. Edits here are the plan; public resources generate from this data."
				onRefresh={() => void reloadPreservingEdits()}
				loading={plan.loading}
			/>
			{plan.error && <ErrorAlert>{plan.error}</ErrorAlert>}
			{actionError && <ErrorAlert>{actionError}</ErrorAlert>}

			<SectionHeading>
				Settings — the shares every phase defaults to (a phase may override)
			</SectionHeading>
			<SettingsEditor settings={settings} onSave={saveSettings} busy={busy} />

			<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
				<SectionHeading>
					The path — every input cell is live, and the radio picks the phase the flow draws
				</SectionHeading>
				<SaveBadge state={saveState} pending={pending.size} />
			</div>
			{!saveState.saving && saveState.error && <ErrorAlert>{saveState.error}</ErrorAlert>}

			<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
				<table className="table table-sm">
					<thead>
						<tr>
							<th
								colSpan={9}
								className="text-xs uppercase tracking-wider text-base-content/60 border-l-2 border-l-primary/40"
							>
								Inputs — edit freely
							</th>
							<th colSpan={8} className="text-xs uppercase tracking-wider text-base-content/40">
								Computed — restates as you type
							</th>
						</tr>
						<tr>
							<th title="Draw this phase in the flow diagram" />
							<th>Phase</th>
							<th className="text-right">Accounts</th>
							<th className="text-right">Paying</th>
							<th className="text-right">Staff</th>
							<th className="text-right">Tooling</th>
							<th className="text-right">Services</th>
							<th
								className="text-right"
								title="Blank uses the settings' share; a number overrides it for this phase only"
							>
								Admin %
							</th>
							<th
								className="text-right"
								title="Blank uses the settings' share; a number overrides it for this phase only"
							>
								Fund %
							</th>
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
						{rows.map((r) => {
							const L = ledgers.get(r.id);
							if (!L) return null;
							const saved = savedRef.current.get(r.id);
							return (
								<tr
									key={r.id}
									className={`hover:bg-base-200 ${sel?.id === r.id ? "bg-primary/5" : ""} ${!L.solvent ? "bg-error/10" : ""}`}
								>
									<td>
										<input
											type="radio"
											name="plan-phase"
											className="radio radio-primary radio-xs"
											checked={sel?.id === r.id}
											onChange={() => setSelectedId(r.id)}
											aria-label={`Draw phase ${r.phase} — ${r.label}`}
										/>
									</td>
									<td>
										<div className="flex flex-col gap-0.5">
											<div className="flex items-center gap-2">
												<strong className="tabular-nums">{r.phase}</strong>
												{pending.has(r.id) && (
													<span
														className="inline-block h-2 w-2 rounded-full bg-warning"
														title="Unsaved edit on this row"
													/>
												)}
												<TextInput
													value={r.label}
													invalid={r.label.trim() === ""}
													onChange={(v) => edit(r.id, { label: v })}
													onBlur={() => {
														const s = savedRef.current.get(r.id);
														if (s && r.label.trim() === "" && s.label.trim() !== "")
															edit(r.id, { label: s.label }, false);
													}}
													ariaLabel={`Phase ${r.phase} label`}
													w="w-44"
												/>
											</div>
											<div className="flex gap-1">
												{!L.solvent && (
													<span className="badge badge-error badge-xs badge-outline">deficit</span>
												)}
												{!L.adminWithinCeiling && (
													<span className="badge badge-warning badge-xs badge-outline">
														ops over
													</span>
												)}
											</div>
										</div>
									</td>
									<NumCell row={r} field="accounts" saved={saved} step="1" edit={edit} w="w-24" />
									<ShareCell row={r} field="payingShare" saved={saved} edit={edit} />
									<NumCell row={r} field="staff" saved={saved} step="50" edit={edit} w="w-24" />
									<NumCell row={r} field="tooling" saved={saved} step="50" edit={edit} w="w-24" />
									<NumCell row={r} field="services" saved={saved} step="50" edit={edit} w="w-24" />
									<OverrideCell
										row={r}
										field="adminBudgetShare"
										settings={settings}
										saved={saved}
										edit={edit}
									/>
									<OverrideCell
										row={r}
										field="fundShare"
										settings={settings}
										saved={saved}
										edit={edit}
									/>
									<ComputedCell value={usd(L.charitableRevenue)} strong />
									<ComputedCell value={both(L.charitableRevenue, L.adminBudget)} />
									<ComputedCell value={both(L.charitableRevenue, L.adminActual)} />
									<ComputedCell value={both(L.charitableRevenue, L.fund)} />
									<ComputedCell value={both(L.charitableRevenue, L.freeStorage)} />
									<ComputedCell value={both(L.charitableRevenue, L.programs)} />
									<ComputedCell value={`$${L.freeSlice.toFixed(3)}`} />
									<td className="text-right">
										<DeleteButton
											armed={confirmDeleteId === r.id}
											onArm={() => {
												setConfirmDeleteId(r.id);
												setTimeout(() => setConfirmDeleteId((c) => (c === r.id ? null : c)), 3000);
											}}
											onConfirm={() => void deleteRow(r.id)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<div className="mt-2">
				<button
					type="button"
					className="btn btn-outline btn-sm"
					disabled={busy}
					onClick={() => void addPhase()}
				>
					+ Add phase
				</button>
			</div>

			{sel && ledgers.get(sel.id) && (
				<>
					<div className="mt-10">
						<SectionHeading>{`Phase ${sel.phase} — ${sel.label}`}</SectionHeading>
					</div>
					<PhaseDiagram ledger={ledgers.get(sel.id)!} />
				</>
			)}
		</>
	);
}

function drop(set: Set<number>, id: number): Set<number> {
	const next = new Set(set);
	next.delete(id);
	return next;
}

function toDraft(p: PlanPayload["phases"][number]): RowDraft {
	return {
		id: p.id,
		phase: p.phase,
		label: p.label,
		accounts: p.accounts,
		payingShare: p.payingShare,
		staff: p.staff,
		tooling: p.tooling,
		services: p.services,
		adminBudgetShare: p.adminBudgetShare,
		fundShare: p.fundShare,
	};
}

// ── Cells ────────────────────────────────────────────────────────────────────

// Spinner buttons are hidden in every number cell: at cell scale they overlap the digits, and the keyboard's arrow keys increment either way.
const NUM_INPUT =
	"input input-bordered input-xs tabular-nums text-right focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function TextInput(props: {
	value: string;
	invalid?: boolean;
	onChange: (v: string) => void;
	onBlur?: () => void;
	ariaLabel: string;
	w: string;
}) {
	return (
		<input
			type="text"
			className={`${NUM_INPUT} ${props.w} ${props.invalid ? "input-error" : ""}`}
			value={props.value}
			onChange={(e) => props.onChange(e.target.value)}
			onBlur={props.onBlur}
			aria-label={props.ariaLabel}
		/>
	);
}

/** A required number: an emptied or out-of-range field is invalid and blocks the row's save. */
function NumCell(props: {
	row: RowDraft;
	field: "accounts" | "staff" | "tooling" | "services";
	saved: RowDraft | undefined;
	step: string;
	edit: (id: number, patch: Partial<RowDraft>, schedule?: boolean) => void;
	w: string;
}) {
	const value = props.row[props.field] ?? null;
	const invalid =
		value === null || Number.isNaN(value) || (props.field === "accounts" && value < 1);
	return (
		<td className="text-right">
			<input
				type="number"
				className={`${NUM_INPUT} ${props.w} ${invalid ? "input-error" : ""}`}
				step={props.step}
				value={value === null ? "" : String(value)}
				onChange={(e) =>
					props.edit(props.row.id, {
						[props.field]: e.target.value === "" ? null : e.target.valueAsNumber,
					})
				}
				onBlur={() => {
					const s = props.saved;
					if (s && (invalid || Number.isNaN(value)))
						props.edit(props.row.id, { [props.field]: s[props.field] } as Partial<RowDraft>, false);
				}}
				aria-label={`${props.field}, phase ${props.row.phase}`}
			/>
		</td>
	);
}

function ShareCell(props: {
	row: RowDraft;
	field: "payingShare";
	saved: RowDraft | undefined;
	edit: (id: number, patch: Partial<RowDraft>, schedule?: boolean) => void;
}) {
	const value = props.row.payingShare;
	const invalid = value === null || Number.isNaN(value) || value < 0 || value > 1;
	return (
		<td className="text-right">
			<div className="flex items-center justify-end gap-1">
				<input
					type="number"
					className={`${NUM_INPUT} w-20 ${invalid ? "input-error" : ""}`}
					step="0.01"
					value={value === null ? "" : String(value)}
					onChange={(e) =>
						props.edit(props.row.id, {
							payingShare: e.target.value === "" ? null : e.target.valueAsNumber,
						})
					}
					onBlur={() => {
						const s = props.saved;
						if (s && invalid) props.edit(props.row.id, { payingShare: s.payingShare }, false);
					}}
					aria-label={`Paying share, phase ${props.row.phase}`}
				/>
				<span className="text-[10px] opacity-50">%</span>
			</div>
		</td>
	);
}

/** Optional per-phase override; blank = the settings' share (placeholder shows what that is). */
function OverrideCell(props: {
	row: RowDraft;
	field: "adminBudgetShare" | "fundShare";
	settings: Settings;
	saved: RowDraft | undefined;
	edit: (id: number, patch: Partial<RowDraft>, schedule?: boolean) => void;
}) {
	const value = props.row[props.field];
	const setting =
		props.field === "adminBudgetShare" ? props.settings.adminBudgetShare : props.settings.fundShare;
	const invalid = value !== null && (Number.isNaN(value) || value < 0 || value > 1);
	return (
		<td className="text-right">
			<input
				type="number"
				className={`${NUM_INPUT} w-20 ${invalid ? "input-error" : ""} ${value === null ? "opacity-60" : ""}`}
				step="0.01"
				placeholder={`${(setting * 100).toFixed(0)}`}
				value={value === null ? "" : String(value)}
				onChange={(e) =>
					props.edit(props.row.id, {
						[props.field]: e.target.value === "" ? null : e.target.valueAsNumber,
					})
				}
				onBlur={() => {
					if (!invalid) return;
					props.edit(
						props.row.id,
						props.saved
							? ({ [props.field]: props.saved[props.field] } as Partial<RowDraft>)
							: ({ [props.field]: null } as Partial<RowDraft>),
						false,
					);
				}}
				aria-label={`${props.field} override, phase ${props.row.phase}`}
			/>
		</td>
	);
}

function ComputedCell({ value, strong }: { value: string; strong?: boolean }) {
	return (
		<td
			className={`text-right tabular-nums whitespace-nowrap ${strong ? "font-semibold" : "text-base-content/70"}`}
		>
			{value}
		</td>
	);
}

/** Two-step delete: first click arms it, second (within 3s) deletes. */
function DeleteButton(props: { armed: boolean; onArm: () => void; onConfirm: () => void }) {
	return (
		<button
			type="button"
			className={`btn btn-ghost btn-xs ${props.armed ? "btn-error text-error-content" : "text-base-content/40 hover:text-error"}`}
			onClick={props.armed ? props.onConfirm : props.onArm}
			title={props.armed ? "Click again to delete this phase" : "Delete this phase"}
		>
			{props.armed ? "Sure?" : "✕"}
		</button>
	);
}

function SaveBadge({
	state,
	pending,
}: {
	state: { saving: boolean; savedAt: Date | null };
	pending: number;
}) {
	return (
		<span className="flex items-center gap-2 text-xs text-base-content/60">
			{state.saving ? (
				<>
					<span className="loading loading-spinner loading-xs" /> Saving…
				</>
			) : pending > 0 ? (
				<span className="text-warning">
					{pending} row{pending === 1 ? "" : "s"} with unsaved edits
				</span>
			) : state.savedAt ? (
				<>
					<span className="inline-block h-2 w-2 rounded-full bg-success" /> Saved{" "}
					{state.savedAt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
				</>
			) : null}
		</span>
	);
}

function SettingsEditor({
	settings,
	onSave,
	busy,
}: {
	settings: Settings;
	onSave: (b: Settings) => void;
	busy: boolean;
}) {
	const [admin, setAdmin] = useState(settings.adminBudgetShare);
	const [fund, setFund] = useState(settings.fundShare);
	return (
		<div className="mb-6 flex flex-wrap items-end gap-4 rounded-box border border-base-300 bg-base-100 p-4">
			<label className="text-sm" htmlFor="fp-admin-share">
				<div>Admin budget (share of revenue)</div>
				<input
					className="input input-bordered input-sm mt-1 w-28 tabular-nums"
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
				<div>Time Pool Fund (share of remainder after admin)</div>
				<input
					className="input input-bordered input-sm mt-1 w-28 tabular-nums"
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
				this. A phase's Admin % / Fund % cells override these for that phase alone.
			</span>
		</div>
	);
}
// ── The phase diagram ────────────────────────────────────────────────────────

/**
 * The phase as a flow, drawn on Recharts' Sankey (d3-sankey under it) in three
 * columns, styled after the retired signup page's *Where Your Money Goes*:
 * minimal on-graph labels (name and dollars only, riding their own capsule),
 * the detail carried by a legend above and the facts below, and the whole
 * container's width available to the drawing.
 *
 * Column two is the obligations the ledger books — the admin budget, the Time
 * Pool Fund, free storage, programs — and column three opens the spending:
 * the admin budget's five lines (infrastructure, staffing, tooling, services,
 * reserves, plus the headroom the budget holds unspent) and free storage's
 * two parts. Every column-conservation guarantee the ledger makes is drawn,
 * so the ribbons cannot invent or lose a dollar; an over-budget row skips
 * headroom and its children simply overshoot the parent's capsule, which the
 * red note below names.
 */
interface StreamGroup {
	key: string;
	name: string;
	color: string;
	prose: ReactNode;
}

interface DiagramNode {
	name: string;
	/** The capsule's fill — the group's color, or the revenue bar's. */
	fill: string;
	/** The stream this node belongs to; hover dims everything outside one. */
	group: string;
	/**
	 * The on-graph label, preformatted from the LEDGER's figure — never from a
	 * layout value: d3-sankey overwrites a node's `value` with its own (max of
	 * in/out sums), so an over-spent budget's node reads its children's sum,
	 * and a label that trusted it would print the wrong dollar figure.
	 */
	label: string;
	/** Set on a node whose figure is a warning: ops over the budget, or the residual negative. */
	warn?: "opsOver" | "insolvent";
	/** The ledger's figure for this node — layout input; d3 overwrites it with its own, so labels never read it. */
	value: number;
}

interface DiagramLink {
	source: number;
	target: number;
	value: number;
	group: string;
	/** The ribbon's stroke — the stream's color. */
	stroke: string;
}

function PhaseDiagram({ ledger: L }: { ledger: PlanLedger }) {
	const [hover, setHover] = useState<string | null>(null);
	const rev = L.charitableRevenue;
	const S = L.spending;
	const C = {
		revenue: "#4f46e5",
		admin: "#6d28d9",
		fund: "#2563eb",
		storage: "#0891b2",
		programs: "#059669",
	};

	const groups: StreamGroup[] = [
		{
			key: "admin",
			name: "Admin budget",
			color: C.admin,
			prose: (
				<>
					The growth budget, locked at ${(L.adminCeiling * 100).toFixed(0)}% of revenue — covering
					out-of-pocket infrastructure is why it is budgeted at the ceiling. At this scale it covers
					infrastructure, staff, tooling, services and reserves;{" "}
					{L.adminWithinCeiling
						? `$${Math.round(S.headroom).toLocaleString("en-US")}/mo stays headroom`
						: "actual spend exceeds it"}
					.
				</>
			),
		},
		{
			key: "fund",
			name: "Time Pool Fund",
			color: C.fund,
			prose: (
				<>
					Free accounts&rsquo; Time Pools together — ${L.freeSlice.toFixed(2)} per free account,{" "}
					{Math.round(L.freeAccounts).toLocaleString("en-US")} free accounts — funded from the
					remainder after admin.
				</>
			),
		},
		{
			key: "storage",
			name: "Free storage",
			color: C.storage,
			prose: (
				<>
					Storage nobody is charged for: free and new creators&rsquo; catalogs ( $
					{Math.round(S.freeCatalog).toLocaleString("en-US")}/mo) and the bundled allowances every
					paying rung grants (${Math.round(S.payingAllowances).toLocaleString("en-US")}/mo), both
					paid to the vendor at cost.
				</>
			),
		},
		{
			key: "programs",
			name: "Programs",
			color: C.programs,
			prose: L.solvent ? (
				<>
					The residual after every obligation — charitable programs, budgeted but not yet allocated;
					the dial to watch as the path scales.
				</>
			) : (
				<>
					DEFICIT — the obligations overrun revenue at this phase; this row cannot be afforded as
					modeled.
				</>
			),
		},
	];

	// ── Nodes and links: revenue → obligations → spending lines ──
	/**
	 * Every obligation breaks open in column three — including the two whose
	 * outflow is a single line (the Fund's pot IS the free accounts' pools; a
	 * program's residual sits unallocated until spent) — because d3-sankey
	 * assigns columns by longest path: a childless obligation falls into the
	 * last column beside the spending lines and the obligations' column loses
	 * its row. The named single-child lines keep the middle column whole and
	 * give the two residual streams an honest destination label. Column three
	 * is ordered to mirror column two, so no ribbon of one stream crosses a
	 * neighbor's.
	 */
	const obligationNodes: DiagramNode[] = [
		{
			name: "admin",
			fill: C.admin,
			group: "admin",
			label: `Admin budget ${usd(L.adminBudget)}`,
			value: L.adminBudget,
			...(L.adminWithinCeiling ? {} : { warn: "opsOver" as const }),
		},
		{
			name: "fund",
			fill: C.fund,
			group: "fund",
			label: `Time Pool Fund ${usd(L.fund)}`,
			value: L.fund,
		},
		{
			name: "storage",
			fill: C.storage,
			group: "storage",
			label: `Free storage ${usd(L.freeStorage)}`,
			value: L.freeStorage,
		},
		{
			name: "programs",
			fill: C.programs,
			group: "programs",
			label: `Programs ${usd(Math.max(0, L.programs))}`,
			value: Math.max(0, L.programs),
			...(L.solvent ? {} : { warn: "insolvent" as const }),
		},
	];
	const childNodes: DiagramNode[] = [
		{
			name: "infra",
			fill: C.admin,
			group: "admin",
			label: `Infrastructure ${usd(S.infrastructure)}`,
			value: S.infrastructure,
		},
		{
			name: "staff",
			fill: C.admin,
			group: "admin",
			label: `Staff ${usd(S.staff)}`,
			value: S.staff,
		},
		{
			name: "tooling",
			fill: C.admin,
			group: "admin",
			label: `Tooling ${usd(S.tooling)}`,
			value: S.tooling,
		},
		{
			name: "services",
			fill: C.admin,
			group: "admin",
			label: `Services ${usd(S.services)}`,
			value: S.services,
		},
		{
			name: "reserves",
			fill: C.admin,
			group: "admin",
			label: `Reserves ${usd(S.reserves)}`,
			value: S.reserves,
		},
		...(S.headroom > 1
			? [
					{
						name: "headroom",
						fill: C.admin,
						group: "admin",
						label: `Headroom ${usd(S.headroom)}`,
						value: S.headroom,
					},
				]
			: []),
		{
			name: "freePools",
			fill: C.fund,
			group: "fund",
			label: `Free Time Pools ${usd(L.fund)}`,
			value: L.fund,
		},
		{
			name: "freeCatalog",
			fill: C.storage,
			group: "storage",
			label: `Free creators' catalogs ${usd(S.freeCatalog)}`,
			value: S.freeCatalog,
		},
		{
			name: "payingAllowances",
			fill: C.storage,
			group: "storage",
			label: `Paying rungs' allowances ${usd(S.payingAllowances)}`,
			value: S.payingAllowances,
		},
		{
			name: "unallocated",
			fill: C.programs,
			group: "programs",
			label: `Unallocated ${usd(Math.max(0, L.programs))}`,
			value: Math.max(0, L.programs),
		},
		// Zero-valued lines draw nothing — a phase with no staff shows no staff
		// capsule — and their absence changes no conservation: they carried 0.
	].filter((c) => c.value > 1);

	const parentNode = (group: string): number =>
		1 + obligationNodes.findIndex((o) => o.name === group);
	const allChildren = childNodes.filter((c) => c.value > 1);
	const nodes: DiagramNode[] = [
		{
			name: "revenue",
			fill: C.revenue,
			group: "revenue",
			label: `Revenue ${usd(rev)}`,
			value: rev,
		},
		...obligationNodes,
		...allChildren,
	];
	const byName = new Map(nodes.map((n, i) => [n.name, i]));
	const links: DiagramLink[] = [
		...obligationNodes.map((o) => ({
			source: 0,
			target: byName.get(o.name)!,
			value: o.value,
			group: o.group,
			stroke: o.fill,
		})),
		...allChildren.map((c) => ({
			source: parentNode(c.group),
			target: byName.get(c.name)!,
			value: c.value,
			group: c.group,
			stroke: c.fill,
		})),
	];

	const dim = (group: string): number => {
		if (!hover) return 1;
		return hover === group ? 1 : 0.15;
	};

	return (
		<figure className="mb-4 w-full">
			<StreamLegend groups={groups} hover={hover} setHover={setHover} />
			<p className="mb-1 text-xs text-base-content/50">
				Hover any stream, capsule or card to follow it.
			</p>
			<ResponsiveContainer width="100%" height={560}>
				<Sankey
					data={{ nodes, links }}
					nodeWidth={20}
					nodePadding={24}
					linkCurvature={0.55}
					sort={false}
					margin={{ top: 8, right: 64, bottom: 8, left: 8 }}
					role="img"
					aria-label="The phase as a flow: revenue in; the admin budget, the Time Pool Fund, free storage and programs; then the spending each obligation stands over"
					node={(props) => <PhaseNode {...props} dim={dim} />}
					link={(props) => <PhaseLink {...props} dim={dim} />}
					onMouseEnter={(item, type) => {
						if (type === "node") {
							const d = (item as SankeyNodeProps).payload as unknown as DiagramNode;
							setHover(d.group);
						} else {
							const d = (item as SankeyLinkProps).payload as unknown as DiagramLink;
							setHover(d.group);
						}
					}}
					onMouseLeave={() => setHover(null)}
				/>
			</ResponsiveContainer>
			<p className="mt-1 text-xs text-base-content/60">
				{rev > 0 ? sharePct(rev, L.adminBudget) : "—"} of the month&rsquo;s revenue is budgeted to
				admin ({rev > 0 ? sharePct(rev, L.adminActual) : "—"} committed at this scale),{" "}
				{rev > 0 ? sharePct(rev, L.fund) : "—"} funds the Fund&rsquo;s free pools,{" "}
				{rev > 0 ? sharePct(rev, L.freeStorage) : "—"} covers free storage, and{" "}
				{rev > 0 ? sharePct(rev, Math.max(0, L.programs)) : "—"} remains for programs — dollars per
				month, at this phase&rsquo;s scale.
				{!L.solvent && (
					<span className="text-error">
						{" "}
						The obligations overrun revenue by {usd(-L.programs)}/mo.
					</span>
				)}
				{!L.adminWithinCeiling && (
					<span className="text-error"> Actual ops run {usd(-S.headroom)}/mo over the budget.</span>
				)}
			</p>
			<PhaseDetail ledger={L} />
		</figure>
	);
}

/** The legend above the chart: one card per stream, hover-synced with the ribbons. */
function StreamLegend({
	groups,
	hover,
	setHover,
}: {
	groups: StreamGroup[];
	hover: string | null;
	setHover: (g: string | null) => void;
}) {
	return (
		<div className="mb-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
			{groups.map((g) => (
				// biome-ignore lint/a11y/noStaticElementInteractions: the hover is a pointer shortcut — the card's facts are always visible, and nothing here is mouse-only.
				<div
					key={g.key}
					onMouseEnter={() => setHover(g.key)}
					onMouseLeave={() => setHover(null)}
					className={`rounded-box border p-4 text-xs leading-relaxed transition-colors ${
						hover && hover !== g.key
							? "border-base-300 bg-base-100 opacity-60"
							: "border-base-300 bg-base-100"
					}`}
				>
					<div className="flex items-center gap-2 text-sm font-semibold">
						<span
							aria-hidden="true"
							className="inline-block h-3 w-3 rounded-full"
							style={{ background: g.color }}
						/>
						{g.name}
					</div>
					<p className="mt-1 text-base-content/70">{g.prose}</p>
				</div>
			))}
		</div>
	);
}

interface NodeDrawProps extends SankeyNodeProps {
	dim: (group: string) => number;
}

/**
 * The diagram's nodes: rounded capsules with the on-graph label riding beside
 * — the revenue node labeled to its right, every other node labeled to its
 * left, both single lines. Recharts' layout has already spaced the nodes, so
 * a one-line label needs no crowding logic; it just rides the capsule's
 * vertical center.
 */
function PhaseNode(props: NodeDrawProps) {
	const d = props.payload as unknown as DiagramNode;
	const cy = props.y + props.height / 2;
	const dimmed = d.group !== "revenue" ? props.dim(d.group) : props.dim("revenue");
	return (
		<g opacity={dimmed}>
			<rect
				x={props.x}
				y={props.y}
				width={props.width}
				height={Math.max(3, props.height)}
				rx={props.width / 2}
				fill={d.fill}
				stroke={d.warn ? "#dc2626" : undefined}
				strokeWidth={d.warn ? 1.5 : undefined}
			/>
			{d.name === "revenue" ? (
				<text
					x={props.x + props.width + 10}
					y={cy + 4}
					fontSize={12}
					fontWeight={600}
					className="fill-current"
				>
					{d.label}
				</text>
			) : (
				<text x={props.x - 10} y={cy + 4} fontSize={12} textAnchor="end" className="fill-current">
					{d.label}
				</text>
			)}
		</g>
	);
}

interface LinkDrawProps extends SankeyLinkProps {
	dim: (group: string) => number;
}

/** A link's ribbon: stroke-width proportional to its dollars, in its stream's color. */
function PhaseLink(props: LinkDrawProps) {
	const d = props.payload as unknown as DiagramLink;
	return (
		<path
			d={`M${props.sourceX},${props.sourceY} C${props.sourceControlX},${props.sourceY} ${props.targetControlX},${props.targetY} ${props.targetX},${props.targetY}`}
			fill="none"
			stroke={d.stroke}
			strokeWidth={Math.max(1.5, props.linkWidth)}
			opacity={0.45 * props.dim(d.group)}
		/>
	);
}

function sharePct(revenue: number, dollars: number): string {
	return revenue > 0 ? `${((dollars / revenue) * 100).toFixed(1)}%` : "—";
}

// ── The phase's facts ────────────────────────────────────────────────────────

function PhaseDetail({ ledger: L }: { ledger: PlanLedger }) {
	return (
		<div className="mb-10 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
			<Fact
				label="Paying / free accounts"
				value={`${Math.round(L.payingAccounts).toLocaleString("en-US")} / ${Math.round(L.freeAccounts).toLocaleString("en-US")}`}
			/>
			<Fact label="Creators (modeled cap)" value={Math.round(L.creators).toLocaleString("en-US")} />
			<Fact label="Paid to creators by time" value={`${usd(L.timePoolToCreators)}/mo`} />
			<Fact
				label="Admin: actual vs budget"
				value={`${both(L.charitableRevenue, L.adminActual)} vs ${both(L.charitableRevenue, L.adminBudget)}`}
				tone={!L.adminWithinCeiling ? "warn" : undefined}
			/>
		</div>
	);
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" }) {
	return (
		<div
			className={`rounded-box border p-3 ${
				tone === "warn" ? "border-warning/40 bg-warning/10" : "border-base-300 bg-base-100"
			}`}
		>
			<div className="text-xs text-base-content/60">{label}</div>
			<div className="tabular-nums">{value}</div>
		</div>
	);
}
