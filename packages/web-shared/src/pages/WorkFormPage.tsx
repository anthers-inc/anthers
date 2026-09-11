// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * New / Edit **Work** — the Catalog's authoring surface, and a page rather than a dialog
 * since 2026-09-11.
 *
 * 🚨 **The container is the point, and it is about addressability rather than size.** Two
 * controls on this form send the creator somewhere else: the Access table needs Badge rungs
 * that live in Settings, and Release needs payout setup that lives in Settings. Both are
 * things a first-time creator meets on their first Work, and from the modal this used to be
 * they were an instruction to discard everything typed. A page can be left and come back to.
 * The rest follows from having a URL at all — the Catalog card's Edit is a link, the
 * blocked-release hint is a link, and an e2e walk can reach the form by typing it.
 *
 * The route is keyed on **`publicId`**, the durable public address a Work carries, not on
 * the internal row id. `GET /works/:id` resolves either and short-circuits to the
 * owner-facing serialization for the creator, which is the shape with the editable access
 * table in it; every mutation then goes out on the numeric `id` from that response, because
 * `PATCH`, `DELETE` and the asset routes take that one alone.
 *
 * 🚨 **Release is edit-only.** `POST /works` refuses `visibility: "released"` outright
 * (`code: "release_on_create"`) — release is a separate deliberate act, which is the whole
 * point of separating the Catalog from posting. So `/studio/works/new` renders no Release
 * section at all, and creating navigates to the edit route where it appears.
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
import { useNavigate, useParams } from "react-router-dom";
import RatingAppeal from "../components/content/RatingAppeal";
import { useWorkMedia } from "../components/content/work-media";
import { authoredToIso, isoToAuthoredValue } from "../components/content/work-state";
import { isBuildType, LIBRARY_TYPE_OPTIONS, typeLabel } from "../components/content/works";
import AccessTables, {
	buildSeedRows,
	type SeedRowDraft,
	serializeSeedRows,
} from "../components/post/AccessTables";
import { keyToPreview, uploadImageFile } from "../components/post/mediaUpload";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioEditWorkUrl, studioUrl } from "../lib/studio";
import type {
	AuthoredPrecision,
	CreatorGate,
	UploadableWorkType,
	Work,
	WorkInput,
} from "../lib/types";
import { uploadMediaFile } from "../lib/upload";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function WorkFormPage() {
	const { publicId } = useParams<{ publicId: string }>();
	const isEdit = Boolean(publicId);
	const [loading, setLoading] = useState(isEdit);
	const [loaded, setLoaded] = useState<Work | null>(null);

	useEffect(() => {
		if (!isEdit || !publicId) return;
		let live = true;
		client.api.content.works[":id"]
			.$get({ param: { id: publicId }, query: {} })
			.then(async (res) => {
				if (!res.ok) return null;
				const { work } = (await res.json()) as unknown as { work: Work };
				return work;
			})
			.then((work) => {
				if (live) setLoaded(work);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, [publicId, isEdit]);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (isEdit && !loaded) {
		return (
			<div className="max-w-3xl mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold">We can't find that Work</h1>
				<p className="mt-2 text-sm text-base-content/60">
					It may have been deleted, or it belongs to someone else.
				</p>
				<Link to={studioUrl("/catalog")} className="btn btn-primary btn-sm mt-6">
					Back to your Catalog
				</Link>
			</div>
		);
	}

	// Keyed so that navigating from `new` to `:publicId/edit` rebuilds the form against the
	// Work that now exists, rather than reusing create-time state for an edit.
	return <WorkForm key={loaded?.id ?? "new"} editing={loaded} />;
}

function WorkForm({ editing }: { editing: Work | null }) {
	const navigate = useNavigate();

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

	const media = useWorkMedia(type, editing);

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
	// Reads the vocabulary rather than listing the values, so a rung added to the scale is
	// carried into the editor rather than silently falling back to "unanswered" on a Work
	// that is in fact rated.
	const [maturity, setMaturity] = useState<Exclude<MaturityRating, "unrated"> | null>(
		editing?.maturity && editing.maturity !== "unrated" ? editing.maturity : null,
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

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [visibility, setVisibility] = useState<"private" | "released">(
		editing?.visibility === "released" ? "released" : "private",
	);

	/**
	 * Whether payouts are set up, so the release control can say so before it is clicked.
	 *
	 * 🚨 **A prediction, never the decision.** `services/payouts.ts` is the authority and
	 * `PATCH /works/:id` refuses with `payouts_required`; this exists for the same reason
	 * `disabled={!maturity}` does below — don't offer a click that fails. `null` means the
	 * answer has not arrived, and the control stays enabled until it does: a creator whose
	 * status request failed should meet the server's refusal, not a disabled checkbox with
	 * no explanation.
	 */
	const [payoutsReady, setPayoutsReady] = useState<boolean | null>(null);

	useEffect(() => {
		let live = true;
		client.api.payments.stripe.onboard
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as {
					payoutsEnabled: boolean | null;
					onboardingComplete: boolean | null;
				};
				// Both flags, matching the server's predicate exactly. Onboarding can finish
				// while Stripe still declines to send money, and only the second answers
				// "can this creator be paid".
				if (live) setPayoutsReady(data.payoutsEnabled === true && data.onboardingComplete === true);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

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

	/**
	 * The server's own words, when it has any.
	 *
	 * Every failure here is a decision the creator can act on — media still encoding, no
	 * delivery switch on, a date without its precision — and a generic string turns all of
	 * them into "something went wrong", which is the one thing none of them are.
	 */
	// ⚠️ Takes what it uses rather than a whole `Response`. The RPC client returns a
	// `ClientResponse`, and its structural match against `Response` breaks whenever
	// `@types/bun` moves — which it does on any `bun add`, since every workspace asks for
	// `latest`. Reading a JSON body is all this needs to know about.
	const failed = async (res: { json: () => Promise<unknown> }, fallback: string) => {
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
		const input: WorkInput & { type: UploadableWorkType } = { type, ...media.fields() };
		if (title.trim()) input.title = title.trim();
		if (description.trim()) input.description = description.trim();
		if (type === "audio" && lyrics.trim()) input.lyrics = lyrics;
		if (thumbnailUrl) input.thumbnail = thumbnailUrl;
		// A single image is its own thumbnail unless one was set explicitly.
		else if (type === "image" && media.imageKey) input.thumbnail = media.imageKey;
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
		try {
			const res = await client.api.content.works.$post({ json: input });
			if (!res.ok) {
				await failed(res, "Failed to create this Work.");
				return;
			}
			const { work: created } = await res.json();
			// Straight to the edit route, which is where Release and the builds section live.
			// The same two-phase shape the Project form has, handled the same way: a create
			// that ends on a page with nothing left to do is a creator hunting for the way back.
			navigate(studioEditWorkUrl((created as Work).publicId ?? (created as Work).id));
		} catch {
			setError("Failed to create this Work.");
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
			...media.fields(),
		};
		if (maturity) {
			json.maturity = maturity;
			json.maturityNotes = contentNotes;
		}
		if (authoredPrecision && json.authoredAt) json.authoredPrecision = authoredPrecision;
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(current.id) },
				json,
			});
			if (!res.ok) {
				await failed(res, "Failed to save this Work.");
				return;
			}
			const { work: updated } = await res.json();
			setCurrent(updated as Work);
			navigate(studioUrl("/catalog"));
		} catch {
			setError("Failed to save this Work.");
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
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">{hasId ? `Edit ${typeLabel(type)}` : "New Work"}</h1>
			<p className="text-sm text-base-content/60 mb-6">
				A Work is the thing itself — the file, its access and its price. It stands on its own in
				your Catalog whether or not you ever write a post about it.
			</p>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			<div className="flex flex-col gap-4">
				{/* Type — fixed once the Work exists. */}
				<FormField label="Type">
					{hasId ? (
						<div className="badge badge-neutral">{typeLabel(type)}</div>
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

				{media.slot}

				<FormField label="Title">
					<input
						type="text"
						className="input input-bordered w-full"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						placeholder="Work title"
					/>
				</FormField>

				{/*
				 * 🚨 **The hint is the point, not decoration.** A description is shown to
				 * everyone — including somebody who has not cleared this Work's gate, and, once
				 * a creator holds an Anthers handle, on the AT Protocol network where it cannot
				 * be un-published. A creator writing one aimed at buyers would reasonably assume
				 * it sat behind the gate with everything else, and the label said nothing.
				 * Saying so is what makes this a field the creator controls rather than one
				 * they are caught by.
				 */}
				<FormField
					label="Description (optional)"
					hint="Shown to everyone, including people who haven't unlocked this."
				>
					<textarea
						className="textarea textarea-bordered w-full"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
						rows={2}
						placeholder="Describe this Work…"
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
					<FormField
						label="Lyrics (optional)"
						hint="Shown while the track plays. Gated with the audio — if this track is behind a Badge Gate or a price, the words are too. Put anything you want everyone to read in the Description instead."
					>
						<textarea
							className="textarea textarea-bordered w-full font-mono text-sm"
							value={lyrics}
							onChange={(e) => setLyrics(e.target.value)}
							rows={8}
							placeholder={"One line per line.\nBlank lines separate verses."}
						/>
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
				<FormField
					label="Created (optional)"
					hint="When this was made — not when you uploaded it. Stated at the precision you pick, so a work you only date to a year shows the year and nothing finer."
				>
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
				</FormField>

				{/* Delivery + access. */}
				<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Delivery</h2>
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
						At least one is required. Only streaming work can be Public Access — downloads are paid
						for by whoever bought or unlocked them.
					</p>
				</div>

				{/* The content rating. Nothing is preselected — see the state above. */}
				<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Rating</h2>
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
						Queer characters, relationships and identity are not Mature, and neither is a difficult
						subject on its own. What this reads is how the work treats it.
					</p>
					<div>
						<p className="text-xs font-medium text-base-content/70">Content notes (optional)</p>
						<p className="text-xs text-base-content/50">
							What someone should know is in this. These describe the work and change nothing about
							who can reach it.
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
					<h2 className="font-semibold text-sm">Access</h2>
					<AccessTables seedRows={seedRows} onSeedChange={setSeedRows} />
					{seedRows.length === 1 && (
						<p className="text-xs text-base-content/50">
							Want to gate this by monthly support?{" "}
							<Link to={studioUrl("/settings")} className="link">
								Add Badge rungs in Settings
							</Link>{" "}
							and they appear here. Your changes are kept — this is a page, so you can come back.
						</p>
					)}
				</div>

				{/* Release. Only once the Work exists — create refuses it by design. */}
				{hasId && (
					<div className="border-t border-base-300 pt-4 flex flex-col gap-2">
						<h2 className="font-semibold text-sm">Release</h2>
						<label className="label cursor-pointer justify-start gap-2">
							<input
								type="checkbox"
								className="checkbox checkbox-sm checkbox-primary"
								checked={visibility === "released"}
								// The server refuses an unrated release with `maturity_undeclared`,
								// and one with no payout setup with `payouts_required`. Don't offer
								// the click that fails — the same reasoning as the delivery
								// switches above. `payoutsReady === false` rather than
								// `!payoutsReady`, so an unanswered status request leaves the
								// control alone instead of locking it for a reason nobody stated.
								disabled={!maturity || payoutsReady === false}
								onChange={(e) => setVisibility(e.target.checked ? "released" : "private")}
							/>
							<span className="label-text text-sm">Released to my public Catalog</span>
						</label>
						{!maturity && (
							<p className="text-xs text-warning">
								Pick a rating above first. Nothing goes into your public Catalog until somebody has
								said whether it is General or Mature.
							</p>
						)}
						{payoutsReady === false && (
							<div className="alert alert-warning text-sm">
								<span>
									<strong>Set up payouts before releasing.</strong> It is how you get paid, and it
									is also what lets us say every creator here is an adult — Stripe checks identity
									so Anthers never has to ask you for an ID. Anthers takes no cut, so all of it
									comes to you.{" "}
									<Link to={studioUrl("/settings")} className="link">
										Set it up in Studio settings
									</Link>
									. Your changes here are saved when you come back.
								</span>
							</div>
						)}
						{visibility === "released" && !anyoneAllowed && (
							<div className="alert alert-warning text-sm">
								<span>
									Nobody can open this. Released puts it in your Catalog; the Access table above is
									what lets anyone in — allow <strong>Everyone</strong> at $0 to make it Public
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
							Released means listed publicly. It does not mean free — the Access table decides that.
						</p>
					</div>
				)}

				{/* Downloadable builds (games/software) */}
				{(type === "game" || type === "software") && !hasId && (
					<p className="text-xs text-base-content/50">
						Create the Work first, then add downloadable builds.
					</p>
				)}

				{showBuilds && (
					<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
						<h2 className="font-semibold text-sm">Downloadable builds</h2>

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

				<div className="flex flex-wrap gap-2 mt-2 border-t border-base-300 pt-4">
					<button
						type="button"
						className="btn btn-primary"
						onClick={hasId ? handleSaveEdit : handleCreate}
						disabled={saving || media.uploading || (!hasId && !media.ready)}
						title={hasId || media.ready ? undefined : "Add the file for this Work's type first"}
					>
						{saving ? "Saving…" : hasId ? "Save Work" : "Create Work"}
					</button>
					<Link to={studioUrl("/catalog")} className="btn btn-ghost">
						Cancel
					</Link>
				</div>
			</div>
		</div>
	);
}
