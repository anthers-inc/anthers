// SPDX-License-Identifier: Apache-2.0
/**
 * The **variant chips** of a Work's media status — the per-variant state the Manage tab's
 * Media Status card and the Works table's Media Status column both show, extracted from
 * `apps/web`'s `MediaStatusCard` (2026-10-17) so the table can carry the same chips the
 * Work's own page does rather than a badge that says only "Ready".
 *
 * ⭐ **A video's ladder and an audio Work's products are the same idea, named for what
 * each pipeline makes** (Parker, 2026-10-19): the original file first, then each
 * rendition the processing run produces. The audio row is the MP3 a listener streams
 * and the waveform the player draws, so audio's Manage tab reads like video's rather
 * than as an older filename row.
 *
 * ⭐ **The variants are chips** (Parker's first redesign pass, 2026-10-13): greyed with an
 * X when a variant was never a product of this file (a video with no audio track has no
 * audio rendition), yellow with a running arrow while a run hasn't produced it, green
 * with a check the moment its address exists — presence IS the processed state, read
 * straight off the serialization (`userTranscoding` nulls what is absent), and the
 * ladder's own renditions are read live from its master manifest once that exists.
 *
 * The Original chip is the one interactive member on the Work's own page (blue, with a
 * pencil opening Replace File / Remove File); the table renders the same chips with no
 * actions — it reports the state, and acting on the file belongs to the Work's page.
 */

import {
	ArrowPathIcon,
	ArrowUpTrayIcon,
	CheckIcon,
	PencilSquareIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import type { Work } from "../../lib/types";
import type { WorkUpload } from "../../lib/work-uploads";

/**
 * One chip in the variant row — the three states, as icons beside the name.
 *
 * The **Original** chip is the card's one interactive member (Parker's second pass,
 * 2026-10-13): blue, a touch longer than the others, with a pencil opening a dropdown
 * that carries the destructive actions — Replace File and Remove File. The actions live
 * where the file's identity is named, rather than as a button row of their own.
 */
export function VariantChip({
	name,
	ready,
	running,
	actions,
	removeBusy,
}: {
	name: string;
	ready: string | "";
	running?: boolean;
	/** The dropdown member: never produced → it still carries the pencil, because there is
	 * exactly nothing to replace until it exists; a chip with no actions is passive. */
	actions?: { onReplace: () => void; onRemove: () => void };
	/** The removal in flight, while the dropdown's Remove button waits it out. */
	removeBusy?: boolean;
}) {
	const chip = ready ? (
		<CheckIcon className="size-3.5" />
	) : running ? (
		<ArrowPathIcon className="size-3.5" />
	) : (
		<XMarkIcon className="size-3.5" />
	);
	if (!actions) {
		return (
			<span
				className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
					ready
						? "border-success/40 bg-success/10 text-success"
						: running
							? "border-warning/40 bg-warning/10 text-warning"
							: "border-base-300 text-base-content/40"
				}`}
			>
				{chip}
				{name}
			</span>
		);
	}
	// A native `<details>` disclosure (the FAQ's pattern, and Parker's rule that a
	// keyboard user be able to open what a pointer user can): no daisyUI tabindex dance,
	// no :focus-within magic — the chip is the summary, the menu is the content.
	return (
		<details className="dropdown dropdown-end">
			<summary className="list-none inline-flex cursor-pointer items-center gap-1 rounded-full border border-info/40 bg-info/10 px-3.5 py-0.5 text-xs text-info hover:border-info marker:hidden [&::-webkit-details-marker]:hidden">
				{chip}
				{name}
				<PencilSquareIcon className="size-3 text-info/70" />
			</summary>
			<ul className="dropdown-content menu z-20 rounded-box w-44 border border-base-300 bg-base-100 p-1 shadow-lg">
				<li>
					<button type="button" onClick={actions.onReplace}>
						<ArrowUpTrayIcon className="size-4" />
						Replace File…
					</button>
				</li>
				<li>
					<button
						type="button"
						className="text-error"
						onClick={actions.onRemove}
						disabled={removeBusy}
					>
						<XMarkIcon className="size-4" />
						{removeBusy ? "Removing…" : "Remove File"}
					</button>
				</li>
			</ul>
		</details>
	);
}

/** The rendition chips a ladder's own master manifest names — read live once it exists. */
export function useLadderDepths(manifestUrl: string | null | undefined): number[] {
	const [heights, setHeights] = useState<number[]>([]);
	useEffect(() => {
		if (!manifestUrl) {
			setHeights([]);
			return;
		}
		let live = true;
		fetch(manifestUrl)
			.then((res) => (res.ok ? res.text() : ""))
			.then((text) => {
				if (!live) return;
				const found = new Set<number>();
				for (const m of text.matchAll(/RESOLUTION=\d+x(\d+)/g)) found.add(Number(m[1]));
				setHeights([...found].sort((a, b) => a - b));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [manifestUrl]);
	return heights;
}

/**
 * The whole chips row for a video: the original file, the audio-only rendition, the
 * ladder (or the renditions its own manifest names once it exists), and the failure
 * badges at the row's end — the in-flight and ready states are the chips' own answer
 * (Parker's third pass, 2026-10-13).
 *
 * `originalActions` is the Work page's pencil on the Original chip; the Works table
 * passes nothing and gets the passive chips.
 */
export function VideoMediaStatusChips({
	work,
	sourceUpload,
	originalActions,
	removeBusy,
}: {
	work: Work;
	/** The latest in-flight (or last settled) source upload this tab knows about. */
	sourceUpload: WorkUpload | null;
	/** Replace/Remove on the Original chip, offered only where the page owns the flows. */
	originalActions?: { onReplace: () => void; onRemove: () => void };
	/** The removal in flight, while the Original chip's dropdown waits it out. */
	removeBusy?: boolean;
}) {
	const job = work.transcoding;
	const running = job != null && (job.status === "pending" || job.status === "processing");
	const uploading = sourceUpload?.status === "uploading" || sourceUpload?.status === "attaching";
	const depths = useLadderDepths(job?.hlsManifestUrl ?? null);

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{/* The original: the one variant that exists the moment the file does, and
			    the one chip that acts — replace or remove, from its pencil. */}
			<VariantChip
				name="Original"
				ready={work.sourceKey ? "ready" : ""}
				running={uploading}
				removeBusy={removeBusy}
				actions={originalActions}
			/>
			<VariantChip name="Audio" ready={job?.audioManifestUrl ?? ""} running={running} />
			{depths.length > 0 ? (
				// Largest first (Parker, 2026-10-13): the ladder reads as what it offers,
				// best at the left.
				depths
					.slice()
					.sort((a, b) => b - a)
					.map((h) => <VariantChip key={h} name={`${h}p`} ready="ready" />)
			) : (
				<VariantChip name="Ladder" ready={job?.hlsManifestUrl ?? ""} running={running} />
			)}
			{/* The failures stand at the row's end: the in-flight and ready states are
			    the chips' own answer (Parker's third pass, 2026-10-13). */}
			{sourceUpload?.status === "failed" && (
				<span className="badge badge-error badge-sm">Upload failed</span>
			)}
			{job?.status === "failed" && (
				<span className="badge badge-error badge-sm">Processing failed</span>
			)}
		</div>
	);
}

/**
 * The chips row for an audio Work — the original file, the MP3 a listener streams and
 * the waveform the player draws, each present the moment its product exists. The
 * pipeline is `jobs/process-audio.ts`: normalize, convert to MP3, generate the peaks.
 *
 * `originalActions` is the Work page's pencil on the Original chip, as it is on video's;
 * the Works table passes nothing and gets the passive chips.
 */
export function AudioMediaStatusChips({
	work,
	sourceUpload,
	originalActions,
	removeBusy,
}: {
	work: Work;
	/** The latest in-flight (or last settled) source upload this tab knows about. */
	sourceUpload: WorkUpload | null;
	/** Replace/Remove on the Original chip, offered only where the page owns the flows. */
	originalActions?: { onReplace: () => void; onRemove: () => void };
	/** The removal in flight, while the Original chip's dropdown waits it out. */
	removeBusy?: boolean;
}) {
	const job = work.transcoding;
	const running = job != null && (job.status === "pending" || job.status === "processing");
	const uploading = sourceUpload?.status === "uploading" || sourceUpload?.status === "attaching";

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<VariantChip
				name="Original"
				ready={work.sourceKey ? "ready" : ""}
				running={uploading}
				removeBusy={removeBusy}
				actions={originalActions}
			/>
			<VariantChip name="MP3" ready={job?.outputFileUrl ?? ""} running={running} />
			<VariantChip
				name="Waveform"
				ready={(job?.waveformData?.length ?? 0) > 0 ? "ready" : ""}
				running={running}
			/>
			{sourceUpload?.status === "failed" && (
				<span className="badge badge-error badge-sm">Upload failed</span>
			)}
			{job?.status === "failed" && (
				<span className="badge badge-error badge-sm">Processing failed</span>
			)}
		</div>
	);
}
