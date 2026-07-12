// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Access section's two OR-gated tables. A viewer gets access if EITHER table
 * allows them. Both default to "free but fully locked" (every row allow=false,
 * price "0"). A price of $0 with Allow checked = free at that level; a positive
 * price is a minimum (itch.io style — buyers may pay more).
 */
import type { AnthersAccessRow, BoostAccessRow, CreatorGate } from "../../lib/types";

// ─── Row drafts ───

/** The fixed Anthers Badge tiers, matching the API's tier enum. */
export type AnthersTier = "free" | "root" | "sprout" | "petal" | "blossom";

export interface BoostRowDraft {
	threshold: number;
	label: string;
	allow: boolean;
	price: string;
}

export interface AnthersRowDraft {
	tier: AnthersTier;
	label: string;
	allow: boolean;
	price: string;
}

const ANTHERS_TIERS: { tier: AnthersTier; label: string }[] = [
	{ tier: "free", label: "Free" },
	{ tier: "root", label: "Root" },
	{ tier: "sprout", label: "Sprout" },
	{ tier: "petal", label: "Petal" },
	{ tier: "blossom", label: "Blossom" },
];

/** Coerce a user-entered price to a valid money string ("0" when blank/invalid). */
export function normalizeMoney(v: string): string {
	const t = v.trim();
	if (!t) return "0";
	const n = Number(t);
	if (!Number.isFinite(n) || n < 0) return "0";
	return (Math.round(n * 100) / 100).toString();
}

/** Boost rows = fixed $0 baseline + one row per boost gate (sorted by threshold). */
export function buildBoostRows(
	gates: CreatorGate[],
	existing?: BoostAccessRow[] | null,
): BoostRowDraft[] {
	const byThreshold = new Map<number, BoostAccessRow>();
	for (const r of existing ?? []) byThreshold.set(r.threshold, r);

	const base = byThreshold.get(0);
	const rows: BoostRowDraft[] = [
		{ threshold: 0, label: "Everyone", allow: base?.allow ?? false, price: base?.price ?? "0" },
	];

	const rungs = gates
		.filter((g) => g.gateType === "boost")
		.map((g) => ({ threshold: Number(g.threshold), label: g.label }))
		.sort((a, b) => a.threshold - b.threshold);

	for (const rung of rungs) {
		const ex = byThreshold.get(rung.threshold);
		rows.push({
			threshold: rung.threshold,
			label: rung.label,
			allow: ex?.allow ?? false,
			price: ex?.price ?? "0",
		});
	}
	return rows;
}

/** Anthers rows = the five fixed tiers, hydrated from an existing table if present. */
export function buildAnthersRows(existing?: AnthersAccessRow[] | null): AnthersRowDraft[] {
	const byTier = new Map<string, AnthersAccessRow>();
	for (const r of existing ?? []) byTier.set(r.tier, r);
	return ANTHERS_TIERS.map(({ tier, label }) => {
		const ex = byTier.get(tier);
		return { tier, label, allow: ex?.allow ?? false, price: ex?.price ?? "0" };
	});
}

export function serializeBoostRows(rows: BoostRowDraft[]): BoostAccessRow[] {
	return rows.map((r) => ({
		threshold: r.threshold,
		allow: r.allow,
		price: normalizeMoney(r.price),
	}));
}

export function serializeAnthersRows(
	rows: AnthersRowDraft[],
): { tier: AnthersTier; allow: boolean; price: string }[] {
	return rows.map((r) => ({ tier: r.tier, allow: r.allow, price: normalizeMoney(r.price) }));
}

// ─── Component ───

interface AccessTablesProps {
	boostRows: BoostRowDraft[];
	anthersRows: AnthersRowDraft[];
	onBoostChange: (rows: BoostRowDraft[]) => void;
	onAnthersChange: (rows: AnthersRowDraft[]) => void;
}

export default function AccessTables({
	boostRows,
	anthersRows,
	onBoostChange,
	onAnthersChange,
}: AccessTablesProps) {
	const patchBoost = (index: number, changes: Partial<BoostRowDraft>) =>
		onBoostChange(boostRows.map((r, i) => (i === index ? { ...r, ...changes } : r)));
	const patchAnthers = (index: number, changes: Partial<AnthersRowDraft>) =>
		onAnthersChange(anthersRows.map((r, i) => (i === index ? { ...r, ...changes } : r)));

	return (
		<div className="flex flex-col gap-6">
			<p className="text-xs text-base-content/60">
				Access is granted if <strong>either</strong> table allows the viewer. A price of $0 with
				Allow checked is free at that level; a positive price is a minimum — buyers may pay more.
			</p>

			{/* Boost Access */}
			<div>
				<h3 className="font-semibold text-sm mb-2">Boost Access</h3>
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Boost level</th>
								<th className="w-20 text-center">Allow</th>
								<th className="w-32">Price ($)</th>
							</tr>
						</thead>
						<tbody>
							{boostRows.map((row, i) => (
								<tr key={row.threshold}>
									<td>
										<span className="font-medium">{row.label}</span>{" "}
										<span className="text-base-content/50">
											{row.threshold === 0 ? "$0" : `$${row.threshold.toFixed(2)}+`}
										</span>
									</td>
									<td className="text-center">
										<input
											type="checkbox"
											className="checkbox checkbox-sm checkbox-primary"
											checked={row.allow}
											onChange={(e) => patchBoost(i, { allow: e.target.checked })}
										/>
									</td>
									<td>
										<input
											type="number"
											className="input input-bordered input-sm w-full"
											value={row.price}
											min="0"
											step="0.01"
											onChange={(e) => patchBoost(i, { price: e.target.value })}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{boostRows.length === 1 && (
					<p className="text-xs text-base-content/50 mt-1">
						Add boost rungs in Settings → Boost Ladder to gate by boost level.
					</p>
				)}
			</div>

			{/* Anthers Access */}
			<div>
				<h3 className="font-semibold text-sm mb-2">Anthers Access</h3>
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Tier</th>
								<th className="w-20 text-center">Allow</th>
								<th className="w-32">Price ($)</th>
							</tr>
						</thead>
						<tbody>
							{anthersRows.map((row, i) => (
								<tr key={row.tier}>
									<td className="font-medium">{row.label}</td>
									<td className="text-center">
										<input
											type="checkbox"
											className="checkbox checkbox-sm checkbox-primary"
											checked={row.allow}
											onChange={(e) => patchAnthers(i, { allow: e.target.checked })}
										/>
									</td>
									<td>
										<input
											type="number"
											className="input input-bordered input-sm w-full"
											value={row.price}
											min="0"
											step="0.01"
											onChange={(e) => patchAnthers(i, { price: e.target.value })}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
