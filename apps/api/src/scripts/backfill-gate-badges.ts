// SPDX-License-Identifier: Apache-2.0
/**
 * Give every stored gate the Badge rung it sits on.
 *
 * Gates are a Badge rung or a price now (Parker, 2026-10-23): a Work's access row names its
 * rung in `badgeId`, and the threshold beside it is that rung's amount as of the last write.
 * Rows written before the reference existed carry the amount alone, so this fills the
 * reference in by exact amount against each creator's current ladder.
 *
 * ⭐ **Dry run by default, and deliberately not dev-only.** The rows this exists for are the
 * ones already in a deployed database, so it cannot carry `assertDevCheckout` — the guard is
 * that it writes nothing without `--apply`. It is idempotent: a row that already names its
 * rung is left alone.
 *
 * ⚠️ **Rows at an amount no rung occupies are reported, never mapped.** That shape is the one
 * this model retired, and assigning it to the nearest rung would silently decide what a
 * creator's gate means. It is also invisible in the Studio (the access table renders the
 * baseline plus one row per rung), so the report is the only place it can be seen.
 *
 * Usage:
 *   bun run db:gate-badges            # count and list what would change
 *   bun run db:gate-badges --apply    # write the references and align stale amounts
 */
import { db } from "@anthers/db/client";
import type { AccessRow } from "@anthers/db/schema";
import { badges, works } from "@anthers/db/schema";
import { asc, eq, sql } from "drizzle-orm";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
	console.log("Usage: bun run db:gate-badges [--apply]");
	process.exit(0);
}
const apply = args.has("--apply");

interface Rung {
	amount: number;
}

/** creatorId → badgeId → rung, and creatorId → amount → badgeId (first rung at that amount). */
const byId = new Map<number, Map<number, Rung>>();
const byAmount = new Map<number, Map<number, number>>();

const ladder = await db
	.select({ id: badges.id, creatorId: badges.creatorId, threshold: badges.threshold })
	.from(badges)
	.orderBy(asc(badges.id));
for (const b of ladder) {
	if (!byId.has(b.creatorId)) byId.set(b.creatorId, new Map());
	if (!byAmount.has(b.creatorId)) byAmount.set(b.creatorId, new Map());
	byId.get(b.creatorId)?.set(b.id, { amount: Number(b.threshold) });
	// First rung wins a duplicate amount; duplicates are their own defect and reporting
	// them here would bury the gate report.
	if (!byAmount.get(b.creatorId)?.has(Number(b.threshold))) {
		byAmount.get(b.creatorId)?.set(Number(b.threshold), b.id);
	}
}

const gated = await db
	.select({ id: works.id, creatorId: works.creatorId, access: works.access })
	.from(works)
	.where(sql`${works.access} IS NOT NULL AND jsonb_array_length(${works.access}) > 0`)
	.orderBy(asc(works.id));

let rowCount = 0;
let already = 0;
let gains = 0;
const stale: { workId: number; badgeId: number; from: number; to: number }[] = [];
const missingRung: { workId: number; badgeId: number }[] = [];
const orphan: { workId: number; creatorId: number | null; threshold: number }[] = [];
const writes: { id: number; access: AccessRow[] }[] = [];

for (const work of gated) {
	const rows = work.access ?? [];
	let changed = false;
	const next = rows.map((row) => {
		rowCount += 1;
		if (row.threshold === 0) {
			// The Everyone baseline is the one row with no rung, and any badgeId on it is a
			// contradiction rather than a gate.
			if (row.badgeId != null) {
				changed = true;
				return { ...row, badgeId: null };
			}
			return row;
		}
		const rungs = work.creatorId == null ? undefined : byId.get(work.creatorId);
		const amounts = work.creatorId == null ? undefined : byAmount.get(work.creatorId);

		if (row.badgeId != null) {
			const rung = rungs?.get(row.badgeId);
			if (!rung) {
				missingRung.push({ workId: work.id, badgeId: row.badgeId });
				return row;
			}
			if (rung.amount !== row.threshold) {
				stale.push({
					workId: work.id,
					badgeId: row.badgeId,
					from: row.threshold,
					to: rung.amount,
				});
				changed = true;
				return { ...row, threshold: rung.amount };
			}
			already += 1;
			return row;
		}

		const badgeId = amounts?.get(row.threshold);
		if (badgeId === undefined) {
			orphan.push({ workId: work.id, creatorId: work.creatorId, threshold: row.threshold });
			return row;
		}
		gains += 1;
		changed = true;
		return { ...row, badgeId };
	});

	if (changed) writes.push({ id: work.id, access: next });
}

console.log(`[gate-badges] ${gated.length} Works carry an access table; ${rowCount} rows.`);
console.log(`  ${already} rows already name their rung.`);
console.log(`  ${gains} rows gain a rung by exact amount.`);
console.log(`  ${stale.length} rows name a rung but carry a stale amount.`);
console.log(`  ${missingRung.length} rows name a rung that no longer exists.`);
console.log(`  ${orphan.length} rows sit at an amount no rung occupies (left untouched).`);

if (stale.length > 0) {
	console.log("\nStale amounts (the rung was repriced after the gate was written):");
	for (const s of stale) {
		console.log(
			`  work ${s.workId}: badge ${s.badgeId} at $${s.from.toFixed(2)} → $${s.to.toFixed(2)}`,
		);
	}
}
if (missingRung.length > 0) {
	console.log("\nGates naming a rung that no longer exists:");
	for (const m of missingRung) console.log(`  work ${m.workId}: badge ${m.badgeId}`);
}
if (orphan.length > 0) {
	console.log("\nGates at an amount no rung occupies — the retired shape:");
	for (const o of orphan) {
		console.log(
			`  work ${o.workId}: creator ${o.creatorId ?? "(none)"} at $${o.threshold.toFixed(2)}`,
		);
	}
}

if (!apply) {
	console.log(`\n${writes.length} Works would change. Re-run with --apply to write.`);
	process.exit(0);
}

for (const w of writes) {
	await db.update(works).set({ access: w.access }).where(eq(works.id, w.id));
}
console.log(`\nWrote ${writes.length} Works.`);
