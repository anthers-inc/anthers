// SPDX-License-Identifier: Apache-2.0
/**
 * **Media Status** — one card that says where this Work's media stands, replacing the
 * separate filename-and-"Uploaded" card and the processing block that used to sit apart
 * (Parker, 2026-10-13: a unified card showing upload, processing and which processed
 * variants exist together — and carrying the actions that act on that state).
 *
 * ⭐ **The variants are chips** (Parker's first redesign pass, 2026-10-13): greyed with an
 * X when a variant was never a product of this file (a video with no audio track has no
 * audio rendition), yellow with a running arrow while a run hasn't produced it, green
 * with a check the moment its address exists — presence IS the processed state, read
 * straight off the serialization (`userTranscoding` nulls what is absent), and the
 * ladder's own renditions are read live from its master manifest once that exists.
 *
 * The card explains nothing by default: the accepted-formats sentence the old card
 * carried lives in the Replace dialog, where the person picking a file needs it. The
 * actions are buttons — Replace File… opens a dialog that takes the file, Remove File
 * removes it, both riding the unpublished gate.
 *
 * ⚠️ **This card is the owner's own surface** — it renders only in the editor container
 * (video pass, 2026-10-13); a user's page keeps the single TranscodingStatus line it
 * has always shown while a ladder is missing.
 */

import { FormatsHint, fileRules, isFileWorkType } from "@anthers/web-shared/content/work-media";
import TranscodingStatus from "@anthers/web-shared/media/TranscodingStatus";
import FileUpload from "@anthers/web-shared/ui/FileUpload";
import type { WorkUpload } from "@anthers/web-shared/work-uploads";
import { ArrowPathIcon, CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { WorkDetail } from "./WorkLayout";

/** One chip in the variant row — the three states, as icons beside the name. */
function VariantChip({
	name,
	ready,
	running,
}: {
	name: string;
	ready: string | "";
	running?: boolean;
}) {
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
			{ready ? (
				<CheckIcon className="size-3.5" />
			) : running ? (
				<ArrowPathIcon className="size-3.5" />
			) : (
				<XMarkIcon className="size-3.5" />
			)}
			{name}
		</span>
	);
}

/** The rendition chips a ladder's own master manifest names — read live once it exists. */
function useLadderDepths(manifestUrl: string | null | undefined): number[] {
	const [heights, setHeights] = useState<number[]>([]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: read when the ladder appears, and only then
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

export default function MediaStatusCard({
	work,
	sourceUpload,
	unpublished,
	cancelBusy,
	removeBusy,
	onCancel,
	onRemove,
	onReplaceFile,
	onRetry,
}: {
	work: WorkDetail;
	/** The latest in-flight (or last settled) source upload this tab knows about. */
	sourceUpload: WorkUpload | null;
	/** The removal/replace actions ride the unpublished gate the deliverable's own edit does. */
	unpublished: boolean;
	cancelBusy: boolean;
	removeBusy: boolean;
	onCancel: () => void;
	onRemove: () => void;
	/** Starts a replacement upload; the page's store watches it land. */
	onReplaceFile: (file: File) => void;
	/** The failed upload's own retry — the store re-runs the put (and attach) alone. */
	onRetry: () => void;
}) {
	const type = work.type;
	const canReplace = isFileWorkType(type);
	const job = work.transcoding;
	const running = job != null && (job.status === "pending" || job.status === "processing");
	const failed = job?.status === "failed";
	const uploading = sourceUpload?.status === "uploading" || sourceUpload?.status === "attaching";
	const depths = useLadderDepths(job?.hlsManifestUrl ?? null);

	return (
		<section
			aria-label="Media status"
			// `status`, not `alert`: the card is the page's persistent media state.
			className="rounded-box border border-base-300 bg-base-100 px-4 py-3 flex flex-col gap-2 h-full"
		>
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold">Media Status</h2>
				{(() => {
					// The card's headline state, in one badge: the row's whole truth at a glance.
					if (sourceUpload?.status === "failed")
						return <span className="badge badge-error badge-sm">Upload failed</span>;
					if (uploading) return <span className="badge badge-warning badge-sm">Uploading</span>;
					if (running) return <span className="badge badge-warning badge-sm">Processing</span>;
					if (failed) return <span className="badge badge-error badge-sm">Processing failed</span>;
					if (work.sourceKey) return <span className="badge badge-success badge-sm">Ready</span>;
					return <span className="badge badge-ghost badge-sm">No media yet</span>;
				})()}
			</div>

			{type === "video" && (
				<div className="flex flex-wrap gap-1.5">
					{/* The original: the one variant that exists the moment the file does. */}
					<VariantChip name="Original" ready={work.sourceKey ? "ready" : ""} running={uploading} />
					<VariantChip name="Audio" ready={job?.audioManifestUrl ?? ""} running={running} />
					{depths.length > 0 ? (
						depths.map((h) => <VariantChip key={h} name={`${h}p`} ready="ready" />)
					) : (
						<VariantChip name="Ladder" ready={job?.hlsManifestUrl ?? ""} running={running} />
					)}
				</div>
			)}

			{running && (
				<div className="max-w-none">
					<TranscodingStatus
						status={job?.status ?? "pending"}
						progress={job?.progress ?? 0}
						etaSeconds={job?.etaSeconds ?? undefined}
						errorMessage={job?.errorMessage ?? undefined}
					/>
				</div>
			)}

			{sourceUpload?.status === "failed" && sourceUpload.error && (
				<p className="text-xs">
					<span className="text-error">{sourceUpload.error}</span>
					<button type="button" className="btn btn-xs ml-2" onClick={onRetry}>
						Try again
					</button>
				</p>
			)}

			{unpublished && (
				<div className="flex flex-wrap items-center gap-2 mt-auto pt-2">
					{canReplace && <ReplaceDialog type={type} onFile={onReplaceFile} />}
					{work.sourceKey && (
						<button
							type="button"
							className="btn btn-sm btn-error"
							onClick={onRemove}
							disabled={removeBusy}
						>
							Remove File
						</button>
					)}
					{running && (
						<button type="button" className="btn btn-sm" onClick={onCancel} disabled={cancelBusy}>
							{cancelBusy ? "Canceling…" : "Cancel processing"}
						</button>
					)}
				</div>
			)}
		</section>
	);
}

/**
 * Replace the file, asked for deliberately: a button, then a dialog that takes it and
 * states the formats the file must satisfy (the sentence the card carried, said where it
 * is actually needed). The work-uploads store watches the pick, so the dialog close and
 * the progress read are the page's, not this dialog's.
 */
function ReplaceDialog({
	type,
	onFile,
}: {
	type: "video" | "image" | "music" | "audio" | "comic" | "ebook";
	onFile: (file: File) => void;
}) {
	const [open, setOpen] = useState(false);
	const pendingRef = useRef<File | null>(null);

	const dialog = useRef<HTMLDialogElement>(null);

	return (
		<>
			<button
				type="button"
				className="btn btn-sm"
				onClick={() => {
					setOpen(true);
					dialog.current?.showModal();
				}}
			>
				Replace File…
			</button>
			{open && (
				<dialog
					ref={dialog}
					className="modal"
					onClose={() => {
						setOpen(false);
						pendingRef.current = null;
					}}
				>
					<div className="modal-box">
						<h3 className="text-lg font-semibold">Replace the file</h3>
						<p className="mt-1 text-xs text-base-content/60">
							The new file takes the old one's place: its processing runs again, and everything the
							old version left is swept.
						</p>
						<div className="mt-4 flex flex-col gap-3">
							<FileUpload
								accept={fileRules(type).accept}
								maxSize={fileRules(type).maxSize}
								compact
								label={type === "image" ? "Choose the image" : "Choose the file"}
								onFileSelect={(file) => {
									pendingRef.current = file;
								}}
							/>
							<FormatsHint type={type} />
						</div>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => {
									dialog.current?.close();
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								disabled={!pendingRef.current}
								onClick={() => {
									if (pendingRef.current) onFile(pendingRef.current);
									pendingRef.current = null;
									dialog.current?.close();
								}}
							>
								Replace
							</button>
						</div>
					</div>
					<form method="dialog" className="modal-backdrop">
						<button aria-label="Close the replace dialog" />
					</form>
				</dialog>
			)}
		</>
	);
}
