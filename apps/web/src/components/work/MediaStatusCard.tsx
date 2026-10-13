// SPDX-License-Identifier: Apache-2.0
/**
 * **Media Status** — one card that says where this Work's media stands, replacing the
 * separate filename-and-"Uploaded" card and the processing block that used to sit apart
 * (Parker, 2026-10-13: a unified card showing upload, processing and which processed
 * variants exist together — and carrying the actions that act on that state).
 *
 * The variants it lists are the facts the serialization already answers: an HLS ladder
 * manifest, the audio-only rendition beside it (the facts `userTranscoding` nulls when
 * absent, so their presence IS the processed state — no second source of truth to drift).
 *
 * ⚠️ **This card is the owner's own surface** — it renders only in the editor container
 * (video pass, 2026-10-13); a user's page keeps the single TranscodingStatus line it
 * has always shown while a ladder is missing.
 */

import { FormatsHint, fileRules } from "@anthers/web-shared/content/work-media";
import TranscodingStatus from "@anthers/web-shared/media/TranscodingStatus";
import type { Work } from "@anthers/web-shared/types";
import FileUpload from "@anthers/web-shared/ui/FileUpload";
import type { WorkUpload } from "@anthers/web-shared/work-uploads";
import type { WorkDetail } from "./WorkLayout";

/**
 * One line in the card's variant list: what has been produced from the Work's file.
 * `ready` is presence — the URL the serializer hands over when the object exists.
 */
function Variant({ name, ready }: { name: string; ready: string | "" }) {
	return (
		<li className="flex items-center justify-between gap-2 text-xs">
			<span>{name}</span>
			{ready ? (
				<span className="badge badge-success badge-xs badge-outline">Ready</span>
			) : (
				<span className="text-base-content/40">Pending</span>
			)}
		</li>
	);
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
	const canReplace = type === "video" || type === "image" || type === "comic";
	const job = work.transcoding;
	const running = job != null && (job.status === "pending" || job.status === "processing");
	const failed = job?.status === "failed";
	const uploading = sourceUpload?.status === "uploading" || sourceUpload?.status === "attaching";

	return (
		<section
			aria-label="Media status"
			// `status` once more — the card is the page's persistent media state, not an alert.
			className="rounded-box border border-base-300 bg-base-100 px-4 py-3 flex flex-col gap-2"
		>
			<div className="flex items-center justify-between gap-2">
				<h2 className="text-sm font-semibold">Media Status</h2>
				{(() => {
					// The card's headline state, in one badge: the row's whole truth at a glance.
					if (uploading || sourceUpload?.status === "failed") {
						return sourceUpload?.status === "failed" ? (
							<span className="badge badge-error badge-sm">Upload failed</span>
						) : (
							<span className="badge badge-warning badge-sm">Uploading</span>
						);
					}
					if (running) return <span className="badge badge-warning badge-sm">Processing</span>;
					if (failed) return <span className="badge badge-error badge-sm">Processing failed</span>;
					if (work.sourceKey) return <span className="badge badge-success badge-sm">Ready</span>;
					return <span className="badge badge-ghost badge-sm">No media yet</span>;
				})()}
			</div>

			{work.sourceKey && (
				<p className="truncate font-mono text-xs text-base-content/60" title={work.sourceKey}>
					{sourceUpload?.fileName ?? `Media for ${work.title ?? "this Work"}`}
				</p>
			)}

			{sourceUpload?.status === "failed" && sourceUpload.error && (
				<p className="text-xs">
					<span className="text-error">{sourceUpload.error}</span>
					<button type="button" className="btn btn-xs ml-2" onClick={onRetry}>
						Try again
					</button>
				</p>
			)}

			{type === "video" && work.sourceKey && (
				<ul className="flex flex-col gap-1">
					<Variant name="HLS ladder" ready={job?.hlsManifestUrl ?? ""} />
					<Variant name="Audio-only rendition" ready={job?.audioManifestUrl ?? ""} />
				</ul>
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

			{unpublished && (
				<div className="flex flex-wrap items-center gap-2 pt-1">
					{canReplace && (
						<div>
							<FileUpload
								accept={fileRules(type).accept}
								maxSize={fileRules(type).maxSize}
								compact
								label={type === "image" ? "Replace the image" : "Replace the file"}
								onFileSelect={onReplaceFile}
							/>
						</div>
					)}
					{unpublished && work.sourceKey && (
						<button
							type="button"
							className="btn btn-sm btn-error"
							onClick={onRemove}
							disabled={removeBusy}
						>
							Remove the media
						</button>
					)}
					{running && (
						<button type="button" className="btn btn-sm" onClick={onCancel} disabled={cancelBusy}>
							{cancelBusy ? "Canceling…" : "Cancel processing"}
						</button>
					)}
					{canReplace && <FormatsHint type={type} />}
				</div>
			)}
		</section>
	);
}
