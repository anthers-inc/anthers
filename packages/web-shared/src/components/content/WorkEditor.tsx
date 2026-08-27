// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Create / edit a **Work** in the creator's Catalog. The single authoring surface for it
 * (used by the Catalog page and the post content picker's "Upload new"): a modal that
 * picks a `UploadableWorkType`, runs the type's upload flow (raw source upload for video
 * and audio, image upload, embed URL for game/software, details for physical/service),
 * then POSTs the Work. Media with a source is processed once, server-side, on create.
 * Games/software can then manage downloadable builds (assets), which persist immediately.
 *
 * **Every upload is processed server-side, and there is no choice to offer.** This editor
 * carried an *Encode on device / Upload & we process* toggle, plus a desktop-only native
 * picker that encoded through the bundled ffmpeg sidecar. Both were removed on 2026-08-17
 * because the on-device implementations did not work; on-device returns as the desktop
 * app's separate pre-process step, which hands the creator an upload pack to upload here
 * like any other file. Don't reintroduce an encode inside this dialog.
 *
 * Beyond the media it also carries everything that decides what a Work *is* to a reader —
 * its Created date, its delivery switches, its access table and its release. Those had no
 * surface at all until 2026-08-13: a Work is born `private` with an access table that
 * admits nobody, so a Catalog built through this editor used to be invisible by
 * construction and there was no control anywhere to change that.
 *
 * 🚨 **Release is edit-only.** `POST /works` refuses `visibility: "released"` outright
 * (`code: "release_on_create"`) — release is a separate deliberate act, which is the whole
 * point of separating the Catalog from posting.
 */

import {
	CONTENT_NOTES,
	type ContentNote,
	MATURITY_CHOICES,
	type MaturityRating,
	normalizeContentNotes,
} from "@anthers/shared/content-rating";
import { ArrowUpTrayIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type {
	AuthoredPrecision,
	CreatorGate,
	UploadableWorkType,
	Work,
	WorkInput,
} from "../../lib/types";
import { uploadMediaFile } from "../../lib/upload";
import AccessTables, {
	buildSeedRows,
	type SeedRowDraft,
	serializeSeedRows,
} from "../post/AccessTables";
import { keyToPreview, uploadImageFile } from "../post/mediaUpload";
import FileUpload from "../ui/FileUpload";
import FormField from "../ui/FormField";
import LoadingSpinner from "../ui/LoadingSpinner";
import RatingAppeal from "./RatingAppeal";
import { authoredToIso, isoToAuthoredValue } from "./work-state";
import { isBuildType, LIBRARY_TYPE_OPTIONS } from "./works";

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
	const [lyrics, setLyrics] = useState(editing?.lyrics ?? "");
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

	// Created date — the creator's claim about when the work was MADE, distinct from the
	// upload date (`createdAt`, creator-facing only) and the release date (ours).
	const [authoredPrecision, setAuthoredPrecision] = useState<AuthoredPrecision | null>(
		editing?.authoredAt ? (editing.authoredPrecision ?? "day") : null,
	);
	const [authoredValue, setAuthoredValue] = useState(() =>
		editing?.authoredAt
			? isoToAuthoredValue(editing.authoredAt, editing.authoredPrecision ?? "day")
			: "",
	);

	// Delivery. The server's create defaults, mirrored — and a Work must keep at least one
	// of them on, which the server enforces against the state the edit RESULTS IN.
	const [streamEnabled, setStreamEnabled] = useState(editing?.streamEnabled ?? true);
	const [downloadEnabled, setDownloadEnabled] = useState(editing?.downloadEnabled ?? false);

	// The content rating. Held as `null` until answered rather than pre-selected as General:
	// a default here would be the editor answering on the creator's behalf, which is the one
	// thing `unrated` exists in the schema to prevent. The release checkbox below refuses to
	// be ticked while it is null, so the question is asked at the moment it matters.
	const [maturity, setMaturity] = useState<Exclude<MaturityRating, "unrated"> | null>(
		editing?.maturity === "general" || editing?.maturity === "mature" ? editing.maturity : null,
	);
	const [contentNotes, setContentNotes] = useState<ContentNote[]>(() =>
		normalizeContentNotes(editing?.maturityNotes ?? []),
	);
	// An operator's correction. The creator may make it more cautious at any time and may
	// not make it less, so the control stays live and the appeal is what the copy points at.
	const maturityLocked = editing?.maturityLocked ?? false;
	const toggleNote = (note: ContentNote) =>
		setContentNotes((prev) =>
			normalizeContentNotes(prev.includes(note) ? prev.filter((n) => n !== note) : [...prev, note]),
		);

	// Access. The creator's Badge ladder is fetched below because rungs live on the creator,
	// not on the Work — `buildSeedRows` merges the Work's stored rows onto whatever rungs
	// exist, so the rows are the only state worth holding.
	const [seedRows, setSeedRows] = useState<SeedRowDraft[]>(() =>
		// A NEW Work is proposed as Public Access — baseline allowed at $0 — rather than
		// inheriting the server's "free but fully locked" default. That default is right for
		// the API (a Work created by any client should reveal nothing until asked) and wrong
		// for a person: it publishes something nobody can open, silently. Here the choice is
		// on screen and can be unchecked, so the locked state stays reachable but never
		// accidental.
		editing
			? buildSeedRows([], editing.seedAccess)
			: [{ threshold: 0, label: "Everyone", allow: true, price: "0" }],
	);

	// Upload progress
	const [uploading, setUploading] = useState(false);
	const [progress, setProgress] = useState(0);
	const [stage, setStage] = useState("");
	const [eta, setEta] = useState<number | null>(null);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Release is only reachable once the Work exists: `POST /works` refuses
	// `visibility: "released"` outright with `code: "release_on_create"`, because release is
	// a separate deliberate act and that is the whole point of separating Catalog from post.
	const [visibility, setVisibility] = useState<"private" | "released">(
		editing?.visibility === "released" ? "released" : "private",
	);

	// The creator's own Badge rungs. Best-effort: without them the table still renders its
	// baseline row, which is the row that decides Public Access and the only one most
	// creators will ever touch.
	useEffect(() => {
		let live = true;
		client.api.subscriptions.gates
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as { gates: CreatorGate[] };
				if (!live) return;
				const seedGates = (data.gates ?? []).filter((g) => g.gateType === "seed");
				// Rebuild THROUGH the current rows so a rung arriving after the creator has
				// already ticked something doesn't discard the tick.
				setSeedRows((prev) => buildSeedRows(seedGates, serializeSeedRows(prev)));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

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

	const handleVideo = async (file: File) => {
		setUploading(true);
		setProgress(0);
		setStage("");
		setEta(null);
		setVideoName(file.name);
		try {
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

	/**
	 * The server's own words, when it has any.
	 *
	 * Every failure here is a decision the creator can act on — media still encoding, no
	 * delivery switch on, a date without its precision — and the generic string this used to
	 * show turned all of them into "something went wrong", which is the one thing none of
	 * them are.
	 */
	const failed = async (res: Response, fallback: string) => {
		try {
			const body = (await res.json()) as { error?: string };
			setError(body?.error || fallback);
		} catch {
			setError(fallback);
		}
	};

	const handleCreate = async () => {
		setSaving(true);
		setError(null);
		// `type` is required on create and immutable afterwards, so it is narrowed here
		// rather than left optional on the shared input type.
		const input: WorkInput & { type: UploadableWorkType } = { type };
		if (title.trim()) input.title = title.trim();
		if (description.trim()) input.description = description.trim();
		if (type === "audio" && lyrics.trim()) input.lyrics = lyrics;
		if (thumbnailUrl) input.thumbnail = thumbnailUrl;
		input.streamEnabled = streamEnabled;
		input.downloadEnabled = downloadEnabled;
		input.seedAccess = serializeSeedRows(seedRows);
		// Omitted rather than sent as a default when unanswered, so the Work is created
		// `unrated` and the question is still visibly open on the next save.
		if (maturity) {
			input.maturity = maturity;
			input.maturityNotes = contentNotes;
		}
		const authoredAt = authoredToIso(authoredPrecision, authoredValue);
		if (authoredAt && authoredPrecision) {
			input.authoredAt = authoredAt;
			input.authoredPrecision = authoredPrecision;
		}
		switch (type) {
			case "video":
				input.sourceKey = videoKey;
				// No `durationSeconds`: the browser never opens the file, so it has no
				// duration to send. `transcode-video` probes the source with ffprobe and
				// writes it. (The old on-device encoders knew it because they had just
				// decoded the video, and sent it here.)
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
				await failed(res, "Failed to create content.");
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
		const json: WorkInput = {
			title: title.trim(),
			description: description.trim(),
			// Sent unconditionally on an audio Work, including empty — deleting the lyrics
			// is a real edit, and an omitted field cannot express it.
			...(current.type === "audio" ? { lyrics } : {}),
			thumbnail: thumbnailUrl,
			visibility,
			streamEnabled,
			downloadEnabled,
			seedAccess: serializeSeedRows(seedRows),
			// Sent unconditionally, including as `null` — clearing a Created date is a real
			// edit, and an omitted field cannot express it. The server clears the precision
			// alongside it, since a precision without a date claims accuracy about nothing.
			authoredAt: authoredToIso(authoredPrecision, authoredValue),
		};
		if (maturity) {
			json.maturity = maturity;
			json.maturityNotes = contentNotes;
		}
		if (authoredPrecision && json.authoredAt) json.authoredPrecision = authoredPrecision;
		if (type === "game" || type === "software") json.embedUrl = embedUrl.trim();
		if (type === "physical" || type === "service") json.metadata = { note: detailsNote.trim() };
		if (type === "image" && imageUrl) json.sourceKey = imageUrl;
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(current.id) },
				json,
			});
			if (!res.ok) {
				await failed(res, "Failed to save content.");
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

	// Mirrors the server's own definition of the commons (`isFree && streamEnabled &&
	// released`) against the rows as they stand in the form, so the preview answers for what
	// is about to be saved rather than for what was loaded.
	const anyoneAllowed = seedRows.some((r) => r.allow);
	const baselineRow = seedRows.find((r) => r.threshold === 0);
	const publicAccessNow = !!baselineRow?.allow && Number(baselineRow.price) === 0 && streamEnabled;

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
							onSelect={handleVideo}
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

					{/*
					 * Lyrics — audio only, plain text, untimestamped.
					 *
					 * The help text says the gate covers them on purpose. Lyrics ride with the
					 * payload (`serializeWorkForViewer` blanks them alongside the audio), and a
					 * creator who assumed the opposite would only find out from a reader. The
					 * escape hatch is stated too: Description stays visible when locked.
					 */}
					{type === "audio" && (
						<FormField label="Lyrics (optional)">
							<textarea
								className="textarea textarea-bordered w-full font-mono text-sm"
								value={lyrics}
								onChange={(e) => setLyrics(e.target.value)}
								rows={8}
								placeholder={"One line per line.\nBlank lines separate verses."}
							/>
							<p className="mt-1 text-xs text-base-content/60">
								Shown while the track plays. Gated with the audio — if this track is behind a Badge
								Gate or a price, the words are too. Put anything you want everyone to read in the
								Description instead.
							</p>
						</FormField>
					)}

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

					{/* Created date — the creator's claim about when the work was MADE. */}
					<FormField label="Created (optional)">
						<div className="flex flex-wrap gap-2 items-center">
							<select
								className="select select-bordered select-sm"
								value={authoredPrecision ?? ""}
								onChange={(e) => {
									const next = (e.target.value || null) as AuthoredPrecision | null;
									// Re-cut the value to the new precision rather than dropping it, so
									// narrowing "2015-06" to a year keeps 2015 instead of blanking.
									const iso = authoredToIso(authoredPrecision, authoredValue);
									setAuthoredPrecision(next);
									setAuthoredValue(next ? isoToAuthoredValue(iso, next) : "");
								}}
							>
								<option value="">Not stated</option>
								<option value="year">Year</option>
								<option value="month">Month</option>
								<option value="day">Exact date</option>
							</select>
							{authoredPrecision === "year" && (
								<input
									type="number"
									className="input input-bordered input-sm w-28"
									value={authoredValue}
									min="1900"
									max="2200"
									placeholder="2015"
									onChange={(e) => setAuthoredValue(e.target.value)}
								/>
							)}
							{authoredPrecision === "month" && (
								<input
									type="month"
									className="input input-bordered input-sm"
									value={authoredValue}
									onChange={(e) => setAuthoredValue(e.target.value)}
								/>
							)}
							{authoredPrecision === "day" && (
								<input
									type="date"
									className="input input-bordered input-sm"
									value={authoredValue}
									onChange={(e) => setAuthoredValue(e.target.value)}
								/>
							)}
						</div>
						<p className="text-xs text-base-content/50 mt-1">
							When this was made — not when you uploaded it. Stated at the precision you pick, so a
							work you only date to a year shows the year and nothing finer.
						</p>
					</FormField>

					{/* Delivery + access. */}
					<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
						<h3 className="font-semibold text-sm">Delivery</h3>
						<div className="flex flex-wrap gap-4">
							<label className="label cursor-pointer justify-start gap-2">
								<input
									type="checkbox"
									className="checkbox checkbox-sm"
									checked={streamEnabled}
									// A Work must keep at least one way to be consumed; the server enforces
									// it against the resulting state, so don't offer the click that fails.
									disabled={streamEnabled && !downloadEnabled}
									onChange={(e) => setStreamEnabled(e.target.checked)}
								/>
								<span className="label-text text-sm">Stream</span>
							</label>
							<label className="label cursor-pointer justify-start gap-2">
								<input
									type="checkbox"
									className="checkbox checkbox-sm"
									checked={downloadEnabled}
									disabled={downloadEnabled && !streamEnabled}
									onChange={(e) => setDownloadEnabled(e.target.checked)}
								/>
								<span className="label-text text-sm">Download</span>
							</label>
						</div>
						<p className="text-xs text-base-content/50">
							At least one is required. Only streaming work can be Public Access — downloads are
							paid for by whoever bought or unlocked them.
						</p>
					</div>

					{/* The content rating. Nothing is preselected — see the state above. */}
					<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
						<h3 className="font-semibold text-sm">Rating</h3>
						<div className="flex flex-col gap-1">
							{MATURITY_CHOICES.map((choice) => (
								<label
									key={choice.value}
									className="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3 hover:border-primary/50"
								>
									<input
										type="radio"
										name="work-maturity"
										className="radio radio-sm mt-0.5"
										value={choice.value}
										checked={maturity === choice.value}
										onChange={() => setMaturity(choice.value)}
									/>
									<span>
										<span className="block text-sm font-medium">{choice.label}</span>
										<span className="block text-xs text-base-content/50">{choice.hint}</span>
									</span>
								</label>
							))}
						</div>
						{maturityLocked && (
							<div className="alert alert-info text-sm">
								<span>
									An operator set this rating. You can make it more cautious at any time — to lower
									it, appeal below and tell us why.
								</span>
							</div>
						)}
						{/* Stated where the creator meets the control, because it is the rule most
						    often got wrong elsewhere and a policy page nobody opens cannot fix that. */}
						<p className="text-xs text-base-content/50">
							Queer characters, relationships and identity are not Mature, and neither is a
							difficult subject on its own. What this reads is how the work treats it.
						</p>
						<div>
							<p className="text-xs font-medium text-base-content/70">Content notes (optional)</p>
							<p className="text-xs text-base-content/50">
								What someone should know is in this. These describe the work and change nothing
								about who can reach it.
							</p>
							<div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
								{CONTENT_NOTES.map((note) => (
									<label key={note.value} className="label cursor-pointer justify-start gap-2">
										<input
											type="checkbox"
											className="checkbox checkbox-sm"
											checked={contentNotes.includes(note.value)}
											onChange={() => toggleNote(note.value)}
										/>
										<span className="label-text text-sm">{note.label}</span>
									</label>
								))}
							</div>
						</div>
						{hasId && maturityLocked && (
							<RatingAppeal workId={current?.id ?? 0} corrected={editing?.maturity ?? "mature"} />
						)}
					</div>

					<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
						<h3 className="font-semibold text-sm">Access</h3>
						<AccessTables seedRows={seedRows} onSeedChange={setSeedRows} />
					</div>

					{/* Release. Only once the Work exists — create refuses it by design. */}
					{hasId && (
						<div className="border-t border-base-300 pt-4 flex flex-col gap-2">
							<h3 className="font-semibold text-sm">Release</h3>
							<label className="label cursor-pointer justify-start gap-2">
								<input
									type="checkbox"
									className="checkbox checkbox-sm checkbox-primary"
									checked={visibility === "released"}
									// The server refuses an unrated release with `maturity_undeclared`.
									// Don't offer the click that fails — the same reasoning as the
									// delivery switches above.
									disabled={!maturity}
									onChange={(e) => setVisibility(e.target.checked ? "released" : "private")}
								/>
								<span className="label-text text-sm">Released to my public Catalog</span>
							</label>
							{!maturity && (
								<p className="text-xs text-warning">
									Pick a rating above first. Nothing goes into your public Catalog until somebody
									has said whether it is General or Mature.
								</p>
							)}
							{visibility === "released" && !anyoneAllowed && (
								<div className="alert alert-warning text-sm">
									<span>
										Nobody can open this. Released puts it in your Catalog; the Access table above
										is what lets anyone in — allow <strong>Everyone</strong> at $0 to make it Public
										Access.
									</span>
								</div>
							)}
							{visibility === "released" && publicAccessNow && (
								<p className="text-xs text-success">
									Public Access — free to everyone, and earning from the Time Pool.
								</p>
							)}
							<p className="text-xs text-base-content/50">
								Released means listed publicly. It does not mean free — the Access table decides
								that.
							</p>
						</div>
					)}

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
	onSelect: (file: File) => void;
}

function MediaSlot({
	kind,
	fileName,
	hasKey,
	uploading,
	progress,
	stage,
	etaSeconds,
	onSelect,
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
					<FileUpload
						accept={`${kind}/*`}
						maxSize={maxSize}
						onFileSelect={onSelect}
						label={`Drop ${kind === "audio" ? "an" : "a"} ${kind} file or click to browse`}
					/>
					{/*
					 * Says what the old encode-mode toggle used to answer by existing: the
					 * creator is not waiting on their own machine. Worth keeping now that
					 * there is no choice to make — processing still happens, just not here.
					 */}
					<p className="text-xs text-base-content/50">
						Leave anytime — we process it on our servers once it's uploaded.
					</p>
				</div>
			)}
		</FormField>
	);
}
