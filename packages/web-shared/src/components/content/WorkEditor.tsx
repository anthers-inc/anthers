// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Create / edit a creator-owned library content item. This is the single authoring
 * surface for the content library (used by the Library page and the post content
 * picker's "Upload new"): a modal that picks a `UploadableWorkType`, runs the type's
 * upload flow (client-transcode for video, raw upload for audio, image upload, embed
 * URL for game/software, details for physical/service), then POSTs the item. Media
 * items with a source are processed once, server-side, on create. Game/software items
 * can then manage downloadable builds (assets), which persist immediately.
 */
import { ArrowUpTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { client, isDesktop } from "../../lib/rpc";
import type { Asset, UploadableWorkType, Work, WorkInput } from "../../lib/types";
import {
	canTranscodeInBrowser,
	type UploadedVariant,
	uploadClientTranscodedVideo,
	uploadMediaFile,
	uploadNativeTranscodedVideo,
} from "../../lib/upload";
import { keyToPreview, uploadImageFile } from "../post/mediaUpload";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";
import LoadingSpinner from "../ui/LoadingSpinner";
import { isBuildType, LIBRARY_TYPE_OPTIONS } from "./works";

type EncodeMode = "device" | "server";

interface ContentItemEditorProps {
	/** Present → edit an existing item; absent → create a new one. */
	item?: Work | null;
	/** Called with the saved item after a successful create/save (closes the editor). */
	onSaved: (item: Work) => void;
	onClose: () => void;
}

function metaNote(item: Work | null | undefined): string {
	const note = item?.metadata?.note;
	return typeof note === "string" ? note : "";
}

/** "2m 5s", "45s" — compact remaining-time label. */
function formatEta(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function WorkEditor({ item, onSaved, onClose }: ContentItemEditorProps) {
	const editing = item ?? null;

	// Once created (or when editing), the item has an id — the type is then fixed and
	// downloadable builds become manageable.
	const [current, setCurrent] = useState<Work | null>(editing);
	const [type, setType] = useState<UploadableWorkType>(
		(editing?.type as UploadableWorkType) ?? "video",
	);
	const hasId = current != null;

	const [title, setTitle] = useState(editing?.title ?? "");
	const [description, setDescription] = useState(editing?.description ?? "");
	const [thumbnailUrl, setThumbnailUrl] = useState(editing?.thumbnail ?? "");
	const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(
		editing?.thumbnail ? keyToPreview(editing.thumbnail) : null,
	);

	// Video
	const [videoKey, setVideoKey] = useState(
		editing?.type === "video" ? (editing.sourceKey ?? "") : "",
	);
	const [videoName, setVideoName] = useState<string | null>(
		editing?.type === "video" && editing.sourceKey ? "Existing video" : null,
	);
	const [videoVariants, setVideoVariants] = useState<UploadedVariant[]>([]);
	const [videoDuration, setVideoDuration] = useState<number | null>(
		editing?.durationSeconds ?? null,
	);
	const [encodeMode, setEncodeMode] = useState<EncodeMode>("device");

	// Audio
	const [audioKey, setAudioKey] = useState(
		editing?.type === "audio" ? (editing.sourceKey ?? "") : "",
	);
	const [audioName, setAudioName] = useState<string | null>(
		editing?.type === "audio" && editing.sourceKey ? "Existing audio" : null,
	);

	// Image
	const [imageUrl, setImageUrl] = useState(
		editing?.type === "image" ? (editing.sourceKey ?? "") : "",
	);
	const [imagePreview, setImagePreview] = useState<string | null>(
		editing?.type === "image" && editing.sourceKey ? keyToPreview(editing.sourceKey) : null,
	);

	// Game / software (embed) + physical / service (details)
	const [embedUrl, setEmbedUrl] = useState(editing?.embedUrl ?? "");
	const [detailsNote, setDetailsNote] = useState(metaNote(editing));

	// Upload progress
	const [uploading, setUploading] = useState(false);
	const [progress, setProgress] = useState(0);
	const [stage, setStage] = useState("");
	const [eta, setEta] = useState<number | null>(null);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// ── Uploads ──

	const handleThumbnail = async (file: File) => {
		setThumbnailPreview(URL.createObjectURL(file));
		try {
			const { url } = await uploadImageFile(file, "thumbnail");
			setThumbnailUrl(url);
			setThumbnailPreview(url);
		} catch {
			setThumbnailPreview(thumbnailUrl ? keyToPreview(thumbnailUrl) : null);
		}
	};

	const handleImage = async (file: File) => {
		setUploading(true);
		setImagePreview(URL.createObjectURL(file));
		try {
			const { url } = await uploadImageFile(file, "image");
			setImageUrl(url);
			setImagePreview(url);
		} catch {
			setImagePreview(imageUrl ? keyToPreview(imageUrl) : null);
		} finally {
			setUploading(false);
		}
	};

	/**
	 * Desktop: pick a video by real path and encode it with the bundled native ffmpeg.
	 *
	 * A separate entry point from `handleVideo` because the native picker yields a
	 * PATH, not a `File` — which is the point: ffmpeg reads the source off disk, so the
	 * encode is neither capped at 300 MB nor holding the file in memory, and it uses
	 * every core instead of one per rung.
	 */
	const handleVideoNative = async () => {
		const { pickVideoFile, basename } = await import("../../lib/native-transcode");
		const path = await pickVideoFile();
		if (!path) return;

		setUploading(true);
		setProgress(0);
		setStage("");
		setEta(null);
		setVideoVariants([]);
		setVideoName(basename(path));
		try {
			const res = await uploadNativeTranscodedVideo(path, (p) => {
				setProgress(p.percent);
				setStage(p.stage);
				setEta(p.etaSeconds);
			});
			setVideoKey(res.sourceKey);
			setVideoVariants(res.variants);
			setVideoDuration(res.durationSeconds);
			if (!thumbnailUrl && res.thumbnailPreview) {
				setThumbnailUrl(res.thumbnailPreview);
				setThumbnailPreview(res.thumbnailPreview);
			}
		} catch (err) {
			// No silent fallback here: unlike the browser encoder there is no smaller path
			// to retry on, and swallowing an ffmpeg failure would leave the creator staring
			// at a reset form with no idea why.
			setVideoName(null);
			setStage(err instanceof Error ? err.message : "Encoding failed.");
		} finally {
			setUploading(false);
			setEta(null);
		}
	};

	const handleVideo = async (file: File) => {
		setUploading(true);
		setProgress(0);
		setStage("");
		setEta(null);
		setVideoVariants([]);
		setVideoName(file.name);
		try {
			// Encode on device → upload the H.264 ladder (server just remuxes to HLS). Falls
			// back to a raw source upload + server transcode when the browser can't encode.
			if (encodeMode === "device" && canTranscodeInBrowser(file)) {
				try {
					const res = await uploadClientTranscodedVideo(file, (p) => {
						setProgress(p.percent);
						setStage(p.stage);
						setEta(p.etaSeconds);
					});
					setVideoKey(res.sourceKey);
					setVideoVariants(res.variants);
					setVideoDuration(res.durationSeconds);
					// Adopt the auto-poster only if the creator hasn't set their own thumbnail.
					if (!thumbnailUrl && res.thumbnailPreview) {
						setThumbnailUrl(res.thumbnailPreview);
						setThumbnailPreview(res.thumbnailPreview);
					}
					return;
				} catch {
					setProgress(0);
					setStage("Uploading (server will process)");
					setVideoVariants([]);
					const key = await uploadMediaFile(file, "video", setProgress);
					setVideoKey(key);
					return;
				}
			}
			const key = await uploadMediaFile(file, "video", setProgress);
			setVideoKey(key);
		} catch {
			setVideoName(null);
		} finally {
			setUploading(false);
			setStage("");
			setEta(null);
		}
	};

	const handleAudio = async (file: File) => {
		setUploading(true);
		setProgress(0);
		setAudioName(file.name);
		try {
			const key = await uploadMediaFile(file, "audio", setProgress);
			setAudioKey(key);
		} catch {
			setAudioName(null);
		} finally {
			setUploading(false);
		}
	};

	// ── Save ──

	/** Media required before an item of this type can be created. */
	const hasRequiredMedia =
		(type === "video" && !!videoKey) ||
		(type === "audio" && !!audioKey) ||
		(type === "image" && !!imageUrl) ||
		type === "game" ||
		type === "software" ||
		type === "physical" ||
		type === "service";

	const handleCreate = async () => {
		setSaving(true);
		setError(null);
		// `type` is required on create and immutable afterwards, so it is narrowed here
		// rather than left optional on the shared input type.
		const input: WorkInput & { type: UploadableWorkType } = { type };
		if (title.trim()) input.title = title.trim();
		if (description.trim()) input.description = description.trim();
		if (thumbnailUrl) input.thumbnail = thumbnailUrl;
		switch (type) {
			case "video":
				input.sourceKey = videoKey;
				// Rounded because the API takes `z.number().int()`, and BOTH encoders produce
				// a float — ffprobe reports 19.933333, and the browser's `video.duration` is
				// just as fractional. Sending it raw 400s for any video that doesn't happen
				// to be a whole number of seconds, i.e. nearly all of them.
				if (videoDuration) input.durationSeconds = Math.round(videoDuration);
				if (videoVariants.length > 0) input.metadata = { clientVariants: videoVariants };
				break;
			case "audio":
				input.sourceKey = audioKey;
				break;
			case "image":
				input.sourceKey = imageUrl;
				// A single image is its own thumbnail unless one was set explicitly.
				if (!thumbnailUrl) input.thumbnail = imageUrl;
				break;
			case "game":
			case "software":
				if (embedUrl.trim()) input.embedUrl = embedUrl.trim();
				break;
			case "physical":
			case "service":
				if (detailsNote.trim()) input.metadata = { note: detailsNote.trim() };
				break;
		}
		try {
			const res = await client.api.content.works.$post({ json: input });
			if (!res.ok) {
				setError("Failed to create content.");
				return;
			}
			const { work: created } = await res.json();
			setCurrent(created as Work);
			// Games/software gain a builds section; everything else is done on create.
			if (!isBuildType(type)) onSaved(created as Work);
		} catch {
			setError("Failed to create content.");
		} finally {
			setSaving(false);
		}
	};

	const handleSaveEdit = async () => {
		if (!current) return;
		setSaving(true);
		setError(null);
		const json: {
			title?: string;
			description?: string;
			thumbnail?: string;
			embedUrl?: string;
			sourceKey?: string;
			metadata?: Record<string, unknown>;
		} = {
			title: title.trim(),
			description: description.trim(),
			thumbnail: thumbnailUrl,
		};
		if (type === "game" || type === "software") json.embedUrl = embedUrl.trim();
		if (type === "physical" || type === "service") json.metadata = { note: detailsNote.trim() };
		if (type === "image" && imageUrl) json.sourceKey = imageUrl;
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(current.id) },
				json,
			});
			if (!res.ok) {
				setError("Failed to save content.");
				return;
			}
			const { work: updated } = await res.json();
			onSaved(updated as Work);
		} catch {
			setError("Failed to save content.");
		} finally {
			setSaving(false);
		}
	};

	// ── Builds (game/software downloadable assets) ──

	const assets = current?.assets ?? [];
	const [buildFile, setBuildFile] = useState<File | null>(null);
	const [buildPlatform, setBuildPlatform] = useState("windows");
	const [buildVersion, setBuildVersion] = useState("");
	const [buildPrimary, setBuildPrimary] = useState(false);
	const [buildUploading, setBuildUploading] = useState(false);

	const handleAddBuild = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!buildFile || !current) return;
		setBuildUploading(true);
		setError(null);
		try {
			const key = await uploadMediaFile(buildFile, "asset");
			const res = await client.api.content.works[":id"].assets.$post({
				param: { id: String(current.id) },
				json: {
					file: key,
					filename: buildFile.name,
					fileSize: buildFile.size,
					mimeType: buildFile.type || "application/octet-stream",
					platform: buildPlatform,
					version: buildVersion,
					isPrimary: buildPrimary,
				},
			});
			if (!res.ok) throw new Error("Create failed");
			const { asset } = await res.json();
			setCurrent((prev) => (prev ? { ...prev, assets: [asset, ...prev.assets] } : prev));
			setBuildFile(null);
			setBuildVersion("");
			setBuildPrimary(false);
		} catch {
			setError("Failed to upload build.");
		} finally {
			setBuildUploading(false);
		}
	};

	const handleDeleteBuild = async (assetId: number) => {
		if (!current) return;
		try {
			const res = await client.api.content.works[":id"].assets[":assetId"].$delete({
				param: { id: String(current.id), assetId: String(assetId) },
			});
			if (!res.ok) throw new Error("Delete failed");
			setCurrent((prev) =>
				prev ? { ...prev, assets: prev.assets.filter((a) => a.id !== assetId) } : prev,
			);
		} catch {
			setError("Failed to delete build.");
		}
	};

	const showBuilds = hasId && isBuildType(type);

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box max-w-2xl max-h-[90vh] flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">{editing ? "Edit content" : "Upload content"}</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				<div className="flex flex-col gap-4 overflow-y-auto pr-1">
					{/* Type — fixed once the item exists. */}
					<FormField label="Type">
						{hasId ? (
							<div className="badge badge-neutral capitalize">{type}</div>
						) : (
							<select
								className="select select-bordered w-full"
								value={type}
								onChange={(e) => setType(e.target.value as UploadableWorkType)}
							>
								{LIBRARY_TYPE_OPTIONS.map((opt) => (
									<option key={opt.value} value={opt.value}>
										{opt.label}
									</option>
								))}
							</select>
						)}
					</FormField>

					{/* Type-specific media */}
					{type === "video" && (
						<MediaSlot
							kind="video"
							fileName={videoName}
							hasKey={!!videoKey}
							uploading={uploading}
							progress={progress}
							stage={stage}
							etaSeconds={eta}
							encodeMode={encodeMode}
							onModeChange={setEncodeMode}
							onSelect={handleVideo}
							onPickNative={isDesktop() ? handleVideoNative : undefined}
						/>
					)}

					{type === "audio" && (
						<MediaSlot
							kind="audio"
							fileName={audioName}
							hasKey={!!audioKey}
							uploading={uploading}
							progress={progress}
							onSelect={handleAudio}
						/>
					)}

					{type === "image" && (
						<FormField label="Image">
							<FileUpload
								accept="image/*"
								maxSize={20 * 1024 * 1024}
								preview={imagePreview}
								label={uploading ? "Uploading…" : "Drop an image or click to browse"}
								onFileSelect={handleImage}
								onClear={() => {
									setImageUrl("");
									setImagePreview(null);
								}}
							/>
						</FormField>
					)}

					{(type === "game" || type === "software") && (
						<FormField label="Embed URL (optional)">
							<input
								type="url"
								className="input input-bordered w-full"
								value={embedUrl}
								onChange={(e) => setEmbedUrl(e.target.value)}
								placeholder="https://example.com/embed"
							/>
							<p className="text-xs text-base-content/50 mt-1">
								For an HTML5/WebGL embed. Downloadable builds are managed below.
							</p>
						</FormField>
					)}

					{(type === "physical" || type === "service") && (
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
					)}

					{/* Common fields */}
					<FormField label="Title">
						<input
							type="text"
							className="input input-bordered w-full"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Content title"
						/>
					</FormField>

					<FormField label="Description (optional)">
						<textarea
							className="textarea textarea-bordered w-full"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={2}
							placeholder="Describe this content…"
						/>
					</FormField>

					<FormField label="Thumbnail (optional)">
						<div className="max-w-xs">
							<FileUpload
								accept="image/*"
								maxSize={10 * 1024 * 1024}
								preview={thumbnailPreview}
								label="Upload a thumbnail"
								compact
								onFileSelect={handleThumbnail}
								onClear={() => {
									setThumbnailUrl("");
									setThumbnailPreview(null);
								}}
							/>
						</div>
					</FormField>

					{/* Downloadable builds (games/software) */}
					{(type === "game" || type === "software") && !hasId && (
						<p className="text-xs text-base-content/50">
							Create the item first, then add downloadable builds.
						</p>
					)}

					{showBuilds && (
						<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
							<h3 className="font-semibold text-sm">Downloadable builds</h3>

							{assets.length > 0 && (
								<div className="overflow-x-auto">
									<table className="table table-sm">
										<thead>
											<tr>
												<th>Filename</th>
												<th>Platform</th>
												<th>Version</th>
												<th>Size</th>
												<th />
											</tr>
										</thead>
										<tbody>
											{assets.map((asset) => (
												<tr key={asset.id}>
													<td className="font-mono text-xs">
														{asset.filename}
														{asset.isPrimary && (
															<span className="badge badge-primary badge-xs ml-2">Primary</span>
														)}
													</td>
													<td>
														<span className="badge badge-outline badge-sm capitalize">
															{asset.platform}
														</span>
													</td>
													<td>{asset.version || "—"}</td>
													<td className="text-xs text-base-content/60">
														{formatFileSize(asset.fileSize ?? 0)}
													</td>
													<td>
														<button
															type="button"
															className="btn btn-ghost btn-xs text-error"
															onClick={() => handleDeleteBuild(asset.id)}
														>
															<TrashIcon className="w-4 h-4" />
														</button>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}

							<form onSubmit={handleAddBuild} className="flex flex-col gap-2">
								<div className="flex flex-col sm:flex-row gap-2 sm:items-end">
									<div className="flex-1">
										<FormField label="File">
											<input
												type="file"
												className="file-input file-input-bordered file-input-sm w-full"
												onChange={(e) => setBuildFile(e.target.files?.[0] || null)}
											/>
										</FormField>
									</div>
									<FormField label="Platform">
										<select
											className="select select-bordered select-sm"
											value={buildPlatform}
											onChange={(e) => setBuildPlatform(e.target.value)}
										>
											<option value="windows">Windows</option>
											<option value="mac">macOS</option>
											<option value="linux">Linux</option>
											<option value="web">Web</option>
											<option value="android">Android</option>
											<option value="ios">iOS</option>
											<option value="other">Other</option>
										</select>
									</FormField>
									<FormField label="Version">
										<input
											type="text"
											className="input input-bordered input-sm w-24"
											value={buildVersion}
											onChange={(e) => setBuildVersion(e.target.value)}
											placeholder="1.0.0"
										/>
									</FormField>
									<button
										type="submit"
										className="btn btn-primary btn-sm"
										disabled={buildUploading || !buildFile}
									>
										{buildUploading ? (
											<LoadingSpinner size="sm" />
										) : (
											<ArrowUpTrayIcon className="w-4 h-4" />
										)}
										Add
									</button>
								</div>
								<label className="label cursor-pointer justify-start gap-2 w-fit">
									<input
										type="checkbox"
										className="checkbox checkbox-sm"
										checked={buildPrimary}
										onChange={(e) => setBuildPrimary(e.target.checked)}
									/>
									<span className="label-text text-sm">Primary build</span>
								</label>
							</form>
						</div>
					)}
				</div>

				<div className="modal-action mt-0">
					<button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
						{hasId ? "Done" : "Cancel"}
					</button>
					{hasId ? (
						<button
							type="button"
							className="btn btn-primary"
							onClick={handleSaveEdit}
							disabled={saving || uploading}
						>
							{saving ? "Saving…" : "Save & close"}
						</button>
					) : (
						<button
							type="button"
							className="btn btn-primary"
							onClick={handleCreate}
							disabled={saving || uploading || !hasRequiredMedia}
							title={hasRequiredMedia ? undefined : "Add the file for this content type first"}
						>
							{saving ? "Creating…" : "Create content"}
						</button>
					)}
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}

// ─── Media slot (video/audio) ───

interface MediaSlotProps {
	kind: "video" | "audio";
	fileName: string | null;
	hasKey: boolean;
	uploading: boolean;
	progress: number;
	stage?: string;
	etaSeconds?: number | null;
	encodeMode?: EncodeMode;
	onModeChange?: (mode: EncodeMode) => void;
	onSelect: (file: File) => void;
	/**
	 * Desktop only. When present, the drop zone is replaced by the native picker,
	 * because a browser `File` has no path and the native encoder needs one.
	 */
	onPickNative?: () => void;
}

function MediaSlot({
	kind,
	fileName,
	hasKey,
	uploading,
	progress,
	stage,
	etaSeconds,
	encodeMode,
	onModeChange,
	onSelect,
	onPickNative,
}: MediaSlotProps) {
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
						<>
							{stage && (
								<div className="flex items-center justify-between text-xs text-base-content/60">
									<span>{stage}</span>
									{etaSeconds != null && etaSeconds > 0 && (
										<span>~{formatEta(etaSeconds)} left</span>
									)}
								</div>
							)}
							<progress className="progress progress-primary w-full" value={progress} max="100" />
						</>
					)}
				</div>
			) : (
				<div className="flex flex-col gap-3">
					{kind === "video" && encodeMode && onModeChange && !onPickNative && (
						<EncodeModeChooser encodeMode={encodeMode} onModeChange={onModeChange} />
					)}
					{onPickNative ? (
						<div className="flex flex-col gap-2">
							<button type="button" className="btn btn-primary btn-sm w-fit" onClick={onPickNative}>
								Choose a video…
							</button>
							<p className="text-xs text-base-content/50">
								Encoded on this computer with all your cores — no file-size limit, and you can leave
								it running.
							</p>
						</div>
					) : (
						<FileUpload
							accept={`${kind}/*`}
							maxSize={maxSize}
							onFileSelect={onSelect}
							label={`Drop ${kind === "audio" ? "an" : "a"} ${kind} file or click to browse`}
						/>
					)}
				</div>
			)}
		</FormField>
	);
}

function EncodeModeChooser({
	encodeMode,
	onModeChange,
}: {
	encodeMode: EncodeMode;
	onModeChange: (mode: EncodeMode) => void;
}) {
	const opts: { mode: EncodeMode; label: string; hint: string }[] = [
		{
			mode: "device",
			label: "Encode on device",
			hint: "Faster to publish · uses your CPU · stay until it finishes",
		},
		{
			mode: "server",
			label: "Upload & we process",
			hint: "Leave anytime · we encode on our servers",
		},
	];
	return (
		<div className="flex flex-col gap-2">
			<div className="join">
				{opts.map((o) => (
					<button
						key={o.mode}
						type="button"
						className={`btn btn-sm join-item ${encodeMode === o.mode ? "btn-primary" : "btn-outline"}`}
						aria-pressed={encodeMode === o.mode}
						onClick={() => onModeChange(o.mode)}
					>
						{o.label}
					</button>
				))}
			</div>
			<p className="text-xs text-base-content/50">
				{opts.find((o) => o.mode === encodeMode)?.hint}
			</p>
		</div>
	);
}
