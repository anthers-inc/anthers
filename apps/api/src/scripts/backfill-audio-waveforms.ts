// SPDX-License-Identifier: Apache-2.0
/**
 * Recompute every completed audio Work's waveform from its source file.
 *
 * The stored peaks changed from per-bucket sample **peak** to per-bucket **RMS** on
 * 2026-10-19 (`generateWaveform` in `jobs/process-audio.ts`): peak-per-bucket draws a
 * mastered track as a wall, because a loud, compressed master touches full scale in
 * almost every bucket. New uploads pick the new measure up automatically; the rows
 * already carrying peaks were computed the old way and no query can recover dynamics
 * the old measure threw away, so they are recomputed here, from the same source the
 * job reads.
 *
 * ⭐ **Dry run by default, and deliberately not dev-only.** The point of this script is
 * the rows already in a deployed database, so it cannot carry `assertDevCheckout` the
 * fixture scripts do — the guard here is that it writes nothing without `--apply`.
 * It is idempotent: a second run recomputes the same peaks from the same source, and a
 * Work whose job produced no waveform is skipped.
 *
 * Usage:
 *   bun run media:waveforms                     # list what would be recomputed
 *   bun run media:waveforms --apply             # recompute and write
 *   bun run media:waveforms --work 123 --apply  # one Work
 *   bun run media:waveforms --limit 10 --apply  # a first batch
 *
 * Needs the API's storage environment (`STORAGE_*`) alongside `DATABASE_URL`, because
 * the source is read through the same `StorageService` the job uses.
 */

import { db } from "@anthers/db/client";
import { works, workTranscodingJobs } from "@anthers/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { generateWaveform } from "../jobs/process-audio.js";
import { storage } from "../services/storage/index.js";

const SOURCE_URL_TTL_SECONDS = 60 * 60;

interface Args {
	apply: boolean;
	workId: number | null;
	limit: number | null;
}

function parseArgs(argv: string[]): Args {
	let apply = false;
	let workId: number | null = null;
	let limit: number | null = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--apply") apply = true;
		else if (arg === "--work") workId = Number(argv[++i]);
		else if (arg === "--limit") limit = Number(argv[++i]);
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (workId != null && !Number.isFinite(workId)) throw new Error("--work needs a numeric id");
	if (limit != null && (!Number.isFinite(limit) || limit < 1)) {
		throw new Error("--limit needs a positive number");
	}
	return { apply, workId, limit };
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	// The jobs that carry a waveform are the rows the player draws — completed audio
	// rows only, because a pending or failed one has nothing stored to replace.
	const jobRows = await db
		.select({
			id: workTranscodingJobs.id,
			workId: workTranscodingJobs.workId,
			timings: workTranscodingJobs.timings,
		})
		.from(workTranscodingJobs)
		.where(
			and(
				eq(workTranscodingJobs.mediaType, "audio"),
				eq(workTranscodingJobs.status, "completed"),
				isNotNull(workTranscodingJobs.waveformData),
				...(args.workId != null ? [eq(workTranscodingJobs.workId, args.workId)] : []),
			),
		)
		.orderBy(workTranscodingJobs.id);

	if (jobRows.length === 0) {
		console.log("No completed audio jobs carry a waveform — nothing to do.");
		return;
	}

	const workIds = [...new Set(jobRows.map((row) => row.workId))];
	const workRows = await db
		.select({
			id: works.id,
			title: works.title,
			type: works.type,
			sourceKey: works.sourceKey,
			durationSeconds: works.durationSeconds,
		})
		.from(works)
		.where(and(inArray(works.id, workIds), isNotNull(works.sourceKey)))
		.orderBy(works.id);

	const jobsByWork = new Map<number, typeof jobRows>();
	for (const job of jobRows) {
		const list = jobsByWork.get(job.workId) ?? [];
		list.push(job);
		jobsByWork.set(job.workId, list);
	}

	const targets = workRows
		.filter((work) => jobsByWork.has(work.id))
		.slice(0, args.limit ?? undefined);

	if (targets.length === 0) {
		console.log("None of the waveform-bearing jobs has a Work with a source file.");
		return;
	}

	console.log(
		`${targets.length} Work${targets.length === 1 ? "" : "s"} to recompute` +
			`${args.apply ? "" : " (dry run — pass --apply to write)"}.\n`,
	);

	let changed = 0;
	for (const work of targets) {
		const jobs = jobsByWork.get(work.id) ?? [];
		const duration =
			Number((jobs[0]?.timings as { durationSeconds?: number } | null)?.durationSeconds ?? 0) ||
			work.durationSeconds ||
			0;
		const label = `#${work.id} ${work.title ?? "(untitled)"} [${work.type}] — ${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
		try {
			const source = await storage.readableInput(work.sourceKey ?? "", {
				expiresIn: SOURCE_URL_TTL_SECONDS,
			});
			const waveform = await generateWaveform(source, 128, duration);
			const spread = `min ${Math.min(...waveform).toFixed(2)}, max ${Math.max(...waveform).toFixed(2)}`;
			if (!args.apply) {
				console.log(`  would recompute ${label} (${spread})`);
				continue;
			}
			for (const job of jobs) {
				await db
					.update(workTranscodingJobs)
					.set({ waveformData: waveform })
					.where(eq(workTranscodingJobs.id, job.id));
			}
			changed++;
			console.log(`  recomputed ${label} (${spread})`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`  FAILED ${label}: ${message}`);
		}
	}

	console.log(
		args.apply
			? `\nDone — ${changed} Work${changed === 1 ? "" : "s"} written.`
			: "\nDry run only — nothing written.",
	);
}

main()
	.then(() => process.exit(0))
	.catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
