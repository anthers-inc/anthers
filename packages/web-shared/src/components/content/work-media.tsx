// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The media half of authoring a Work — the per-type upload state, the control that renders
 * it, and the type-specific fields that go into a create or edit payload.
 *
 * Two surfaces need this and only one of them needs the rest: the Work's own page at
 * `/studio/works/new`, and the quick create inside `WorkPicker`, which is deliberately a
 * type, a file and a title. Everything else a Work carries — the access table, the rating,
 * the release, the builds — belongs to the page alone, which is what keeps the quick create
 * from growing back into a second editor.
 *
 * 🚨 **Every upload is processed server-side, and there is no choice to offer.** This
 * carried an *Encode on device / Upload & we process* toggle plus a desktop-only native
 * picker that encoded through the bundled ffmpeg sidecar, and both were removed on
 * 2026-08-17 because the on-device implementations did not work. On-device returns as the
 * desktop app's separate pre-process step, which hands the creator an upload pack to upload
 * here like any other file. Don't reintroduce an encode in the browser.
 */

import { type ReactNode, useState } from "react";
import type { UploadableWorkType, Work, WorkInput } from "../../lib/types";
import { uploadMediaFile } from "../../lib/upload";
import { keyToPreview, uploadImageFile } from "../post/mediaUpload";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";

/** The free-text detail a physical good or a service carries, out of `metadata.note`. */
function metaNote(item: Work | null | undefined): string {
	const note = item?.metadata?.note;
	return typeof note === "string" ? note : "";
}

export interface WorkMedia {
	/** This type's own media control, ready to drop into a form. */
	slot: ReactNode;
	/**
	 * Whether the type's required media is present. Video, audio and image cannot be
	 * created without a file; the other four have nothing to wait for.
	 */
	ready: boolean;
	/** True while a file is going up, so a form can refuse to save mid-upload. */
	uploading: boolean;
	/** The image type's uploaded key. A single image is its own thumbnail unless one is set. */
	imageKey: string;
	/**
	 * The type-specific fields to merge into a create or edit payload.
	 *
	 * ⚠️ `type` is excluded deliberately. `WorkInput.type` is the full `ContentType`, so
	 * spreading a plain `Partial<WorkInput>` over a narrowed `UploadableWorkType` widens it
	 * straight back and the create payload stops typechecking. The caller owns the type;
	 * this owns what the type implies.
	 */
	fields: () => Omit<Partial<WorkInput>, "type">;
}

/**
 * Per-type media state for one Work being authored.
 *
 * The state is initialized from `editing` once and then survives a type change, which is
 * what lets somebody switch from Video to Audio and back without losing the file they
 * already uploaded. `type` is immutable once the Work exists, so that only ever applies
 * while creating.
 */
export function useWorkMedia(type: UploadableWorkType, editing: Work | null): WorkMedia {
	const [videoKey, setVideoKey] = useState(
		editing?.type === "video" ? (editing.sourceKey ?? "") : "",
	);
	const [videoName, setVideoName] = useState<string | null>(
		editing?.type === "video" && editing.sourceKey ? "Existing video" : null,
	);

	const [audioKey, setAudioKey] = useState(
		editing?.type === "audio" ? (editing.sourceKey ?? "") : "",
	);
	const [audioName, setAudioName] = useState<string | null>(
		editing?.type === "audio" && editing.sourceKey ? "Existing audio" : null,
	);

	const [imageKey, setImageKey] = useState(
		editing?.type === "image" ? (editing.sourceKey ?? "") : "",
	);
	const [imagePreview, setImagePreview] = useState<string | null>(
		editing?.type === "image" && editing.sourceKey ? keyToPreview(editing.sourceKey) : null,
	);

	const [embedUrl, setEmbedUrl] = useState(editing?.embedUrl ?? "");
	const [detailsNote, setDetailsNote] = useState(metaNote(editing));

	const [uploading, setUploading] = useState(false);
	const [progress, setProgress] = useState(0);

	const handleVideo = async (file: File) => {
		setUploading(true);
		setProgress(0);
		setVideoName(file.name);
		try {
			setVideoKey(await uploadMediaFile(file, "video", setProgress));
		} catch {
			setVideoName(null);
		} finally {
			setUploading(false);
		}
	};

	const handleAudio = async (file: File) => {
		setUploading(true);
		setProgress(0);
		setAudioName(file.name);
		try {
			setAudioKey(await uploadMediaFile(file, "audio", setProgress));
		} catch {
			setAudioName(null);
		} finally {
			setUploading(false);
		}
	};

	const handleImage = async (file: File) => {
		setUploading(true);
		setImagePreview(URL.createObjectURL(file));
		try {
			const { url } = await uploadImageFile(file, "image");
			setImageKey(url);
			setImagePreview(url);
		} catch {
			setImagePreview(imageKey ? keyToPreview(imageKey) : null);
		} finally {
			setUploading(false);
		}
	};

	const ready =
		(type === "video" && !!videoKey) ||
		(type === "audio" && !!audioKey) ||
		(type === "image" && !!imageKey) ||
		type === "game" ||
		type === "software" ||
		type === "physical" ||
		type === "service";

	const fields = (): Omit<Partial<WorkInput>, "type"> => {
		switch (type) {
			case "video":
				// No `durationSeconds`: the browser never opens the file, so it has no duration
				// to send. `transcode-video` probes the source with ffprobe and writes it.
				return { sourceKey: videoKey };
			case "audio":
				return { sourceKey: audioKey };
			case "image":
				return { sourceKey: imageKey };
			case "game":
			case "software":
				return { embedUrl: embedUrl.trim() };
			default:
				return { metadata: { note: detailsNote.trim() } };
		}
	};

	let slot: ReactNode = null;
	if (type === "video" || type === "audio") {
		slot = (
			<MediaSlot
				kind={type}
				fileName={type === "video" ? videoName : audioName}
				hasKey={type === "video" ? !!videoKey : !!audioKey}
				uploading={uploading}
				progress={progress}
				onSelect={type === "video" ? handleVideo : handleAudio}
			/>
		);
	} else if (type === "image") {
		slot = (
			<FormField label="Image">
				<FileUpload
					accept="image/*"
					maxSize={20 * 1024 * 1024}
					preview={imagePreview}
					label={uploading ? "Uploading…" : "Drop an image or click to browse"}
					onFileSelect={handleImage}
					onClear={() => {
						setImageKey("");
						setImagePreview(null);
					}}
				/>
			</FormField>
		);
	} else if (type === "game" || type === "software") {
		slot = (
			<FormField
				label="Embed URL (optional)"
				hint="For an HTML5 or WebGL build that runs in the browser. Downloadable builds are added on the Work's own page."
			>
				<input
					type="url"
					className="input input-bordered w-full"
					value={embedUrl}
					onChange={(e) => setEmbedUrl(e.target.value)}
					placeholder="https://example.com/embed"
				/>
			</FormField>
		);
	} else {
		slot = (
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
		);
	}

	return { slot, ready, uploading, imageKey, fields };
}

// ─── Media slot (video/audio) ───

interface MediaSlotProps {
	kind: "video" | "audio";
	fileName: string | null;
	hasKey: boolean;
	uploading: boolean;
	progress: number;
	onSelect: (file: File) => void;
}

function MediaSlot({ kind, fileName, hasKey, uploading, progress, onSelect }: MediaSlotProps) {
	const maxSize = kind === "video" ? 2 * 1024 * 1024 * 1024 : 500 * 1024 * 1024;
	return (
		<FormField label={kind === "video" ? "Video file" : "Audio file"}>
			{fileName || hasKey ? (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-3 p-3 bg-base-200 rounded-lg">
						<span className="text-sm truncate flex-1">{fileName || `Existing ${kind}`}</span>
						{uploading ? (
							<span className="text-xs font-mono">{progress}%</span>
						) : (
							<span className="badge badge-success badge-sm">Uploaded</span>
						)}
					</div>
					{uploading && (
						<progress className="progress progress-primary w-full" value={progress} max="100" />
					)}
				</div>
			) : (
				<div className="flex flex-col gap-3">
					<FileUpload
						accept={`${kind}/*`}
						maxSize={maxSize}
						onFileSelect={onSelect}
						label={`Drop ${kind === "audio" ? "an" : "a"} ${kind} file or click to browse`}
					/>
					{/*
					 * Says what the old encode-mode toggle used to answer by existing: the creator
					 * is not waiting on their own machine. Worth keeping now that there is no
					 * choice to make — processing still happens, just not here.
					 */}
					<p className="text-xs text-base-content/50">
						Leave anytime — we process it on our servers once it's uploaded.
					</p>
				</div>
			)}
		</FormField>
	);
}
