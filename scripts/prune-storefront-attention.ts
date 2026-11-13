// SPDX-License-Identifier: Apache-2.0
/**
 * One-time correction: delete the timed attention ranges that recorded time on a
 * build Work's page when the Work had no browser deliverable.
 *
 * 🚨 **The rule these rows broke is the storefront one.** A game or software Work with
 * only downloadable files has no medium on its page — the media area is the download
 * card — so presence there is a visit, not consumption. The intake stops writing such
 * ranges now (`workEarnsTime` in `@anthers/shared/attention`) and the page raises no
 * claim (`pageShowsDeliverable`), but ranges written before that fix are still in
 * `attention_events`: they show in every reader's activity history as *Played … for N
 * min* and, for a Work marked streaming, they are Public Access seconds the Time Pool
 * pays from. This script removes them. The daily `distribute-pool` run recomputes an
 * unsettled cycle from the raw rows, so deleting before the cycle settles is what makes
 * the correction reach the money.
 *
 * ⚠️ **What it can prove, and what it cannot.** A row is selected only when its Work is
 * a game or software Work with *no* browser deliverable anywhere in its recorded
 * history: no `work_builds` row at all, no archived version whose manifest carries a
 * hosted web build, and no embed address the page would accept today. That excludes
 * every Work that still has or has ever archived a way to play it. It cannot see two
 * removals, because neither leaves a record: an embed cleared from `works.embed_url`,
 * and a build deleted through `DELETE /works/:id/web-build/:buildId`. A Work that once
 * played and then lost its only build or embed therefore still gets its old ranges
 * selected. That is why the dry run prints every Work by name and count before anything
 * is deleted, and why `--apply` is a separate, attended step.
 *
 * ⚠️ **Rows older than the retention window are refused rather than deleted.** The
 * prune job rolls raw ranges into `attention_daily` after `ATTENTION_RAW_RETENTION_DAYS`,
 * and this script cannot subtract a per-person split from an anonymous daily total. A
 * refusal here means the correction belongs in that rollup's own arithmetic, not that
 * the script should guess.
 *
 * Usage, from a session with `DATABASE_URL` set (against production, through the one
 * door, after taking a backup and naming it):
 *   bun run scripts/prune-storefront-attention.ts            # dry run, the default
 *   bun run scripts/prune-storefront-attention.ts --apply    # delete
 *   make prod-db CMD="bun run scripts/prune-storefront-attention.ts"
 *
 * ⚠️ **Run it after the fix is deployed, not before.** Until the new intake is live,
 * production keeps writing the very rows this deletes, so a pass now is a stopgap that
 * needs a second pass. The script is idempotent either way.
 */
import { db } from "@anthers/db/client";
import { attentionEvents, workBuilds, workMediaVersions, works } from "@anthers/db/schema";
import { ATTENTION_RAW_RETENTION_DAYS } from "@anthers/shared/constants";
import { BUILD_WORK_TYPES, hasBrowserDeliverable, isBuildType } from "@anthers/shared/content";
import { and, gt, inArray } from "drizzle-orm";

/** A build Work reduced to what the storefront test asks about. */
export interface StorefrontCandidate {
	id: number;
	type: string;
	title: string | null;
	streamEnabled: boolean;
	embedUrl: string | null;
}

/** What the Work's build history says, as far as the rows can be read. */
export interface BuildEvidence {
	/** Any `work_builds` row, primary or not — a build the Work carries or carried. */
	currentBuilds: number;
	/** Archived versions whose manifest holds at least one hosted web build. */
	archivedWebBuilds: number;
}

/**
 * Whether a Work's page can only ever have been a storefront.
 *
 * The test is deliberately conservative: any recorded browser deliverable — current or
 * archived — takes the Work out, and a current embed has to be one the page would
 * accept (`hasBrowserDeliverable`, the same predicate the intake and the page use). A
 * build Work with only downloadable files is the case this is for.
 */
export function isStorefrontOnly(work: StorefrontCandidate, evidence: BuildEvidence): boolean {
	if (!isBuildType(work.type)) return false;
	if (evidence.currentBuilds > 0 || evidence.archivedWebBuilds > 0) return false;
	return !hasBrowserDeliverable({ embedUrl: work.embedUrl });
}

/**
 * Whether any selected range is old enough that the prune job may already have rolled
 * it into `attention_daily`. Such a row cannot be corrected by deleting the raw range.
 */
export function rolledUpRanges<T extends { startedAt: Date | null; createdAt: Date }>(
	ranges: T[],
	now = Date.now(),
): T[] {
	const cutoff = now - ATTENTION_RAW_RETENTION_DAYS * 86_400_000;
	return ranges.filter((range) => (range.startedAt ?? range.createdAt).getTime() < cutoff);
}

/** Split ids into batches a single `IN (…)` can carry without hitting a parameter limit. */
function chunks<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function fmtDuration(seconds: number): string {
	const m = Math.round(seconds / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 === 0 ? `${h} hr` : `${h} hr ${m % 60} min`;
}

async function main() {
	const apply = process.argv.includes("--apply");

	const buildWorks = await db
		.select({
			id: works.id,
			type: works.type,
			title: works.title,
			streamEnabled: works.streamEnabled,
			embedUrl: works.embedUrl,
		})
		.from(works)
		.where(inArray(works.type, [...BUILD_WORK_TYPES]));

	if (buildWorks.length === 0) {
		console.log("prune-storefront-attention: no build Works in this database.");
		return;
	}

	const ids = buildWorks.map((work) => work.id);
	const [buildRows, versionRows] = await Promise.all([
		db
			.select({ workId: workBuilds.workId })
			.from(workBuilds)
			.where(inArray(workBuilds.workId, ids)),
		db
			.select({ workId: workMediaVersions.workId, media: workMediaVersions.media })
			.from(workMediaVersions)
			.where(inArray(workMediaVersions.workId, ids)),
	]);

	const currentBuilds = new Map<number, number>();
	for (const row of buildRows) {
		currentBuilds.set(row.workId, (currentBuilds.get(row.workId) ?? 0) + 1);
	}
	const archivedWebBuilds = new Map<number, number>();
	for (const row of versionRows) {
		if (row.media.kind !== "builds" || row.media.webBuilds.length === 0) continue;
		archivedWebBuilds.set(row.workId, (archivedWebBuilds.get(row.workId) ?? 0) + 1);
	}

	const storefront = buildWorks.filter((work) =>
		isStorefrontOnly(work, {
			currentBuilds: currentBuilds.get(work.id) ?? 0,
			archivedWebBuilds: archivedWebBuilds.get(work.id) ?? 0,
		}),
	);

	if (storefront.length === 0) {
		console.log(
			`prune-storefront-attention: none of ${buildWorks.length} build Works is storefront-only; nothing to do.`,
		);
		return;
	}

	const storefrontIds = storefront.map((work) => work.id);
	const ranges = await db
		.select({
			id: attentionEvents.id,
			workId: attentionEvents.workId,
			eventType: attentionEvents.eventType,
			durationSeconds: attentionEvents.durationSeconds,
			startedAt: attentionEvents.startedAt,
			createdAt: attentionEvents.createdAt,
		})
		.from(attentionEvents)
		.where(
			and(inArray(attentionEvents.workId, storefrontIds), gt(attentionEvents.durationSeconds, 0)),
		);

	const byWork = new Map<number, { rows: number; seconds: number }>();
	for (const row of ranges) {
		if (row.workId == null) continue;
		const held = byWork.get(row.workId) ?? { rows: 0, seconds: 0 };
		held.rows += 1;
		held.seconds += row.durationSeconds ?? 0;
		byWork.set(row.workId, held);
	}

	const totalSeconds = [...byWork.values()].reduce((sum, held) => sum + held.seconds, 0);
	const withRanges = storefront.filter((work) => (byWork.get(work.id)?.rows ?? 0) > 0);
	console.log(
		`prune-storefront-attention: ${storefront.length} storefront-only Work(s); ${ranges.length} timed range(s) across ${withRanges.length} of them, ${Math.round(totalSeconds)}s (${fmtDuration(totalSeconds)})`,
	);
	for (const work of withRanges) {
		const held = byWork.get(work.id);
		if (!held) continue;
		const delivery = work.streamEnabled ? "stream + download, files only" : "download-only";
		console.log(
			`  #${work.id} ${JSON.stringify(work.title ?? "Untitled")} (${work.type}, ${delivery}) — ${held.rows} range(s), ${held.seconds}s`,
		);
	}

	if (ranges.length === 0) {
		console.log("prune-storefront-attention: no timed ranges to delete.");
		return;
	}

	const rolled = rolledUpRanges(ranges);
	if (rolled.length > 0) {
		console.error(
			`prune-storefront-attention: ${rolled.length} selected range(s) are older than ${ATTENTION_RAW_RETENTION_DAYS} days and may already be rolled into attention_daily. Refusing to delete; this needs the rollup arithmetic, not a raw delete.`,
		);
		if (apply) process.exitCode = 1;
		return;
	}

	if (!apply) {
		console.log(
			"prune-storefront-attention: dry run — nothing deleted. Re-run with --apply to delete these ranges.",
		);
		return;
	}

	let deleted = 0;
	await db.transaction(async (tx) => {
		for (const batch of chunks(
			ranges.map((range) => range.id),
			500,
		)) {
			const result = await tx
				.delete(attentionEvents)
				.where(inArray(attentionEvents.id, batch))
				.returning({ id: attentionEvents.id });
			deleted += result.length;
		}
	});
	console.log(`prune-storefront-attention: deleted ${deleted} range(s).`);
}

if (import.meta.main) {
	await main();
	// The pool holds sockets open, so a finished script otherwise hangs the command
	// that ran it until the harness kills it. `db-row-counts.ts` exits the same way.
	process.exit(process.exitCode ?? 0);
}
