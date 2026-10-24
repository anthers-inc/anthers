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
import { WEB_BUILD_FILE_MAX } from "@anthers/shared/web-build";
import { type ReactNode, useState } from "react";
import type { ContentType, UploadableWorkType, Work, WorkInput } from "../../lib/types";
import {
	isUploading,
	useSourceUpload,
	type WorkUpload,
	type WorkUploadTarget,
	workUploads,
} from "../../lib/work-uploads";
import TranscodingStatus from "../media/TranscodingStatus";
import FileUpload, { fileSizeSentence } from "../ui/FileUpload";
import FormField from "../ui/FormField";
import { ImageSourceFiles } from "./ImageSourceFiles";
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
			// 🚨 **A comic's pages are page images** (Parker, 2026-10-19): JPG or PNG only.
			// A 1.31 GB, 119-page PDF took 25m53s to process, 20 minutes of it in one
			// `pdftoppm` pass; an image leaf is already a page, so the same count becomes
			// one `sharp` normalize per page and keeps its own resolution. The PDF branch
			// in `render-paged` stays for pages already carried that way and for a book,
			// which still takes a PDF beside an EPUB. CBZ and authored-fixed EPUB 3 FXL
			// remain in the format ladder's tail, parked.
			return {
				accept: "image/jpeg,image/png",
				maxSize: 2 * 1024 * 1024 * 1024,
				noun: "page images (JPG or PNG)",
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

/**
 * What the media intake's card says about the kind being chosen, and the platform a build is
 * for.
 *
 * ⭐ **The card follows the kind rather than stating every kind at once** (Parker, 2026-10-19):
 * a creator choosing a video reads the video's set, its cap and what the pipeline does with
 * it, instead of a list of four media whose irrelevant entries they must skip. It sits under
 * the picker, where the fact is worth having, and every sentence is one this page can keep:
 * the caps read from `fileRules`, the video set from `@anthers/shared/accepted-formats`, so
 * the copy and the pipeline widen together.
 *
 * ⚠️ **A build's platform is part of its fact** — a Windows installer and a macOS `.dmg` are
 * what a person can actually run — so the build kinds' middle point follows the Platform
 * select above the card. A platform this build does not name falls back to the other-kinds
 * sentence rather than showing nothing.
 */
export interface WorkTypeFactsCopy {
	/** The card's title, naming the kind. */
	heading: string;
	/** The facts, one sentence or two each. */
	points: string[];
	/** The standing note under the list, where the kind carries one. */
	note?: string;
}

/** What a person can run on each platform a build can be labeled for. */
const PLATFORM_POINTS: Record<string, string> = {
	windows:
		"Windows — a .zip or an installer (.exe or .msi); Windows may warn about an unsigned build's publisher.",
	mac: "macOS — a .zip or a .dmg; an unsigned app needs the reader to allow it in Gatekeeper the first time.",
	linux: "Linux — a .zip, .AppImage, .deb or a tarball, whichever suits what you ship.",
	android:
		"Android — an .apk, which people install after allowing installs from outside the Play Store.",
	ios: "iOS — a download can't be installed on an iPhone, so there is no build to upload for iOS; if your app is on the App Store, name it in the description.",
	other: "Other — any file people can run.",
};

/** The build kinds' shared points, with the platform's own sentence between them. */
function buildFacts(kind: "game" | "software", platform: string | undefined): WorkTypeFactsCopy {
	if (platform === "web") {
		return {
			heading: "What a browser build needs",
			points: [
				"The export folder, or a .zip of it: the entry file the build loads first — usually index.html — and every file the engine's export wrote beside it, such as the loader script, the .wasm, the .pck, the audio worklets, icons and assets.",
				`Up to ${fileSizeSentence(WEB_BUILD_FILE_MAX)} per file.`,
				"Threaded, if the engine's export turned thread support on (SharedArrayBuffer). It decides where the build plays from, so answer it here.",
			],
			note: "Anthers hosts the build. Delivery to players opens with the hosted-build launch; today this stores the files a player will load.",
		};
	}
	return {
		heading: `What Anthers accepts for a ${kind === "game" ? "game" : "piece of software"}`,
		points: [
			"A build — the file you add here becomes the Work's primary download.",
			PLATFORM_POINTS[platform ?? "other"] ?? PLATFORM_POINTS.other,
		],
	};
}

const WORK_TYPE_FACTS: Record<ContentType, (platform: string | undefined) => WorkTypeFactsCopy> = {
	video: () => ({
		heading: "What Anthers accepts for a video",
		points: [
			`Format — ${acceptedVideoFormatsSentence()}. MP4, MOV, MKV and WebM all work, and a file in another container carrying one of those pairs is remuxed as it arrives, with no re-encode, before processing starts.`,
			"A video with no audio track is fine too.",
			`Size — up to ${fileSizeSentence(fileRules("video").maxSize)}.`,
		],
		note: "The set is short on purpose, and it widens only by decision: a format joins it when Anthers decides to deliver it, and this page states each addition as it lands. If your file isn't in the set, re-export it with one from above.",
	}),
	music: () => ({
		heading: "What Anthers accepts for music",
		points: [
			"Format — any common audio format, whatever a music player opens.",
			"What happens — it's converted to MP3 for streaming as it's processed, with a waveform drawn for the player.",
			`Size — up to ${fileSizeSentence(fileRules("music").maxSize)}.`,
		],
	}),
	audio: () => ({
		heading: "What Anthers accepts for audio",
		points: [
			"Format — any common audio format, whatever a music player opens: a podcast, an audiobook, an audio drama, a soundscape. Songs belong under Music.",
			"What happens — it's converted to MP3 for streaming as it's processed, with a waveform drawn for the player.",
			`Size — up to ${fileSizeSentence(fileRules("audio").maxSize)}.`,
		],
	}),
	image: () => ({
		heading: "What Anthers accepts for an image",
		points: [
			"Format — any image format a browser displays.",
			"A set — the image you pick here is the first; the Work's page adds more, in the order a reader sees them. The first is what listings show.",
			`Size — up to ${fileSizeSentence(fileRules("image").maxSize)} per image.`,
		],
	}),
	comic: () => ({
		heading: "What Anthers accepts for a comic",
		points: [
			"Format — JPG or PNG page images; a set of them is one Work.",
			"What happens — pages are rendered from the set in its order, and read one at a time.",
			"A PDF or a CBZ isn't taken — export its pages as JPG or PNG images and add them in order.",
			`Size — up to ${fileSizeSentence(fileRules("comic").maxSize)} per file.`,
		],
	}),
	ebook: () => ({
		heading: "What Anthers accepts for a book",
		points: [
			"Format — an EPUB, or JPG or PNG page images, or a PDF.",
			"An EPUB is processed on its own and reflows as text, so it can't share a Work with page images or a PDF.",
			"What happens — a page set is rendered in its order and read page by page; an EPUB is read as reflowing text.",
			`Size — up to ${fileSizeSentence(fileRules("ebook").maxSize)} per file.`,
		],
	}),
	game: (platform) => buildFacts("game", platform),
	software: (platform) => buildFacts("software", platform),
	text: () => ({
		heading: "What a written Work is",
		points: [
			"Nothing is uploaded: you write it on the Work's page, and it reads as an article.",
			"Like any Work, it can be gated, sold or given away. For an announcement, write a post instead.",
		],
	}),
	physical: () => ({
		heading: "What a physical Work carries",
		points: [
			"Nothing is uploaded or streamed: the Work describes what ships.",
			"Dimensions, shipping and what arrives are written on its page. Selling a creator's own shipped good isn't open yet.",
		],
	}),
	service: () => ({
		heading: "What a service Work carries",
		points: [
			"Nothing is uploaded or streamed: the Work describes what you do.",
			"What it includes, the turnaround and the terms are written on its page, and it's sold rather than played.",
		],
	}),
};

/** The copy for one kind's card: the heading, its facts, and any standing note. */
export function workTypeFacts(type: ContentType, platform?: string): WorkTypeFactsCopy {
	return WORK_TYPE_FACTS[type](platform);
}

/**
 * The card under the media intake's picker: what the chosen kind takes, what the platform's
 * build should be, and what the pipeline does with it. A region with an accessible name so
 * the heading is how the card is found, by a screen reader and by a browser walk alike.
 */
export function WorkTypeFacts({ type, platform }: { type: ContentType; platform?: string }) {
	const facts = workTypeFacts(type, platform);
	return (
		<section
			aria-labelledby="work-type-facts-heading"
			className="rounded-lg bg-base-200/50 p-4 text-sm"
		>
			<p id="work-type-facts-heading" className="mb-2 font-medium">
				{facts.heading}
			</p>
			<ul className="list-disc space-y-1 pl-5 text-base-content/70">
				{facts.points.map((point) => (
					<li key={point}>{point}</li>
				))}
			</ul>
			{facts.note && <p className="mt-2 text-xs text-base-content/50">{facts.note}</p>}
		</section>
	);
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
 * their set editor on the Manage tab in every state, and a video's or a listened
 * Work's source is the Media Status card's, so neither reaches this; the image
 * kind's set editor does (it is the Manage tab's form once pictures exist), but a
 * draft's dropper lives in the box like every other non-paged file kind's.
 */
export function WorkFileDropzone({
	work,
	showFormats = true,
}: {
	work: Work;
	/**
	 * Whether the picker carries its own one-line format hint. The New Work page's media
	 * intake passes false because `WorkTypeFacts` is already below it, and the two
	 * sentences say the same thing (Parker, 2026-10-23).
	 */
	showFormats?: boolean;
}) {
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
				{showFormats && <FormatsHint type={type} />}
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
			{showFormats && <FormatsHint type={type} />}
		</div>
	);
}

/**
 * The file section of a Work's own page, for the arrived states — the Manage tab's
 * form for a Work whose file exists or is climbing from this tab. The caller mounts
 * it only in those states: the never-arrived and failed upload live in the Work
 * placeholder itself now, carried by {@link WorkFileDropzone} (the dropper task,
 * 2026-10-17), so neither is a state this can be reached in — every set kind's file
 * section is the SET editor in every state.
 */
export function WorkFileSection({ work }: { work: Work }) {
	const type = work.type as FileWorkType;
	const upload = useSourceUpload(work.id);
	// A set-kind Work's file section is the SET editor — the list with add, reorder, remove —
	// whether the set is one file or several; the in-flight states it shares with every
	// kind are handled inside (they read the same upload store). Called after the hooks,
	// which its sibling states are what keep ordered.
	if (isPaged(type)) return <PagedSourceFiles work={work} />;
	if (type === "image") return <ImageSourceFiles work={work} />;

	const label = "File";

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
			<div className="flex items-center gap-3 rounded-lg bg-base-200 p-3">
				<span className="flex-1 truncate text-sm">{upload?.fileName ?? "Uploaded file"}</span>
				<span className="badge badge-success badge-sm">Uploaded</span>
			</div>
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
