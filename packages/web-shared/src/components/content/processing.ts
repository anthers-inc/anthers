// SPDX-License-Identifier: Apache-2.0
/**
 * How far along a Work's processing is, said the same way everywhere a creator waits on it —
 * the Catalog card's badge, the Work's own page, and the Dashboard's processing panel.
 *
 * ⚠️ **`etaSeconds` is an estimate for video alone.** The column is null for audio and ebooks,
 * so every sentence here reads well with a percentage and no estimate, and never renders an
 * empty "left" for a job that has no way to know.
 *
 * Pure and kept out of the components for the same reason `studio-worklist.ts` is: a condition
 * that stops matching renders an empty panel, and an empty panel is also what a creator with
 * nothing processing is supposed to see.
 */

import type { Work } from "../../lib/types";
import { isUploading, type WorkUpload } from "../../lib/work-uploads";

/** How long a finished Work stays in the processing panel. */
export const RECENTLY_FINISHED_MS = 24 * 60 * 60 * 1000;

/** `~45s`, `~2m 30s`, `~1h 5m` — an estimate, so rounded and marked as one. */
export function etaText(seconds: number): string {
	const sec = Math.max(1, Math.round(seconds));
	if (sec < 60) return `~${sec}s`;
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	if (m < 60) return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
	const h = Math.floor(m / 60);
	const rest = m % 60;
	return rest > 0 ? `~${h}h ${rest}m` : `~${h}h`;
}

/** The estimate as a phrase, or null when there is none worth showing. */
export function etaLeft(etaSeconds: number | null | undefined): string | null {
	return etaSeconds != null && etaSeconds > 0 ? `${etaText(etaSeconds)} left` : null;
}

/**
 * A short account of a job still running, for a badge or a list row: `Waiting to process`, or
 * `Processing 43%`, with ` · ~2m left` when an estimate exists. Null for a job that is not running.
 */
export function processingText(job: Work["transcoding"]): string | null {
	if (!job) return null;
	if (job.status === "pending") return "Waiting to process";
	if (job.status !== "processing") return null;
	const eta = etaLeft(job.etaSeconds);
	return `Processing ${job.progress ?? 0}%${eta ? ` · ${eta}` : ""}`;
}

export interface ProcessingRow {
	workId: number;
	title: string;
	/** Present when the Work is in the listing; an upload can start before the listing re-reads. */
	work: Work | null;
	state: "uploading" | "processing" | "finished";
	/** What is happening, as the row says it. */
	detail: string;
}

/**
 * What the processing panel lists: files still uploading from this tab, then Works being
 * processed, then Works that finished within the last day, most recent first.
 *
 * ⚠️ **A failed encode is not here.** It is wrong rather than in progress, so it belongs to the
 * Dashboard's worklist, which cannot be hidden — a panel carrying it too would be the one place
 * a creator could make it go away.
 */
export function processingQueue(
	works: Work[],
	uploads: readonly WorkUpload[],
	now: number = Date.now(),
): ProcessingRow[] {
	const byId = new Map(works.map((w) => [w.id, w]));
	const rows: ProcessingRow[] = [];

	for (const upload of uploads) {
		if (!isUploading(upload)) continue;
		const work = byId.get(upload.workId) ?? null;
		rows.push({
			workId: upload.workId,
			title: work?.title || upload.fileName,
			work,
			state: "uploading",
			detail:
				upload.status === "attaching" || upload.progress == null
					? "Uploading"
					: `Uploading ${upload.progress}%`,
		});
	}
	const uploadingIds = new Set(rows.map((r) => r.workId));

	const running = works.filter(
		(w) => !uploadingIds.has(w.id) && processingText(w.transcoding) != null,
	);
	// Running first, then waiting, so the one moving sits at the top.
	running.sort((a, b) => rank(a) - rank(b));
	for (const w of running) {
		rows.push({
			workId: w.id,
			title: w.title || "Untitled",
			work: w,
			state: "processing",
			detail: processingText(w.transcoding) as string,
		});
	}

	const finished = works
		.filter((w) => {
			const job = w.transcoding;
			if (uploadingIds.has(w.id) || job?.status !== "completed") return false;
			const at = Date.parse(job.updatedAt);
			return Number.isFinite(at) && now - at <= RECENTLY_FINISHED_MS;
		})
		.sort((a, b) => finishedAt(b) - finishedAt(a));
	for (const w of finished) {
		rows.push({
			workId: w.id,
			title: w.title || "Untitled",
			work: w,
			state: "finished",
			detail: "Ready",
		});
	}

	return rows;
}

function rank(work: Work): number {
	return work.transcoding?.status === "processing" ? 0 : 1;
}

function finishedAt(work: Work): number {
	return Date.parse(work.transcoding?.updatedAt ?? "") || 0;
}
