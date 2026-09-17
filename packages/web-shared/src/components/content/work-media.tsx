// SPDX-License-Identifier: Apache-2.0
/**
 * The media half of a Work: the file a video, a track, an image or a book IS, and the fields
 * the other kinds carry instead of one.
 *
 * 🚨 **The file and the fields are written by different requests, and that is the design.** A
 * Work is created the moment its file is picked (Parker, 2026-09-16) and the file is attached by
 * `lib/work-uploads` when it arrives, while the creator is editing the same Work on its page. So
 * `WorkFileSection` reads the upload store and the stored row, and never contributes a
 * `sourceKey` to the page's save — a whole-form save carrying the key the page loaded, empty,
 * would erase a file that arrived a moment earlier.
 *
 * 🚨 **Every upload is processed server-side, and there is no choice to offer.** This
 * carried an *Encode on device / Upload & we process* toggle plus a desktop-only native
 * picker that encoded through the bundled ffmpeg sidecar, and both were removed on
 * 2026-08-17 because the on-device implementations did not work. On-device returns as the
 * desktop app's separate pre-process step, which hands the creator an upload pack to upload
 * here like any other file. Don't reintroduce an encode in the browser.
 */

import { embedUrlProblem, workNeedsFile } from "@anthers/shared/content";
import { type ReactNode, useState } from "react";
import type { UploadableWorkType, Work, WorkInput } from "../../lib/types";
import {
	isUploading,
	useSourceUpload,
	type WorkUpload,
	type WorkUploadTarget,
	workUploads,
} from "../../lib/work-uploads";
import TranscodingStatus from "../media/TranscodingStatus";
import { keyToPreview } from "../post/mediaUpload";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";

/** The Work kinds whose file is uploaded into them, as the upload store names them. */
export type FileWorkType = Extract<WorkUploadTarget, { kind: "source" }>["type"];

export function isFileWorkType(type: string): type is FileWorkType {
	return workNeedsFile(type);
}

/** What a file picker for this kind accepts, and how large a file it takes. */
export function fileRules(type: FileWorkType): { accept: string; maxSize: number; noun: string } {
	switch (type) {
		case "video":
			return { accept: "video/*", maxSize: 2 * 1024 * 1024 * 1024, noun: "a video file" };
		case "audio":
			return { accept: "audio/*", maxSize: 500 * 1024 * 1024, noun: "an audio file" };
		case "image":
			return { accept: "image/*", maxSize: 20 * 1024 * 1024, noun: "an image" };
		case "ebook":
			return { accept: "application/pdf", maxSize: 500 * 1024 * 1024, noun: "a PDF" };
	}
}

/** The free-text detail a physical good or a service carries, out of `metadata.note`. */
function metaNote(item: Work | null | undefined): string {
	const note = item?.metadata?.note;
	return typeof note === "string" ? note : "";
}

export interface WorkDetails {
	/** This kind's own control, or null for a kind whose media is its file. */
	slot: ReactNode;
	/** The kind's fields, to merge into the page's save. Never a `sourceKey` — see the header. */
	fields: () => Omit<Partial<WorkInput>, "type" | "sourceKey">;
}

/**
 * What a game, a piece of software, a physical good or a service carries in place of a file: an
 * embed address for the first two, a note for the other two.
 */
export function useWorkDetails(type: UploadableWorkType, editing: Work): WorkDetails {
	const [embedUrl, setEmbedUrl] = useState(editing.embedUrl ?? "");
	const [detailsNote, setDetailsNote] = useState(metaNote(editing));

	// The server refuses the same addresses; saying so here means a creator hears it beside the field.
	const embedError = embedUrlProblem(embedUrl.trim());

	if (type === "game" || type === "software") {
		return {
			slot: (
				<FormField
					label="Embed URL (optional)"
					hint="For an HTML5 or WebGL build that runs in the browser, hosted on another site at an https:// address. Downloadable builds are added below."
					error={embedError ?? undefined}
				>
					<input
						type="url"
						className="input input-bordered w-full"
						value={embedUrl}
						onChange={(e) => setEmbedUrl(e.target.value)}
						placeholder="https://example.com/embed"
					/>
				</FormField>
			),
			fields: () => ({ embedUrl: embedUrl.trim() }),
		};
	}
	if (type === "physical" || type === "service") {
		return {
			slot: (
				<FormField label="Details">
					<textarea
						className="textarea textarea-bordered w-full"
						value={detailsNote}
						onChange={(e) => setDetailsNote(e.target.value)}
						rows={3}
						placeholder={
							type === "physical"
								? "Fulfillment notes, dimensions, shipping…"
								: "What the service includes, turnaround, terms…"
						}
					/>
				</FormField>
			),
			fields: () => ({ metadata: { note: detailsNote.trim() } }),
		};
	}
	return { slot: null, fields: () => ({}) };
}

/** A progress bar for one upload, or an indeterminate one where the transport reports none. */
export function UploadProgress({ upload }: { upload: WorkUpload }) {
	const label =
		upload.status === "attaching"
			? "Finishing"
			: upload.progress == null
				? "Uploading"
				: `${upload.progress}%`;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3 rounded-lg bg-base-200 p-3">
				<span className="flex-1 truncate text-sm">{upload.fileName}</span>
				<span className="font-mono text-xs">{label}</span>
			</div>
			{upload.progress == null || upload.status === "attaching" ? (
				<progress className="progress progress-primary w-full" />
			) : (
				<progress className="progress progress-primary w-full" value={upload.progress} max="100" />
			)}
		</div>
	);
}

/**
 * The file section of a Work's own page, for the kinds that are their file.
 *
 * Four states, in the order a creator meets them: still uploading from this tab, failed, arrived,
 * and never arrived. The last is a real state rather than an error — the tab that was uploading
 * may have been closed — and it offers the upload again rather than explaining why it happened.
 */
export function WorkFileSection({
	work,
	landing = false,
}: {
	work: Work;
	/**
	 * True between an upload from this tab reporting done and the page re-reading the row. The
	 * row decides after that, so a file attached and then lost again shows as missing rather than
	 * as uploaded on the strength of an upload that finished earlier.
	 */
	landing?: boolean;
}) {
	const type = work.type as FileWorkType;
	const upload = useSourceUpload(work.id);
	const rules = fileRules(type);
	const start = (file: File) => workUploads.start(work.id, file, { kind: "source", type });

	const label = type === "image" ? "Image" : type === "ebook" ? "Book file" : "File";

	if (upload && isUploading(upload)) {
		return (
			<FormField label={label}>
				<UploadProgress upload={upload} />
				<p className="mt-2 text-xs text-base-content/50">
					You can go on editing and move around the Studio while it uploads. Keep this tab open
					until it finishes, because closing it stops the upload.
				</p>
			</FormField>
		);
	}

	if (upload?.status === "failed") {
		return (
			<FormField label={label}>
				<div className="alert alert-error text-sm">
					<span className="flex-1">{upload.error}</span>
					<button type="button" className="btn btn-sm" onClick={() => workUploads.retry(upload.id)}>
						Try again
					</button>
				</div>
				<div className="mt-2">
					<FileUpload
						accept={rules.accept}
						maxSize={rules.maxSize}
						compact
						label="Or choose a different file"
						onFileSelect={start}
					/>
				</div>
			</FormField>
		);
	}

	// Arrived: stored on the row, or attached from this tab a moment before the row is re-read.
	if (work.sourceKey || (landing && upload?.status === "done")) {
		return (
			<FormField label={label}>
				{type === "image" && work.sourceKey ? (
					<div className="flex flex-col gap-2">
						<img
							src={keyToPreview(work.sourceKey)}
							alt=""
							className="max-h-64 w-fit rounded-lg border border-base-300"
						/>
						{/* An image is replaced in place, as it could be before it had an upload step.
						    Other kinds are not offered this: a new video re-encodes, and a released
						    one would be unplayable while it did. */}
						<div className="max-w-xs">
							<FileUpload
								accept={rules.accept}
								maxSize={rules.maxSize}
								compact
								label="Replace the image"
								onFileSelect={start}
							/>
						</div>
					</div>
				) : (
					<div className="flex items-center gap-3 rounded-lg bg-base-200 p-3">
						<span className="flex-1 truncate text-sm">{upload?.fileName ?? "Uploaded file"}</span>
						<span className="badge badge-success badge-sm">Uploaded</span>
					</div>
				)}
				{/* The processing a landed file starts, with its estimate where there is one. The
				    page re-reads the row while it runs; the block goes once processing completes. */}
				{work.transcoding && work.transcoding.status !== "completed" && (
					<div className="mt-2">
						<TranscodingStatus
							status={work.transcoding.status}
							progress={work.transcoding.progress ?? 0}
							etaSeconds={work.transcoding.etaSeconds}
							errorMessage={work.transcoding.errorMessage ?? undefined}
						/>
					</div>
				)}
			</FormField>
		);
	}

	return (
		<FormField label={label}>
			<p className="mb-2 text-sm text-warning">
				This Work has no file yet, so it can't be released. If it was uploading in a tab that has
				since closed, upload it again here.
			</p>
			<FileUpload
				accept={rules.accept}
				maxSize={rules.maxSize}
				label={`Drop ${rules.noun} or click to browse`}
				onFileSelect={start}
			/>
		</FormField>
	);
}
