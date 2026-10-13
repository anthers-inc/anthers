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
import {
	ArrowPathIcon,
	ArrowUpTrayIcon,
	CheckIcon,
	PencilSquareIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import type { WorkDetail } from "./WorkLayout";

/**
 * One chip in the variant row — the three states, as icons beside the name.
 *
 * The **Original** chip is the card's one interactive member (Parker's second pass,
 * 2026-10-13): blue, a touch longer than the others, with a pencil opening a dropdown
 * that carries the destructive actions — Replace File and Remove File. The actions live
 * where the file's identity is named, rather than as a button row of their own.
 */
function VariantChip({
	name,
	ready,
	running,
	actions,
}: {
	name: string;
	ready: string | "";
	running?: boolean;
	/** The dropdown member: never produced → it still carries the pencil, because there is
	 *  exactly nothing to replace until it exists; a chip with no actions is passive. */
	actions?: { onReplace: () => void; onRemove: () => void };
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
	return (
		<div className="dropdown dropdown-end">
			<button
				type="button"
				tabIndex={0}
				className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-info/40 bg-info/10 px-3.5 py-0.5 text-xs text-info hover:border-info"
				title="Replace or remove this Work's file"
			>
				{chip}
				{name}
				<PencilSquareIcon className="size-3 text-info/70" />
			</button>
			<ul
				tabIndex={0}
				className="dropdown-content menu z-20 rounded-box w-44 border border-base-300 bg-base-100 p-1 shadow-lg"
			>
				<li>
					<button type="button" onClick={actions.onReplace}>
						<ArrowUpTrayIcon className="size-4" />
						Replace File…
					</button>
				</li>
				<li>
					<button type="button" className="text-error" onClick={actions.onRemove}>
						<XMarkIcon className="size-4" />
						Remove File
					</button>
				</li>
			</ul>
		</div>
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
	const [replaceOpen, setReplaceOpen] = useState(false);
	const onOpenReplace = () => setReplaceOpen(true);

	return (
		<section
			aria-label="Media status"
			// The tab's own section names the media; this holds only its facts.
			className="flex flex-col gap-3"
		>
			{type === "video" && (
				<div className="flex flex-wrap items-center gap-1.5">
					{/* The original: the one variant that exists the moment the file does, and
					    the one chip that acts — replace or remove, from its pencil. */}
					<VariantChip
						name="Original"
						ready={work.sourceKey ? "ready" : ""}
						running={uploading}
						actions={
							unpublished ? { onReplace: () => onOpenReplace(), onRemove: onRemove } : undefined
						}
					/>
					<VariantChip name="Audio" ready={job?.audioManifestUrl ?? ""} running={running} />
					{depths.length > 0 ? (
						depths.map((h) => <VariantChip key={h} name={`${h}p`} ready="ready" />)
					) : (
						<VariantChip name="Ladder" ready={job?.hlsManifestUrl ?? ""} running={running} />
					)}
					{/* The failures stand at the row's end: the in-flight and ready states are
					    the chips' own answer (Parker's third pass, 2026-10-13). */}
					{sourceUpload?.status === "failed" && (
						<span className="badge badge-error badge-sm">Upload failed</span>
					)}
					{failed && <span className="badge badge-error badge-sm">Processing failed</span>}
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
						<button aria-label="Close the replace dialog" />
					</form>
				</dialog>
			)}
		</>
	);
}
