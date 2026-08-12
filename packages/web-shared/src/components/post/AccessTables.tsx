// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Access section's table — the creator's own Seed ladder. It defaults to "free but
 * fully locked" (every row allow=false, price "0"). A price of $0 with Allow checked =
 * free at that level; a positive price is a minimum (itch.io style — buyers may pay more).
 * The baseline row allowed at $0 is what makes a Work **Public Access**.
 *
 * A second table sat beside this until 2026-08-12, gating on the viewer's Anthers Badge,
 * with access the OR across both. Anthers Gates are retired — they stratified the commons
 * — so a Work is gated by its creator or it is Public Access, and there is one table.
 */
import type { CreatorGate, SeedAccessRow } from "../../lib/types";

// ─── Row drafts ───

/**
 * A draft row: a whole-Seed threshold, an allow flag, a price. `label` is display only —
 * the threshold is what is saved and what decides access, so renaming a rung never moves
 * a gate.
 */
export interface AccessRowDraft {
	/** Whole Seeds required — given to this Work's creator this cycle. 0 = everyone. */
	threshold: number;
	label: string;
	allow: boolean;
	price: string;
}

export type SeedRowDraft = AccessRowDraft;

/** Coerce a user-entered price to a valid money string ("0" when blank/invalid). */
export function normalizeMoney(v: string): string {
	const t = v.trim();
	if (!t) return "0";
	const n = Number(t);
	if (!Number.isFinite(n) || n < 0) return "0";
	return (Math.round(n * 100) / 100).toString();
}

/** Seed rows = fixed $0 baseline + one row per Seed gate (sorted by threshold). */
export function buildSeedRows(
	gates: CreatorGate[],
	existing?: SeedAccessRow[] | null,
): SeedRowDraft[] {
	const byThreshold = new Map<number, SeedAccessRow>();
	for (const r of existing ?? []) byThreshold.set(r.threshold, r);

	const base = byThreshold.get(0);
	const rows: SeedRowDraft[] = [
		{ threshold: 0, label: "Everyone", allow: base?.allow ?? false, price: base?.price ?? "0" },
	];

	const rungs = gates
		.filter((g) => g.gateType === "seed")
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

/** The label is editor-only and never stored. */
function serializeRows(rows: AccessRowDraft[]): AccessRowDraft[] {
	return rows.map((r) => ({
		threshold: r.threshold,
		allow: r.allow,
		price: normalizeMoney(r.price),
	})) as AccessRowDraft[];
}

export function serializeSeedRows(rows: SeedRowDraft[]): SeedAccessRow[] {
	return serializeRows(rows).map(({ threshold, allow, price }) => ({ threshold, allow, price }));
}

// ─── Component ───

interface AccessTablesProps {
	seedRows: SeedRowDraft[];
	onSeedChange: (rows: SeedRowDraft[]) => void;
}

export default function AccessTables({ seedRows, onSeedChange }: AccessTablesProps) {
	const patchSeed = (index: number, changes: Partial<SeedRowDraft>) =>
		onSeedChange(seedRows.map((r, i) => (i === index ? { ...r, ...changes } : r)));

	return (
		<div className="flex flex-col gap-6">
			<p className="text-xs text-base-content/60">
				A price of $0 with Allow checked is free at that level; a positive price is a minimum —
				buyers may pay more. Leaving <strong>Everyone</strong> allowed at $0 on a streaming Work is
				what makes it <strong>Public Access</strong>: free to all, with nothing to clear.
			</p>

			{/* Seed Access */}
			<div>
				<h3 className="font-semibold text-sm mb-2">Seed Access</h3>
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Seed level</th>
								<th className="w-20 text-center">Allow</th>
								<th className="w-32">Price ($)</th>
							</tr>
						</thead>
						<tbody>
							{seedRows.map((row, i) => (
								<tr key={row.threshold}>
									<td>
										<span className="font-medium">{row.label}</span>{" "}
										<span className="text-base-content/50">
											{row.threshold === 0
												? "Everyone"
												: `${row.threshold} Seed${row.threshold === 1 ? "" : "s"}+`}
										</span>
									</td>
									<td className="text-center">
										<input
											type="checkbox"
											className="checkbox checkbox-sm checkbox-primary"
											checked={row.allow}
											onChange={(e) => patchSeed(i, { allow: e.target.checked })}
										/>
									</td>
									<td>
										<input
											type="number"
											className="input input-bordered input-sm w-full"
											value={row.price}
											min="0"
											step="0.01"
											onChange={(e) => patchSeed(i, { price: e.target.value })}
										/>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				{seedRows.length === 1 && (
					<p className="text-xs text-base-content/50 mt-1">
						Add Seed rungs in Settings → Seed Ladder to gate by Seeds given.
					</p>
				)}
			</div>
		</div>
	);
}
