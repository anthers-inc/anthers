// SPDX-License-Identifier: Apache-2.0
/**
 * **Media Status** — one card that says where this Work's media stands, replacing the
 * separate filename-and-"Uploaded" card and the processing block that used to sit apart
 * (Parker, 2026-10-13: a unified card showing upload, processing and which processed
 * variants exist together — and carrying the actions that act on that state).
 *
 * ⭐ **Video and audio draw the same card** (Parker, 2026-10-19): the chips name what
 * each pipeline actually produces — a video's audio rendition and ladder, an audio
 * Work's MP3 and waveform — so the Manage tab's media section reads one way across
 * kinds rather than as a filename row here and a status card there.
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
 * ⭐ **The chips are `@anthers/web-shared/content/media-status`'s** (2026-10-17): the
 * Works table's Media Status column shows the same per-variant chips, extracted so the
 * two surfaces cannot drift — this card remains the one place that carries their
 * actions, because acting on a file belongs to the Work's own page.
 *
 * ⚠️ **This card is the owner's own surface** — it renders only in the editor container
 * (video pass, 2026-10-13); a user's page keeps the single TranscodingStatus line it
 * has always shown while a ladder is missing.
 */

import {
	AudioMediaStatusChips,
	VideoMediaStatusChips,
} from "@anthers/web-shared/content/media-status";
import { FormatsHint, fileRules, isFileWorkType } from "@anthers/web-shared/content/work-media";
import TranscodingStatus from "@anthers/web-shared/media/TranscodingStatus";
import FileUpload from "@anthers/web-shared/ui/FileUpload";
import type { WorkUpload } from "@anthers/web-shared/work-uploads";
import { useEffect, useRef, useState } from "react";
import type { WorkDetail } from "./WorkLayout";

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
	const uploading = sourceUpload?.status === "uploading" || sourceUpload?.status === "attaching";
	const [replaceOpen, setReplaceOpen] = useState(false);
	const onOpenReplace = () => setReplaceOpen(true);

	return (
		<section
			aria-label="Media status"
			// The tab's own section names the media; this holds only its facts.
			className="flex flex-col gap-3"
		>
			{type === "video" && (
				<VideoMediaStatusChips
					work={work}
					sourceUpload={sourceUpload}
					// The original is the one chip that acts — replace or remove, from its
					// pencil — and only this page owns those flows.
					originalActions={unpublished ? { onReplace: () => onOpenReplace(), onRemove } : undefined}
					removeBusy={removeBusy}
				/>
			)}

			{(type === "audio" || type === "music") && (
				<AudioMediaStatusChips
					work={work}
					sourceUpload={sourceUpload}
					originalActions={unpublished ? { onReplace: () => onOpenReplace(), onRemove } : undefined}
					removeBusy={removeBusy}
				/>
			)}

			{/* The file as it goes up: the progress line and the one warning a closed tab
			    punishes — the upload is this tab's life, so the page says so while it runs. */}
			{uploading && sourceUpload && (
				<div className="flex flex-col gap-1.5">
					<progress
						className="progress progress-primary w-full"
						value={sourceUpload.progress ?? undefined}
						max={100}
					/>
					<p className="text-xs text-base-content/50">
						{sourceUpload.status === "attaching"
							? "Finishing"
							: `Uploading${sourceUpload.progress == null ? "" : ` — ${sourceUpload.progress}%`}`}
						. Keep this tab open: closing it stops the upload.
					</p>
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
					{unpublished && (
						<button
							type="button"
							className="btn btn-xs mt-2"
							onClick={onCancel}
							disabled={cancelBusy}
						>
							{cancelBusy ? "Canceling…" : "Cancel processing"}
						</button>
					)}
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

			{canReplace && (
				<ReplaceDialog
					type={type}
					open={replaceOpen}
					onClose={() => setReplaceOpen(false)}
					onFile={onReplaceFile}
				/>
			)}
		</section>
	);
}

/**
 * Replace the file, asked for deliberately: the *Original* chip's dropdown opens it, and
 * it states the formats the file must satisfy (the sentence the card carried, said where
 * it is actually needed). The work-uploads store watches the pick, so the dialog close
 * and the progress read are the page's, not this dialog's.
 */
function ReplaceDialog({
	type,
	open,
	onClose,
	onFile,
}: {
	type: "video" | "image" | "music" | "audio" | "comic" | "ebook";
	open: boolean;
	onClose: () => void;
	onFile: (file: File) => void;
}) {
	// State, not a ref: the Replace button's disabled reads this on every render, and a
	// ref that changed silently would leave the only way forward disabled (the defect the
	// fresh walkthrough caught, 2026-10-13).
	const [pending, setPending] = useState<File | null>(null);

	const dialog = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		if (open) {
			setPending(null);
			dialog.current?.showModal();
		}
	}, [open]);

	return (
		<>
			{open && (
				<dialog
					ref={dialog}
					className="modal"
					onClose={() => {
						onClose();
						setPending(null);
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
								onFileSelect={setPending}
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
								disabled={!pending}
								onClick={() => {
									if (pending) onFile(pending);
									setPending(null);
									dialog.current?.close();
								}}
							>
								Replace
							</button>
						</div>
					</div>
					<form method="dialog" className="modal-backdrop">
						<button type="button" aria-label="Close the replace dialog" />
					</form>
				</dialog>
			)}
		</>
	);
}
