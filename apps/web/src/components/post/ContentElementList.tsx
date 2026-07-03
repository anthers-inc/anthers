// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Content section of the post form: an ordered, arbitrary array of typed
 * content elements (the post's deliverable). Each element carries a content-type
 * dropdown, type-specific setup, and an optional per-element thumbnail.
 */
import {
	ArrowDownIcon,
	ArrowUpIcon,
	PlusIcon,
	TrashIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useRef } from "react";
import type { ContentElement, ContentType } from "../../lib/types";
import { uploadMediaFile } from "../../lib/upload";
import RichTextEditor from "../editor/RichTextEditor";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";
import { keyToPreview, uploadImageFile } from "./mediaUpload";

// ─── Draft model ───

/** A single uploaded image within an image element: storage key + preview URL. */
interface DraftImage {
	key: string;
	preview: string;
}

/** In-form working copy of one content element. */
export interface ContentElementDraft {
	/** Stable local key for React lists (not the DB id). */
	localKey: string;
	/** DB id when this element already exists (preserves its uploaded assets on reconcile). */
	id?: number;
	contentType: ContentType;
	title: string;
	thumbnailKey: string;
	thumbnailPreview: string | null;
	bodyHtml: string;
	images: DraftImage[];
	videoKey: string;
	videoName: string | null;
	audioKey: string;
	audioName: string | null;
	embedUrl: string;
	metadataNote: string;
	uploading: boolean;
	progress: number;
}

/** Element input shape accepted by the posts create/patch API. */
export interface ContentElementInput {
	id?: number;
	contentType: ContentType;
	title?: string;
	thumbnail?: string;
	bodyHtml?: string;
	images?: string[];
	videoFile?: string;
	audioFile?: string;
	embedUrl?: string;
	durationSeconds?: number;
	metadata?: Record<string, unknown>;
}

const CONTENT_TYPE_OPTIONS: { value: ContentType; label: string }[] = [
	{ value: "text", label: "Text" },
	{ value: "image", label: "Image" },
	{ value: "audio", label: "Audio" },
	{ value: "video", label: "Video" },
	{ value: "game", label: "Game" },
	{ value: "software", label: "Software" },
	{ value: "physical", label: "Physical" },
	{ value: "service", label: "Service" },
];

let counter = 0;
function nextKey(): string {
	counter += 1;
	return `el-${Date.now()}-${counter}`;
}

/** A blank draft element (defaults to a text element). */
export function newElement(): ContentElementDraft {
	return {
		localKey: nextKey(),
		contentType: "text",
		title: "",
		thumbnailKey: "",
		thumbnailPreview: null,
		bodyHtml: "",
		images: [],
		videoKey: "",
		videoName: null,
		audioKey: "",
		audioName: null,
		embedUrl: "",
		metadataNote: "",
		uploading: false,
		progress: 0,
	};
}

/** Build a draft from a loaded content element (edit mode). */
export function draftFromElement(el: ContentElement): ContentElementDraft {
	const note =
		el.metadata && typeof el.metadata.note === "string" ? (el.metadata.note as string) : "";
	return {
		localKey: nextKey(),
		id: el.id,
		contentType: el.contentType,
		title: el.title ?? "",
		thumbnailKey: el.thumbnail ?? "",
		thumbnailPreview: el.thumbnail ? keyToPreview(el.thumbnail) : null,
		bodyHtml: el.bodyHtml ?? "",
		images: (el.images ?? []).map((key) => ({ key, preview: keyToPreview(key) })),
		videoKey: el.videoFile ?? "",
		videoName: el.videoFile ? "Existing video" : null,
		audioKey: el.audioFile ?? "",
		audioName: el.audioFile ? "Existing audio" : null,
		embedUrl: el.embedUrl ?? "",
		metadataNote: note,
		uploading: false,
		progress: 0,
	};
}

/** Serialize a draft to the API element-input shape (only type-relevant fields). */
export function serializeElement(d: ContentElementDraft): ContentElementInput {
	const out: ContentElementInput = { contentType: d.contentType };
	if (d.id != null) out.id = d.id;
	if (d.title.trim()) out.title = d.title.trim();
	if (d.thumbnailKey) out.thumbnail = d.thumbnailKey;

	switch (d.contentType) {
		case "text":
			out.bodyHtml = d.bodyHtml;
			break;
		case "image":
			out.images = d.images.map((i) => i.key);
			break;
		case "video":
			if (d.videoKey) out.videoFile = d.videoKey;
			break;
		case "audio":
			if (d.audioKey) out.audioFile = d.audioKey;
			break;
		case "game":
		case "software":
			if (d.embedUrl.trim()) out.embedUrl = d.embedUrl.trim();
			break;
		case "physical":
		case "service":
			out.metadata = { note: d.metadataNote };
			break;
	}
	return out;
}

// ─── Component ───

interface ContentElementListProps {
	value: ContentElementDraft[];
	onChange: (next: ContentElementDraft[]) => void;
}

export default function ContentElementList({ value, onChange }: ContentElementListProps) {
	const patch = (localKey: string, changes: Partial<ContentElementDraft>) => {
		onChange(value.map((el) => (el.localKey === localKey ? { ...el, ...changes } : el)));
	};

	const add = () => onChange([...value, newElement()]);
	const remove = (localKey: string) => onChange(value.filter((el) => el.localKey !== localKey));

	const move = (index: number, dir: -1 | 1) => {
		const target = index + dir;
		if (target < 0 || target >= value.length) return;
		const next = [...value];
		[next[index], next[target]] = [next[target], next[index]];
		onChange(next);
	};

	return (
		<div className="flex flex-col gap-4">
			{value.length === 0 && (
				<p className="text-sm text-base-content/50">
					No content elements yet. A post can be body-only, or add typed content below.
				</p>
			)}

			{value.map((el, index) => (
				<ElementCard
					key={el.localKey}
					element={el}
					index={index}
					total={value.length}
					onPatch={patch}
					onRemove={remove}
					onMove={move}
				/>
			))}

			<button type="button" className="btn btn-outline btn-sm w-fit" onClick={add}>
				<PlusIcon className="w-4 h-4" /> Add content element
			</button>
		</div>
	);
}

interface ElementCardProps {
	element: ContentElementDraft;
	index: number;
	total: number;
	onPatch: (localKey: string, changes: Partial<ContentElementDraft>) => void;
	onRemove: (localKey: string) => void;
	onMove: (index: number, dir: -1 | 1) => void;
}

function ElementCard({ element, index, total, onPatch, onRemove, onMove }: ElementCardProps) {
	const el = element;
	const imageInputRef = useRef<HTMLInputElement>(null);

	const handleThumbnail = async (file: File) => {
		onPatch(el.localKey, { thumbnailPreview: URL.createObjectURL(file) });
		try {
			const { key, url } = await uploadImageFile(file, "thumbnail");
			onPatch(el.localKey, { thumbnailKey: key, thumbnailPreview: url });
		} catch {
			onPatch(el.localKey, {
				thumbnailPreview: el.thumbnailKey ? keyToPreview(el.thumbnailKey) : null,
			});
		}
	};

	const handleAddImages = async (files: FileList) => {
		onPatch(el.localKey, { uploading: true });
		const added: DraftImage[] = [];
		for (const file of Array.from(files)) {
			try {
				const { key, url } = await uploadImageFile(file, "image");
				added.push({ key, preview: url });
			} catch {
				// Skip failed uploads silently; the others still land.
			}
		}
		onPatch(el.localKey, { images: [...el.images, ...added], uploading: false });
	};

	const handleMedia = async (file: File, kind: "video" | "audio") => {
		onPatch(el.localKey, {
			uploading: true,
			progress: 0,
			...(kind === "video" ? { videoName: file.name } : { audioName: file.name }),
		});
		try {
			const key = await uploadMediaFile(file, kind, (p) => onPatch(el.localKey, { progress: p }));
			onPatch(el.localKey, kind === "video" ? { videoKey: key } : { audioKey: key });
		} catch {
			onPatch(el.localKey, kind === "video" ? { videoName: null } : { audioName: null });
		} finally {
			onPatch(el.localKey, { uploading: false });
		}
	};

	return (
		<div className="border border-base-300 rounded-lg p-4 flex flex-col gap-4 bg-base-100">
			<div className="flex items-center gap-2">
				<span className="badge badge-neutral badge-sm">{index + 1}</span>
				<select
					className="select select-bordered select-sm"
					value={el.contentType}
					onChange={(e) => onPatch(el.localKey, { contentType: e.target.value as ContentType })}
				>
					{CONTENT_TYPE_OPTIONS.map((opt) => (
						<option key={opt.value} value={opt.value}>
							{opt.label}
						</option>
					))}
				</select>
				<input
					type="text"
					className="input input-bordered input-sm flex-1"
					value={el.title}
					onChange={(e) => onPatch(el.localKey, { title: e.target.value })}
					placeholder="Element title (optional)"
				/>
				<div className="flex items-center gap-1">
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square"
						disabled={index === 0}
						onClick={() => onMove(index, -1)}
						title="Move up"
					>
						<ArrowUpIcon className="w-4 h-4" />
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square"
						disabled={index === total - 1}
						onClick={() => onMove(index, 1)}
						title="Move down"
					>
						<ArrowDownIcon className="w-4 h-4" />
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square text-error"
						onClick={() => onRemove(el.localKey)}
						title="Remove element"
					>
						<TrashIcon className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Type-specific setup */}
			{el.contentType === "text" && (
				<RichTextEditor
					content={el.bodyHtml}
					onChange={(html) => onPatch(el.localKey, { bodyHtml: html })}
					placeholder="Write this section..."
				/>
			)}

			{el.contentType === "image" && (
				<div className="flex flex-col gap-2">
					{el.images.length > 0 && (
						<div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
							{el.images.map((img, i) => (
								<div key={img.key || i} className="relative">
									<img
										src={img.preview}
										alt=""
										className="w-full h-24 object-cover rounded border border-base-300"
									/>
									<button
										type="button"
										className="btn btn-circle btn-xs btn-error absolute top-1 right-1"
										onClick={() =>
											onPatch(el.localKey, {
												images: el.images.filter((_, idx) => idx !== i),
											})
										}
									>
										<XMarkIcon className="w-3 h-3" />
									</button>
								</div>
							))}
						</div>
					)}
					<input
						ref={imageInputRef}
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(e) => {
							if (e.target.files && e.target.files.length > 0) handleAddImages(e.target.files);
							e.target.value = "";
						}}
					/>
					<button
						type="button"
						className="btn btn-outline btn-sm w-fit"
						onClick={() => imageInputRef.current?.click()}
						disabled={el.uploading}
					>
						{el.uploading ? "Uploading..." : "Add image(s)"}
					</button>
				</div>
			)}

			{el.contentType === "video" && (
				<MediaField
					kind="video"
					fileName={el.videoName}
					hasKey={Boolean(el.videoKey)}
					uploading={el.uploading}
					progress={el.progress}
					onSelect={(file) => handleMedia(file, "video")}
				/>
			)}

			{el.contentType === "audio" && (
				<MediaField
					kind="audio"
					fileName={el.audioName}
					hasKey={Boolean(el.audioKey)}
					uploading={el.uploading}
					progress={el.progress}
					onSelect={(file) => handleMedia(file, "audio")}
				/>
			)}

			{(el.contentType === "game" || el.contentType === "software") && (
				<FormField label="Embed URL">
					<input
						type="url"
						className="input input-bordered w-full"
						value={el.embedUrl}
						onChange={(e) => onPatch(el.localKey, { embedUrl: e.target.value })}
						placeholder="https://example.com/embed"
					/>
					<p className="text-xs text-base-content/50 mt-1">
						URL for an HTML5/WebGL embed. Downloadable builds are managed on the post's Builds page.
					</p>
				</FormField>
			)}

			{(el.contentType === "physical" || el.contentType === "service") && (
				<FormField label="Details">
					<textarea
						className="textarea textarea-bordered w-full"
						value={el.metadataNote}
						onChange={(e) => onPatch(el.localKey, { metadataNote: e.target.value })}
						placeholder={
							el.contentType === "physical"
								? "Fulfillment notes, dimensions, shipping..."
								: "What the service includes, turnaround, terms..."
						}
						rows={3}
					/>
					<p className="text-xs text-base-content/50 mt-1">
						{el.contentType === "physical" ? "Physical goods" : "Services"} are download-only —
						buyers receive access, not a stream.
					</p>
				</FormField>
			)}

			{/* Per-element thumbnail */}
			<FormField label="Thumbnail (optional)">
				<div className="max-w-xs">
					<FileUpload
						accept="image/*"
						maxSize={10 * 1024 * 1024}
						preview={el.thumbnailPreview}
						label="Upload a thumbnail"
						compact
						onFileSelect={handleThumbnail}
						onClear={() => onPatch(el.localKey, { thumbnailKey: "", thumbnailPreview: null })}
					/>
				</div>
			</FormField>
		</div>
	);
}

interface MediaFieldProps {
	kind: "video" | "audio";
	fileName: string | null;
	hasKey: boolean;
	uploading: boolean;
	progress: number;
	onSelect: (file: File) => void;
}

function MediaField({ kind, fileName, hasKey, uploading, progress, onSelect }: MediaFieldProps) {
	const maxSize = kind === "video" ? 2 * 1024 * 1024 * 1024 : 500 * 1024 * 1024;
	return (
		<FormField label={kind === "video" ? "Video File" : "Audio File"}>
			{fileName || hasKey ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
						<span className="text-sm truncate flex-1">{fileName || `Existing ${kind}`}</span>
						{uploading ? (
							<span className="text-xs font-mono">{progress}%</span>
						) : hasKey ? (
							<span className="badge badge-success badge-sm">Uploaded</span>
						) : null}
					</div>
					{uploading && (
						<progress className="progress progress-primary w-full" value={progress} max="100" />
					)}
				</div>
			) : (
				<FileUpload
					accept={`${kind}/*`}
					maxSize={maxSize}
					onFileSelect={onSelect}
					label={`Drop ${kind === "audio" ? "an" : "a"} ${kind} file or click to browse`}
				/>
			)}
		</FormField>
	);
}
