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

/**
 * An estimate as a rough figure said plainly: `less than a minute`, `about 3 minutes`,
 * `about 25 minutes`, `about 2 hours`.
 *
 * ⭐ **Coarse on purpose** (Parker, 2026-09-17: *less precise but more confident*). The figure
 * underneath is ffmpeg's speed projected forward, which is good to the nearest few minutes and
 * no better, so `~2m 30s` claimed a precision it never had while the tilde apologized for it.
 * The coarser the unit, the less a small change in the figure changes what is said.
 */
export function etaText(seconds: number): string {
	if (seconds < 60) return "less than a minute";
	const m = Math.round(seconds / 60);
	if (m <= 1) return "about a minute";
	if (m < 10) return `about ${m} minutes`;
	// Past ten minutes, the nearest five; `about 23 minutes` is the old false precision again.
	const five = Math.round(m / 5) * 5;
	if (five < 60) return `about ${five} minutes`;
	const h = Math.round(seconds / 3600);
	return h <= 1 ? "about an hour" : `about ${h} hours`;
}

/** The estimate as a sentence, `About 3 minutes left`, or null when there is none to show. */
export function etaLeft(etaSeconds: number | null | undefined): string | null {
	if (etaSeconds == null || etaSeconds <= 0) return null;
	const text = etaText(etaSeconds);
	return `${text.charAt(0).toUpperCase()}${text.slice(1)} left`;
}

/**
 * Where a job is, short enough for a badge: `Waiting to process` or `Processing 43%`. Null for a
 * job that is not running.
 *
 * ⚠️ **A badge takes this and never `processingText`.** A daisyUI badge is one line of fixed
 * height, and the longest estimate, `Processing 43% · Less than a minute left`, is wider than a
 * Catalog card at four to a row, so it wrapped inside the pill and spilled out of it. A card
 * that wants the estimate says it on its own line, with `etaLeft`.
 */
export function processingStatusText(job: Work["transcoding"]): string | null {
	if (!job) return null;
	if (job.status === "pending") return "Waiting to process";
	if (job.status !== "processing") return null;
	return `Processing ${job.progress ?? 0}%`;
}

/**
 * A job still running, for a row with room for a sentence: `processingStatusText`, with
 * ` · About 3 minutes left` when an estimate exists. Null for a job that is not running.
 */
export function processingText(job: Work["transcoding"]): string | null {
	const status = processingStatusText(job);
	const eta = job?.status === "processing" ? etaLeft(job.etaSeconds) : null;
	return status && eta ? `${status} · ${eta}` : status;
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
