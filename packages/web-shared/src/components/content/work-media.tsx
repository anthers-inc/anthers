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
 * would erase a file that arrived a moment earlier. `WorkFileDropzone`, which holds the
 * never-arrived states inside the Work placeholder itself (the dropper task, 2026-10-17), keeps
 * the same boundary.
 *
 * 🚨 **Every upload is processed server-side, and there is no choice to offer.** This
 * carried an *Encode on device / Upload & we process* toggle plus a desktop-only native
 * picker that encoded through the bundled ffmpeg sidecar, and both were removed on
 * 2026-08-17 because the on-device implementations did not work. On-device returns as the
 * desktop app's separate pre-process step, which hands the creator an upload pack to upload
 * here like any other file. Don't reintroduce an encode in the browser.
 */

import { acceptedVideoFormatsSentence } from "@anthers/shared/accepted-formats";
import { embedUrlProblem, isPaged, workNeedsFile } from "@anthers/shared/content";
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
import { PagedSourceFiles } from "./PagedSourceFiles";

/** The Work kinds whose file is uploaded into them, as the upload store names them. */
export type FileWorkType = Extract<WorkUploadTarget, { kind: "source" }>["type"];

export function isFileWorkType(type: string): type is FileWorkType {
	return workNeedsFile(type);
}

/** The accepted-formats sentence under a file picker, for the kinds whose file carries one. */
export function FormatsHint({ type }: { type: FileWorkType }) {
	const formats = fileRules(type).formats;
	if (!formats) return null;
	return <p className="mt-2 text-xs text-base-content/50">{formats}</p>;
}

/**
 * What a file picker for this kind accepts, and how large a file it takes.
 *
 * 🚨 **These caps are picked to what the pipeline behind them tolerates, not to what
 * storage accepts.** A Work's source goes up through the resumable multipart session
 * (`packages/web-shared/src/lib/upload.ts`) wherever the plan is more than one part, so
 * the transport's own ceiling is the bucket's — ten thousand 64 MiB parts is ~640 GB,
 * and no session cap belongs in this table. What binds each kind is the worker behind
 * it: `apps/api/src/jobs/transcode-video.ts` reads a video's source from App Platform's
 * ephemeral filesystem — 4 GiB total per container — with the encode ladder beside it,
 * so the video cap is the share of that disk a master may claim; the binding constraint
 * for a PDF is the rasterize job: `apps/api/src/jobs/render-paged.ts` writes the source
 * to the same filesystem alongside every page image it renders before uploading them,
 * so the source cap is the share of that disk a book may claim. 2 GB is that share with
 * room for the rendered pages, and parity with the video cap; a 5 GB cap would trade
 * "cannot upload a giant master" for "the job dies out of disk partway through a
 * 2000-page render". A page image is bounded not by that disk but by the job's decode
 * bound (`PAGE_MAX_PIXELS`) and its own re-encode — the 2 GB accept is the same number
 * either way, so one ceiling covers both paths and the creator's page quality lives
 * downstream of it.
 */
/**
 * What a file picker for this kind accepts, and how large a file it takes.
 *
 * 🚨 **These caps are picked to what the pipeline behind them tolerates, not to what
 * storage accepts.** A Work's source goes up through the resumable multipart session
 * (`packages/web-shared/src/lib/upload.ts`) wherever the plan is more than one part, so
 * the transport's own ceiling is the bucket's — ten thousand 64 MiB parts is ~640 GB,
 * and no session cap belongs in this table. What binds each kind is the worker behind
 * it: `apps/api/src/jobs/transcode-video.ts` reads a video's source from App Platform's
 * ephemeral filesystem — 4 GiB total per container — with the encode ladder beside it,
 * so the video cap is the share of that disk a master may claim; the binding constraint
 * for a PDF is the rasterize job: `apps/api/src/jobs/render-paged.ts` writes the source
 * to the same filesystem alongside every page image it renders before uploading them,
 * so the source cap is the share of that disk a book may claim. 2 GB is that share with
 * room for the rendered pages, and parity with the video cap; a 5 GB cap would trade
 * "cannot upload a giant master" for "the job dies out of disk partway through a
 * 2000-page render". A page image is bounded not by that disk but by the job's decode
 * bound (`PAGE_MAX_PIXELS`) and its own re-encode — the 2 GB accept is the same number
 * either way, so one ceiling covers both paths and the creator's page quality lives
 * downstream of it.
 *
 * `formats`, when the kind carries one, is the sentence telling a creator what may be
 * inside the file — the accepted formats stated where the file is picked rather than
 * discovered by failure (the second ruling of the wiki's *Originals and the Ladder*).
 * The video sentence reads from `@anthers/shared/accepted-formats`, the same dataset the
 * transcode job's refusal states, so the two say the set alike and widen together.
 */
export function fileRules(type: FileWorkType): {
	accept: string;
	maxSize: number;
	noun: string;
	formats?: string;
} {
	switch (type) {
		case "video":
			return {
				accept: "video/*",
				maxSize: 2 * 1024 * 1024 * 1024,
				noun: "a video file",
				formats:
					`Inside the file: ${acceptedVideoFormatsSentence()}. Any container is fine — ` +
					"MP4, MOV and MKV all work, and a file a browser can't stream as it stands is " +
					"remuxed on arrival, with no re-encode, before processing starts. A video with " +
					"no audio track is fine too.",
			};
		case "music":
		case "audio":
			return {
				accept: "audio/*",
				maxSize: 500 * 1024 * 1024,
				noun: "an audio file",
				formats:
					"Any common audio format — anything you can open in a music player. It's converted to MP3 for streaming as it is processed.",
			};
		case "image":
			return { accept: "image/*", maxSize: 20 * 1024 * 1024, noun: "an image" };
		case "comic":
			// Page images lead (Parker, 2026-10-11) — the paged job renders image leaves
			// directly, one leaf per page — and the PDF stays: it is what a whole-book
			// master ships as, and the set is built from whatever mix the creator holds.
			// The comic's own container (CBZ) and the authored-fixed EPUB 3 FXL sit in
			// the format ladder's tail, parked — an accept for those lands when the
			// ingest for them does.
			return {
				accept: "image/jpeg,image/png,application/pdf",
				maxSize: 2 * 1024 * 1024 * 1024,
				noun: "a page image (JPG or PNG) or a PDF",
			};
		case "ebook":
			// The EPUB rides beside the paged set's files (the reflow path's source — the
			// 2026-10-11 design's native ebook source): it must NOT be mixed into a set
			// with page-shaped files, which the routing and the ingest both refuse
			// legibly, and it processes on its own queue into `work_sections` rather
			// than pages, so `downloadEnabled: false` keeps holding for a reflow book too.
			return {
				accept: "image/jpeg,image/png,application/pdf,application/epub+zip,.epub",
				maxSize: 2 * 1024 * 1024 * 1024,
				noun: "a page image (JPG or PNG), a PDF, or an EPUB",
			};
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
 * The dropper for a draft that has never arrived at a file, mounted in the Work
 * placeholder itself (the dropper task, 2026-10-17): the act of filling the Work
 * happens where the Work will be, rather than down in the Manage tab's form. The
 * two states it carries are the ones a fileless page can be in — nothing yet, or
 * the upload a closed tab left failed — and an upload in flight quiets it, because
 * the page's own aside carries the progress while it runs.
 *
 * Reads the upload store and the stored row, and never contributes a `sourceKey`
 * to a save — the same boundary its sibling `WorkFileSection` holds (see the
 * module head). The caller decides which kinds mount it: the paged kinds keep
 * their set editor on the Manage tab, and a video's source is the Media Status
 * card's, so neither reaches this.
 */
export function WorkFileDropzone({ work }: { work: Work }) {
	const type = work.type as FileWorkType;
	const upload = useSourceUpload(work.id);
	const rules = fileRules(type);
	const start = (file: File) => workUploads.start(work.id, file, { kind: "source", type });

	if (upload && isUploading(upload)) {
		// The page's aside carries the progress and the Manage tab's file section the
		// cancel — this renders nothing while the same upload is climbing, rather than
		// repeating it a third time inside the placeholder.
		return null;
	}

	if (upload?.status === "failed") {
		return (
			<div className="flex flex-col gap-2">
				<div className="alert alert-error text-sm">
					<span className="flex-1">{upload.error}</span>
					<button type="button" className="btn btn-sm" onClick={() => workUploads.retry(upload.id)}>
						Try again
					</button>
				</div>
				<FileUpload
					accept={rules.accept}
					maxSize={rules.maxSize}
					compact
					label="Or choose a different file"
					onFileSelect={start}
				/>
				<FormatsHint type={type} />
			</div>
		);
	}

	return (
		<div className="flex flex-col items-center gap-1.5">
			{/* The one invisible fact the empty state carries; the picker's own label
			    below says the act, so the line says nothing about picking or dropping
			    (UI copy says what the screen cannot, the 2026-10-17 rule). */}
			<p className="text-sm text-warning">No file yet, so this Work can't be released.</p>
			<FileUpload
				accept={rules.accept}
				maxSize={rules.maxSize}
				label={`Drop ${rules.noun} or click to browse`}
				onFileSelect={start}
			/>
			<FormatsHint type={type} />
		</div>
	);
}

/**
 * The file section of a Work's own page, for the arrived states — the Manage tab's
 * form for a Work whose file exists or is climbing from this tab. The caller mounts
 * it only in those states: the never-arrived and failed upload live in the Work
 * placeholder itself now, carried by {@link WorkFileDropzone} (the dropper task,
 * 2026-10-17), so neither is a state this can be reached in — unless the Work is
 * paged, whose file section is the SET editor in every state.
 */
export function WorkFileSection({ work }: { work: Work }) {
	const type = work.type as FileWorkType;
	const upload = useSourceUpload(work.id);
	// A paged Work's file section is the SET editor — the list with add, reorder, remove —
	// whether the set is one file or several; the in-flight states it shares with every
	// kind are handled inside (they read the same upload store). Called after the hooks,
	// which its sibling states are what keep ordered.
	if (isPaged(type)) return <PagedSourceFiles work={work} />;

	const label = type === "image" ? "Image" : "File";
	const rules = fileRules(type);
	const start = (file: File) => workUploads.start(work.id, file, { kind: "source", type });

	if (upload && isUploading(upload)) {
		return (
			<FormField label={label}>
				<UploadProgress upload={upload} />
				<p className="mt-2 text-xs text-base-content/50">
					You can go on editing and move around the Studio while it uploads. Keep this tab open
					until it finishes, because closing it stops the upload.
				</p>
				<button
					type="button"
					className="btn btn-sm mt-2"
					onClick={() => workUploads.cancel(upload.id)}
				>
					Cancel the upload
				</button>
			</FormField>
		);
	}

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
