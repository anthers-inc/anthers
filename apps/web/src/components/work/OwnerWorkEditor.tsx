// SPDX-License-Identifier: Apache-2.0
/**
 * A **video Work's editing surface, on the Work's own page** — the unified layout Parker
 * set in motion 2026-10-13: the creator and any user see the SAME page, and the creator's
 * edit controls live inline in the very places the user sees the result.
 *
 * ⭐ **The Studio ends at the Works list.** Editing one Work happens on its page, which is
 * a place users can see; the only things here a user never sees are the things carried in
 * styling that says so — the editing banner, the pencils, the working tables inside a
 * field's edit state, and the Media Status card.
 *
 * Below the deliverable the page is two columns: the left is the **Info tab group**
 * (Details · Credits · Access · Rating · Accessibility) shared with the user's rendering
 * of the same page (`WorkInfoTabs`), the right is **Reviews · Showings**
 * (`WorkSideColumn`). Each editable thing the user can see is an `InlineField` — pencil
 * opens it, X cancels, checkmark saves the field alone; there is no page-wide Save.
 *
 * ⚠️ **Saves are narrow, one field per request, and adopt the response.** The server's
 * own rules (release gates, the rating re-declaration refusal, the media floors) are the
 * authority and answer in their own words; a field's error shows where the field lives —
 * which is what the batch bar's one shared error string could never do. The two deliberate
 * carries from the batch editor: a save NEVER sends `sourceKey`, and the thumbnail is
 * sent only from its settled value (the race into work 23's lost thumbnail).
 *
 * ⚠️ **Video only this pass.** Every other kind keeps the Studio editor it has
 * (`studio/WorkEditPage.tsx`), and moves onto this surface in its own pass; the tab shell
 * and the field pattern here are what that pass will adopt.
 */

import { needsChosenThumbnail, THUMBNAIL_RULE } from "@anthers/shared/content";
import {
	type ContentNote,
	contentNoteLabel,
	gridFor,
	type MaturityRating,
	type MaturityRows,
	maturityLabel,
	normalizeContentNotes,
	normalizeMaturityRows,
	notesFromRows,
	ratingFromRows,
} from "@anthers/shared/content-rating";
import { useAuth } from "@anthers/web-shared/auth";
import RatingAppeal from "@anthers/web-shared/content/RatingAppeal";
import { isFileWorkType } from "@anthers/web-shared/content/work-media";
import { LIBRARY_TYPE_OPTIONS } from "@anthers/web-shared/content/works";
import { isoToLocalInput, localInputToIso } from "@anthers/web-shared/local-datetime";
import { usePayoutsReady } from "@anthers/web-shared/payouts";
import AccessTables, {
	type AccessRowDraft,
	buildAccessRows,
	serializeAccessRows,
} from "@anthers/web-shared/post/AccessTables";
import { keyToPreview, uploadImageFile } from "@anthers/web-shared/post/mediaUpload";
import { publishingPermissionMissing, usePublishingState } from "@anthers/web-shared/publishing";
import {
	RATED_PUBLIC_ACCESS_HELP,
	showsRatedPublicAccessNotice,
} from "@anthers/web-shared/rated-public-access";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import {
	accessRowsOf,
	type CreatorBadge,
	type UploadableWorkType,
	type Work,
	type WorkCredit,
	type WorkInput,
} from "@anthers/web-shared/types";
import FileUpload from "@anthers/web-shared/ui/FileUpload";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { isUploading, useSourceUpload, workUploads } from "@anthers/web-shared/work-uploads";
import { CalendarIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useEffect, useRef, useState } from "react";
import CreditsSection from "../../studio/CreditsSection";
import RatingMatrix from "../../studio/RatingMatrix";
import WorkCaptionsEditor from "../../studio/WorkCaptionsEditor";
import WorkReviews from "../project/WorkReviews";
import { EditingBanner, InlineField } from "./Editing";
import MediaStatusCard from "./MediaStatusCard";
import WorkInfoTabs, { type InfoTab } from "./WorkInfoTabs";
import {
	formatOriginallyReleased,
	WORK_DESCRIPTION_CLASS,
	WorkColumn,
	WorkCredits,
	WorkDeliverable,
	type WorkDetail,
	WorkHeader,
	WorkRecordLink,
	workTitleTypography,
} from "./WorkLayout";
import WorkSideColumn, { ShowingsStub } from "./WorkSideColumn";

const IN_PLACE =
	"rounded-md border border-transparent bg-transparent px-2 -mx-2 hover:border-base-300 focus:border-primary focus:outline-none";

/** The in-place style a control gets while it is EMPTY — a placeholder in an invisible
 * field would read as stray text on the page, so an empty control carries a quiet border
 * that says a field is here. */
const IN_PLACE_EMPTY =
	"rounded-md border border-base-300 bg-transparent px-2 -mx-2 hover:border-primary/40 focus:border-primary focus:outline-none placeholder:text-base-content/40";

/** A text area that grows with what is in it, the way the text it stands in for would. */
const GROWS = "resize-none [field-sizing:content]";

export default function OwnerWorkEditor({
	work,
	onRefetch,
}: {
	work: WorkDetail;
	/** A wholesale re-read the page asks for after an act outside the field saves —
	 *  credit decisions above all. */
	onRefetch: () => void;
}) {
	const { user } = useAuth();
	const [current, setCurrent] = useState<WorkDetail>(work);

	/** Adopt a row the server answered: a save or a media re-read writes here. */
	const adopt = (updated: Work) => {
		setCurrent((prev) => ({ ...prev, ...updated, shownOn: prev.shownOn }));
	};

	// ── The fields, as the row holds them ──
	const [title, setTitle] = useState(work.title ?? "");
	const [description, setDescription] = useState(work.description ?? "");
	// The image an image Work is — not a video field; carried here the day this surface
	// takes more kinds. Video pass: untouched.
	const [imageAlt, setImageAlt] = useState(work.imageAlt ?? "");
	const [thumbnailUrl, setThumbnailUrl] = useState(work.thumbnail ?? "");
	const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(
		work.thumbnail ? keyToPreview(work.thumbnail) : null,
	);
	/**
	 * Whether the creator changed the thumbnail here, and so whether a save may send it. A
	 * ref, because the media re-reads below run from timers and must see the answer as it
	 * is now; `thumbnailInFlight` is the settled-value guard from the batch editor — the
	 * same race this page's per-field save closes properly, because the check waits.
	 */
	const thumbnailTouched = useRef(false);
	const thumbnailInFlight = useRef(0);
	/** The video's `<video>` element, once it renders, for *Use This Frame*. */
	const videoEl = useRef<HTMLVideoElement | null>(null);
	/** Why taking a frame did not work, said beside the button. */
	const [frameError, setFrameError] = useState<string | null>(null);
	const [frameBusy, setFrameBusy] = useState(false);

	// Original release date — the creator's claim about when the work FIRST came out,
	// anywhere, distinct from the release date (when it went public here). Empty means
	// "came out here first".
	const [originalDate, setOriginalDate] = useState(() =>
		work.originallyReleased ? work.originallyReleased.slice(0, 10) : "",
	);

	// Delivery. A Work must keep at least one of them on, which the server enforces against
	// the state the edit RESULTS IN.
	const [streamEnabled, setStreamEnabled] = useState(work.streamEnabled ?? true);
	const [downloadEnabled, setDownloadEnabled] = useState(work.downloadEnabled ?? false);

	// The content rating, as the matrix a creator marks row by row. Nothing is preselected
	// (see `studio/WorkEditPage.tsx`'s docblock — the rule binds here identically; a field
	// that saves alone makes it truer still).
	const [rows, setRows] = useState<MaturityRows>(() =>
		normalizeMaturityRows(work.maturityRows, gridFor(work.type)),
	);
	const grid = gridFor(work.type);
	/**
	 * Whether the rows differ from what is saved, and so whether a save sends them. Sent
	 * unchanged, they would re-declare the rating they add up to, which an operator's
	 * correction above it would refuse on every save of anything else.
	 */
	const rowsChanged =
		JSON.stringify(normalizeMaturityRows(rows, grid)) !==
		JSON.stringify(normalizeMaturityRows(work.maturityRows, grid));
	// The rating the page stands at: what the rows add up to once every row is answered,
	// and the Work's own rating until then. 🚨 Release and scheduling wait on `fromRows`
	// rather than on `maturity` — a rated Work has every row answered (Parker, 2026-09-18),
	// and the server refuses a stored rating with none behind it.
	const fromRows = ratingFromRows(rows);
	const storedMaturity =
		current.maturity && current.maturity !== "unrated" ? current.maturity : null;
	const maturity = fromRows ?? storedMaturity;
	const contentNotes = fromRows
		? notesFromRows(rows)
		: normalizeContentNotes(current.maturityNotes ?? []);
	const maturityLocked = current.maturityLocked ?? false;

	// Access. The creator's Badge ladder is fetched below because rungs live on the
	// creator, not on the Work — `buildAccessRows` merges the Work's stored rows onto
	// whatever rungs exist, so the rows are the only state worth holding.
	const [accessRows, setAccessRows] = useState<AccessRowDraft[]>(() =>
		buildAccessRows([], accessRowsOf(work.access)),
	);

	// The credits — the Work's liner notes, who or what made which part. Rows are drafts of
	// the stored table; the same validation the server enforces (a Created credit names its
	// contributor) is enforced here so the creator meets it in the editor, not on the save.
	const [creditRows, setCreditRows] = useState<WorkCredit[]>(() =>
		(work.credits ?? []).map((r) => ({ ...r, types: [...r.types] })),
	);
	const [showCreditErrors, setShowCreditErrors] = useState(false);
	const onCreditRowsChange = (next: WorkCredit[]) => {
		setShowCreditErrors(false);
		setCreditRows(next);
	};

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Which Info tab is open — lifted, because the header's *Change* rating link opens Rating. */
	const [activeInfoTab, setActiveInfoTab] = useState("details");

	const [visibility, setVisibility] = useState<"private" | "released">(
		work.visibility === "released" ? "released" : "private",
	);

	// A scheduled release, as the datetime input holds it. Sent only when changed — an
	// unchanged one in the past would read as a new time that has already gone by. Read
	// off the SAVED row, because the field saves alone and the page stays open.
	const loadedSchedule = isoToLocalInput(current.scheduledReleaseAt);
	const [scheduledRelease, setScheduledRelease] = useState(loadedSchedule);
	const scheduledIso = localInputToIso(scheduledRelease);
	const scheduleHint = !scheduledIso
		? "Pick a time and save, and it releases then on its own."
		: scheduledRelease === loadedSchedule && Date.parse(scheduledIso) <= Date.now()
			? "Its release time has passed. It goes out as soon as its file has finished uploading, processing and being checked."
			: "It releases at this time once it's ready, and if its file is still uploading or processing then, as soon as that finishes. If something only you can fix stops it, the schedule is cleared and we'll email you.";

	/** Whether payouts are set up, so the release control can say so before it is clicked. */
	const payoutsReady = usePayoutsReady();
	const publishing = usePublishingState();
	/** Whether Anthers lacks the permission to publish this creator's listing, likewise. */
	const permissionMissing = publishingPermissionMissing(publishing);
	/** Whether the server holding the creator's identity is down — said in the field, not silently. */
	const serverDown = publishing?.server?.reachable === false;

	/**
	 * One narrow save, and the response is the row the page now shows. Each field sends
	 * exactly the fields it owns; the server's own rules answer in their own words.
	 *
	 * ⚠️ **Never a `sourceKey`** — the Work's file belongs to the upload flow, whose
	 * attach is a separate request the page must never argue with (the batch editor's
	 * rule, intact here). And 🚨 never leave the page in an adopted-but-wrong state: on a
	 * refusal the thrown error reads in the field, and `current` stands as it was.
	 */
	const saveFields = async (fields: Partial<WorkInput>): Promise<void> => {
		const res = await client.api.content.works[":id"].$patch({
			param: { id: String(current.id) },
			json: fields as WorkInput,
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			throw new Error(body?.error ?? "Failed to save this Work.");
		}
		const { work: updated } = await res.json();
		adopt(updated as Work);
	};

	/** The thumbnail's own save — sent only from a settled value (the touched race's rule). */
	const saveThumbnail = async (next: string): Promise<void> => {
		if (thumbnailInFlight.current > 0) throw new Error("The thumbnail is still uploading.");
		await saveFields({ thumbnail: next });
		thumbnailTouched.current = false;
	};

	// ── The Work's file: the media half of the row re-read as it changes under us ──
	const sourceUpload = useSourceUpload(current.id);
	const fileUploading = sourceUpload != null && isUploading(sourceUpload);

	/**
	 * Re-read the media half of the row when an upload lands — the file section, the
	 * builds, and a thumbnail the server set — without touching anything typed. The
	 * batch editor's `refreshMedia`, minus the fields the per-field saves own.
	 */
	const refreshMedia = async () => {
		const res = await client.api.content.works[":id"].$get({
			param: { id: String(current.id) },
			query: {},
		});
		if (!res.ok) return;
		const { work: fresh } = (await res.json()) as unknown as { work: Work };
		setCurrent((prev) => ({
			...prev,
			...fresh,
			shownOn: prev.shownOn,
		}));
		if (!thumbnailTouched.current && fresh.thumbnail) {
			setThumbnailUrl(fresh.thumbnail);
			setThumbnailPreview(keyToPreview(fresh.thumbnail));
		}
	};

	// While the file is processing, follow it, so the progress and estimate move on the
	// page. Ticks are skipped while the tab is hidden, as everywhere else in the app.
	const running =
		current.transcoding?.status === "pending" || current.transcoding?.status === "processing";
	// biome-ignore lint/correctness/useExhaustiveDependencies: poll while running, and only then
	useEffect(() => {
		if (!running) return;
		const interval = setInterval(() => {
			if (!document.hidden) void refreshMedia();
		}, 4000);
		return () => clearInterval(interval);
	}, [running]);

	// The creator's own Badge rungs — best-effort, the table still renders its baseline
	// row without them. See the batch editor; the merge-through-state is the same.
	useEffect(() => {
		let live = true;
		client.api.subscriptions.badges
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as { badges: CreatorBadge[] };
				if (!live) return;
				setAccessRows((prev) => buildAccessRows(data.badges ?? [], serializeAccessRows(prev)));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	// ── The thumbnail itself ──
	const handleThumbnail = async (file: File) => {
		thumbnailTouched.current = true;
		thumbnailInFlight.current += 1;
		setThumbnailPreview(URL.createObjectURL(file));
		try {
			const { url } = await uploadImageFile(file, "thumbnail");
			setThumbnailUrl(url);
			setThumbnailPreview(url);
		} catch {
			setThumbnailPreview(thumbnailUrl ? keyToPreview(thumbnailUrl) : null);
			if (!thumbnailUrl) thumbnailTouched.current = false;
		} finally {
			thumbnailInFlight.current -= 1;
		}
	};

	/**
	 * Store the moment the video is paused on as its thumbnail — the SERVER extracts it.
	 * ⚠️ The click pauses first, so the thumbnail is the frame the creator is looking at;
	 * the route saves the field itself (one act, no client upload in flight).
	 */
	const takeCurrentFrame = async () => {
		setFrameError(null);
		const video = videoEl.current;
		if (!video?.videoWidth) {
			setFrameError("Play the video to the moment you want first.");
			return;
		}
		if (!video.paused) video.pause();
		setFrameBusy(true);
		try {
			const res = await client.api.content.works[":id"]["thumbnail-frame"].$post({
				param: { id: String(current.id) },
				json: { atSeconds: video.currentTime },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setFrameError(body?.error || "Taking the frame didn't work. Upload an image instead.");
				return;
			}
			const { work: updated } = (await res.json()) as { work: Work };
			adopt(updated);
			thumbnailTouched.current = false;
			thumbnailInFlight.current = 0;
			if (updated.thumbnail) {
				setThumbnailUrl(updated.thumbnail);
				setThumbnailPreview(keyToPreview(updated.thumbnail));
			}
		} catch {
			setFrameError("Taking the frame didn't work. Upload an image instead.");
		} finally {
			setFrameBusy(false);
		}
	};

	// ── Processing: cancel, remove ──
	const [cancelBusy, setCancelBusy] = useState(false);
	const cancelProcessing = async () => {
		const job = current.transcoding;
		if (!job || (job.status !== "pending" && job.status !== "processing")) return;
		setCancelBusy(true);
		try {
			const res = await client.api.content.works[":id"].transcoding[":jobId"].$delete({
				param: { id: String(current.id), jobId: String(job.id) },
			});
			if (!res.ok) throw new Error(`cancel answered ${res.status}`);
			await refreshMedia();
		} catch {
			setError("Failed to cancel processing.");
		} finally {
			setCancelBusy(false);
		}
	};
	const [removalBusy, setRemovalBusy] = useState(false);
	const removeMedia = async () => {
		if (
			!confirm(
				"Remove this Work's media? The file and everything produced from it will be deleted, and the Work goes back to being a draft with no file.",
			)
		)
			return;
		setRemovalBusy(true);
		try {
			const res = await client.api.content.works[":id"].media.$delete({
				param: { id: String(current.id) },
			});
			if (!res.ok) throw new Error(`removal answered ${res.status}`);
			// An image's face follows its file; clearing the local preview keeps the field
			// from showing the just-swept object on the way out. A thumbnail upload still
			// in flight has nothing left to attach to — forget it.
			thumbnailInFlight.current = 0;
			thumbnailTouched.current = false;
			setThumbnailUrl("");
			setThumbnailPreview(null);
			await refreshMedia();
		} catch {
			setError("Failed to remove the media.");
		} finally {
			setRemovalBusy(false);
		}
	};

	/** Whether the Work itself can be shown as a user sees it: its file is attached and
	 *  nothing of its own is still arriving. (Video plays its original before the ladder —
	 *  the 2026-10-10/11 delivery ruling; the batch editor's docblock carries why audio
	 *  and ebooks keep the completed gate.) */
	const fileReady = isFileWorkType(work.type) && !!current.sourceKey && !fileUploading;

	// ── Release: the facts each control waits on (the batch editor's predicates, against the page as it stands) ──
	const unpublished = !current.releasedAt && current.visibility !== "withdrawn";
	const anyoneAllowed = accessRows.some((r) => r.allow);
	const baselineRow = accessRows.find((r) => r.threshold === 0);
	const publicAccessNow = !!baselineRow?.allow && Number(baselineRow.price) === 0 && streamEnabled;
	const fileMissing = !current.sourceKey || fileUploading;
	const thumbnailMissing = needsChosenThumbnail(work.type) && !thumbnailUrl;
	const creditsMissing = !creditRows.some((r) => r.types.includes("created"));
	const releaseBlocked =
		payoutsReady === false ||
		((!fromRows ||
			fileMissing ||
			thumbnailMissing ||
			creditsMissing ||
			permissionMissing === true) &&
			visibility !== "released");

	// ── The Info tabs' contents ──
	/** The kind, while a private draft could still be another kind. */
	const kindChangeable =
		current.visibility !== "released" &&
		visibility !== "released" &&
		!current.sourceKey &&
		!current.embedUrl &&
		!fileUploading;

	const asRead: WorkDetail = {
		...current,
		thumbnail: thumbnailPreview ?? current.thumbnail,
		creator: user?.handle
			? {
					handle: user.handle,
					displayName: user.displayName ?? null,
					avatar: user.avatar ?? null,
				}
			: current.creator,
	};

	const thumbnailField = (
		<InlineField<string>
			label="Thumbnail"
			saved={thumbnailUrl}
			renderRead={() => (
				<div className="flex items-center gap-4">
					{thumbnailPreview ? (
						<img
							src={thumbnailPreview}
							alt="The Work's thumbnail"
							className="w-40 rounded-lg object-cover"
						/>
					) : (
						<p className="text-sm text-base-content/60">No thumbnail yet.</p>
					)}
					<p className="max-w-prose text-xs text-base-content/60">
						{THUMBNAIL_RULE}
						{needsChosenThumbnail(work.type) &&
							" A video needs one before it's released: upload an image, or pause the video and use that frame."}
					</p>
				</div>
			)}
			renderEdit={(_draft, _setDraft) => (
				/* The upload and the paused-frame act are what the edit state IS; the value
				   below is touched, not typed — the check is disabled until one settles. */
				<ThumbEditor
					preview={thumbnailPreview}
					required={needsChosenThumbnail(work.type)}
					onFile={handleThumbnail}
					onClear={() => {
						thumbnailTouched.current = true;
						setThumbnailUrl("");
						setThumbnailPreview(null);
					}}
					onFrame={fileReady ? takeCurrentFrame : undefined}
					frameBusy={frameBusy}
					inFlight={thumbnailInFlight.current > 0}
					frameError={frameError}
				/>
			)}
			save={(next) => saveThumbnail(next)}
		/>
	);

	const descriptionField = (
		<InlineField<string>
			label="Description"
			saved={description}
			renderRead={() => (
				<section className={WORK_DESCRIPTION_CLASS}>
					{description ? (
						<p>{description}</p>
					) : (
						<p className="text-sm text-base-content/40">Nothing written yet.</p>
					)}
				</section>
			)}
			renderEdit={(draft, setDraft) => (
				<div>
					<textarea
						aria-label="Description"
						className={`${WORK_DESCRIPTION_CLASS} ${description ? IN_PLACE : IN_PLACE_EMPTY} ${GROWS} w-full min-h-16`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						rows={3}
						placeholder="Describe this Work…"
					/>
					<p className="text-xs text-base-content/50">
						Shown to everyone, including people who haven't unlocked this.
					</p>
				</div>
			)}
			save={(draft) => saveFields({ description: draft.trim() })}
		/>
	);

	const releaseField = (
		<InlineField
			label="Release"
			saved={visibility}
			renderRead={() => <ReleaseSummary work={current} scheduled={scheduledIso} />}
			renderEdit={(_draft, _setDraft) => (
				<div className="flex flex-col gap-3">
					<label className="label cursor-pointer justify-start gap-2">
						<input
							type="checkbox"
							className="checkbox checkbox-sm checkbox-primary"
							checked={visibility === "released"}
							disabled={releaseBlocked}
							onChange={(e) => {
								setVisibility(e.target.checked ? "released" : "private");
								// Releasing now supersedes a schedule, as it does on the server.
								if (e.target.checked) setScheduledRelease("");
							}}
						/>
						<span className="label-text text-sm">Released to my public Catalog</span>
					</label>
					{current.visibility === "released" &&
						(current.recordUrl ? (
							<WorkRecordLink work={current} />
						) : (
							<p className="text-xs text-base-content/50">Its listing isn't on the network yet.</p>
						))}
					{visibility !== "released" && (
						<div className="flex flex-col gap-1">
							<span className="text-sm">Or release it later</span>
							<div className="flex flex-wrap items-center gap-2">
								<input
									type="datetime-local"
									className="input input-bordered input-sm"
									aria-label="Release time"
									value={scheduledRelease}
									onChange={(e) => setScheduledRelease(e.target.value)}
								/>
								{scheduledRelease && (
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										onClick={() => setScheduledRelease("")}
									>
										Clear
									</button>
								)}
							</div>
							<p className="text-xs text-base-content/50">{scheduleHint}</p>
						</div>
					)}
					{visibility === "released" && !anyoneAllowed && (
						<div className="alert alert-warning text-sm">
							<span>
								Nobody can open this. Released puts it in your Catalog; the Access tab is what lets
								anyone in — allow <strong>Everyone</strong> at $0 to make it Public Access.
							</span>
						</div>
					)}
					{visibility === "released" && publicAccessNow && (
						<p className="text-xs text-success">
							Public Access — free to everyone, and earning from the Time Pool.
						</p>
					)}
					{showsRatedPublicAccessNotice({
						released: visibility === "released",
						publicAccess: publicAccessNow,
						maturity,
					}) && (
						// Info rather than warning: nothing is wrong, and the note must not read as a
						// reason to rate lower or leave Public Access.
						<div className="alert alert-info text-sm">
							<span>
								Heads up: Mature and Adult Works aren't shown to everyone. Users (or parents) can
								choose to hide Mature Works, and Adult work is shown only to users who are 18+ and
								have opted in.{" "}
								<Link to={RATED_PUBLIC_ACCESS_HELP} className="link">
									How Ratings Affect Who Sees a Work
								</Link>
							</span>
						</div>
					)}
					<p className="text-xs text-base-content/50">
						Released means listed publicly. It does not mean free — the Access tab decides that.
					</p>
					{/* The waiting states a creator can act on, gathered from the batch editor. */}
					{fileMissing && visibility !== "released" && (
						<p className="text-xs text-warning">
							{fileUploading
								? "This can be released once its file has finished uploading and processing."
								: "Add the Work's file first. There's nothing to release until it arrives."}
						</p>
					)}
					{thumbnailMissing && visibility !== "released" && (
						<p className="text-xs text-warning">
							Choose a thumbnail first — a video isn't released without one.
						</p>
					)}
					{creditsMissing && visibility !== "released" && (
						<p className="text-xs text-warning">
							A Work isn't released until at least one credit has its Created box ticked.
						</p>
					)}
					{!fromRows && visibility !== "released" && (
						<p className="text-xs text-warning">
							Answer every row of the Rating first — every row, no exceptions.
						</p>
					)}
					{serverDown && visibility !== "released" && (
						<div className="alert alert-info text-sm">
							<span>
								The server holding your identity isn't answering right now. You can still release
								this: it goes out on Anthers straight away, and its listing reaches the network once
								the server is back.
							</span>
						</div>
					)}
					{permissionMissing === true && visibility !== "released" && (
						<div className="alert alert-warning text-sm">
							<span>
								<strong>Give Anthers permission to publish before releasing.</strong> A release
								writes this Work's listing into your own repository.{" "}
								<Link to={studioUrl("/settings")} className="link">
									Give it in Studio settings
								</Link>
								.
							</span>
						</div>
					)}
					{payoutsReady === false && (
						<div className="alert alert-warning text-sm">
							<span>
								<strong>Set up payouts before releasing.</strong> It is how you get paid, and it is
								also what lets us say every creator here is an adult — Stripe checks identity so
								Anthers never has to ask you for an ID. Anthers takes no cut, so all of it comes to
								you.{" "}
								<Link to={studioUrl("/payments")} className="link">
									Set it up in the Studio's Payments tab
								</Link>
								.
							</span>
						</div>
					)}
				</div>
			)}
			save={async (draft) => {
				const typed = draft as "private" | "released";
				await saveFields({
					visibility: typed,
					...(typed !== "released" && scheduledRelease !== loadedSchedule
						? { scheduledReleaseAt: scheduledIso }
						: {}),
				});
				if (typed === "released") setScheduledRelease("");
			}}
		/>
	);

	const originalDateField = (
		<InlineField<string>
			label="Original release date"
			saved={originalDate}
			renderRead={() => (
				<p className="text-sm text-base-content/60">
					<CalendarIcon className="mr-1 inline size-4" />
					{originalDate
						? `First released ${formatOriginallyReleased(`${originalDate}T00:00:00.000Z`)}`
						: "No original release date — it came out here first."}
				</p>
			)}
			renderEdit={(draft, setDraft) => (
				<div>
					<label className="text-sm" htmlFor="owner-original-release">
						Original Release Date
					</label>
					<input
						id="owner-original-release"
						type="date"
						aria-label="Original release date"
						className="input input-bordered input-sm"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
					/>
					<p className="text-xs text-base-content/40">
						When this first came out anywhere, if it was somewhere else first. Leave it empty if
						this is its first release. If you only know the year, pick a date in it.
					</p>
				</div>
			)}
			save={(draft) => saveFields({ originallyReleased: draft ? `${draft}T00:00:00.000Z` : null })}
		/>
	);

	const creditsField = (
		<InlineField<WorkCredit[]>
			label="Credits"
			saved={creditRows}
			renderRead={(() => {
				const shown: WorkDetail = { ...asRead, credits: creditRows };
				return () => <WorkCredits work={shown} />;
			})()}
			renderEdit={(draft, setDraft) => (
				<CreditsSection
					rows={draft}
					onChange={setDraft}
					showErrors={showCreditErrors}
					selfIdentity={
						user
							? { did: user.atprotoDid, handle: user.handle, displayName: user.displayName }
							: null
					}
				/>
			)}
			save={async (draft) => {
				if (draft.some((r) => r.types.includes("created") && r.contributor.trim() === "")) {
					setShowCreditErrors(true);
					throw new Error("Every Created credit names its contributor before this can save.");
				}
				const rows = draft
					.map((r) => ({
						role: r.role.trim(),
						contributor: r.types.includes("created") ? r.contributor.trim() : "",
						types: r.types,
					}))
					// A credit asserts SOMETHING — an untyped row is not a credit and cannot save.
					.filter((r) => r.types.length > 0);
				await saveFields({ credits: rows });
			}}
		/>
	);

	const accessField = (
		<InlineField<AccessRowDraft[]>
			label="Access"
			saved={accessRows}
			renderRead={() => (
				<AccessSummary publicAccess={publicAccessNow} anyoneAllowed={anyoneAllowed} />
			)}
			renderEdit={(draft, setDraft) => (
				<div>
					<AccessTables rows={draft} onRowsChange={setDraft} />
					<DeliverySwitches
						streamEnabled={streamEnabled}
						downloadEnabled={downloadEnabled}
						onStream={setStreamEnabled}
						onDownload={setDownloadEnabled}
					/>
					{accessRows.length === 1 && (
						<p className="text-xs text-base-content/50">
							Want to gate this by monthly support?{" "}
							<Link to={studioUrl("/settings")} className="link">
								Add Badge rungs in Settings
							</Link>
							.
						</p>
					)}
				</div>
			)}
			save={async (draft) => {
				await saveFields({
					streamEnabled,
					downloadEnabled,
					access: serializeAccessRows(draft),
				});
			}}
		/>
	);

	const ratingField = (
		<InlineField<MaturityRows>
			label="Rating"
			saved={rows}
			renderRead={() => (
				<RatingSummary
					maturity={maturity}
					notes={contentNotes}
					incomplete={!!storedMaturity && !fromRows}
				/>
			)}
			renderEdit={(draft, setDraft) => (
				<div className="flex flex-col gap-3">
					<RatingMatrix grid={grid} rows={draft} onChange={setDraft} />
					{maturityLocked && (
						<div className="alert alert-info text-sm">
							<span>
								An operator set this rating. You can make it more cautious at any time — to lower
								it, appeal below and tell us why.
							</span>
						</div>
					)}
					{maturityLocked && (
						<RatingAppeal workId={current.id} corrected={current.maturity ?? "mature"} />
					)}
				</div>
			)}
			save={async (draft) => {
				const changed =
					JSON.stringify(normalizeMaturityRows(draft, grid)) !==
					JSON.stringify(normalizeMaturityRows(rows, grid));
				// Sent unchanged, they re-declare the rating they add up to, which an
				// operator's correction refuses — closing without a save is the honest exit.
				if (!changed) return;
				await saveFields({ maturityRows: normalizeMaturityRows(draft, grid) });
			}}
		/>
	);

	const accessibilityField = (
		<InlineField
			label="Accessibility"
			saved={current.captions ?? []}
			renderRead={() => <CaptionsSummary captions={current.captions ?? []} />}
			renderEdit={() => (
				<WorkCaptionsEditor
					workId={current.id}
					captions={current.captions ?? []}
					onChanged={() => void refreshMedia()}
				/>
			)}
			save={async () => {
				/* The caption editor manages its own acts; the check closes the field. */
			}}
		/>
	);

	const detailsSection = (
		<div className="flex flex-col gap-5">
			{kindChangeable && (
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">Kind</span>
					<select
						aria-label="Work kind"
						className="select select-sm select-bordered"
						value={work.type}
						onChange={(e) => void saveKind(e.target.value as UploadableWorkType)}
					>
						{LIBRARY_TYPE_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
					<span className="text-xs text-base-content/60">
						Changing the kind unrates the draft — answer the matrix again before release.
					</span>
				</div>
			)}
			{thumbnailField}
			{descriptionField}
			{releaseField}
			{originalDateField}
		</div>
	);

	const infoTabs: InfoTab[] = [
		{ key: "details", label: "Details", content: detailsSection },
		{ key: "credits", label: "Credits", content: creditsField },
		{ key: "access", label: "Access", content: accessField },
		{ key: "rating", label: "Rating", content: ratingField },
		{ key: "accessibility", label: "Accessibility", content: accessibilityField },
	];

	// The changing-kind save — the row's kind is page-resolved in the batch editor; here
	// the select saves at once and the row answers (the server rules govern; it may refuse).
	const saveKind = async (next: UploadableWorkType) => {
		if (next === work.type) return;
		try {
			await saveFields({ type: next });
		} catch (err) {
			setError(err instanceof Error ? err.message : "The kind change didn't save.");
			// A refused change stands where it was — the next save re-syncs the select.
			await onRefetch?.();
		}
	};

	const sideTabs = [
		{
			key: "reviews",
			label: "Reviews",
			content: <WorkReviews workId={current.id} />,
		},
		{
			key: "showings",
			label: "Showings",
			content: <ShowingsStub work={current} />,
		},
	];

	return (
		<WorkColumn type={work.type} wide>
			<EditingBanner title={current.title} />

			{/* ── Row 1: the header, and the Media Status card in the space beside it ── */}
			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
				<WorkHeader
					work={asRead}
					title={
						<InlineField<string>
							label="Title"
							saved={title}
							className="w-full min-w-0"
							renderRead={() => (
								<h1
									className={`${workTitleTypography(work.type).className} truncate`}
									style={workTitleTypography(work.type).style}
								>
									{title || "Untitled"}
								</h1>
							)}
							renderEdit={(draft, setDraft) => (
								<textarea
									aria-label="Title"
									rows={1}
									className={`${workTitleTypography(work.type).className} ${IN_PLACE} ${GROWS} w-full min-w-0 flex-1`}
									style={workTitleTypography(work.type).style}
									value={draft}
									onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
									onKeyDown={(e) => {
										if (e.key === "Enter") e.preventDefault();
									}}
									placeholder="Work title"
								/>
							)}
							save={(draft) => saveFields({ title: draft.trim() || "Untitled" })}
						/>
					}
					dates={
						<HeaderDates
							originally={formatOriginallyReleased(current.originallyReleased)}
							released={
								current.releasedAt
									? new Date(current.releasedAt).toLocaleDateString("en-US", {
											month: "long",
											day: "numeric",
											year: "numeric",
										})
									: null
							}
						/>
					}
					rating={
						<RatingLineInHeader
							maturity={maturity}
							notes={contentNotes}
							onChangeTo={() => setActiveInfoTab("rating")}
						/>
					}
				/>

				<MediaStatusCard
					work={asRead}
					sourceUpload={sourceUpload}
					unpublished={unpublished}
					cancelBusy={cancelBusy}
					removeBusy={removalBusy}
					onCancel={() => void cancelProcessing()}
					onRemove={() => void removeMedia()}
					onReplaceFile={(file) =>
						workUploads.start(current.id, file, { kind: "source", type: "video" })
					}
					onRetry={() => {
						if (sourceUpload) workUploads.retry(sourceUpload.id);
					}}
				/>
			</div>

			{/* ── Row 2: the Work itself, full width ── */}
			<section>
				<WorkDeliverable work={asRead} videoRef={videoEl} />
				{!current.sourceKey && (
					<p className="text-sm text-base-content/60">
						This Work has no file yet — the Media Status card, above, takes one.
					</p>
				)}
			</section>

			{/* ── Row 3: the two columns — Info tabs, Reviews and Showings ── */}
			<div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
				<WorkInfoTabs tabs={infoTabs} activeKey={activeInfoTab} onActiveChange={setActiveInfoTab} />
				<WorkSideColumn tabs={sideTabs} work={current} />
			</div>

			{error && <p className="text-sm text-error">{error}</p>}
		</WorkColumn>
	);
}

/* ── The read views and small controls the tabs and header use ─────────────── */

/** The header's dates slot, owner mode: the saved dates as a user reads them. */
function HeaderDates({
	originally,
	released,
}: {
	originally: string | null;
	released: string | null;
}) {
	return (
		<div className="flex flex-wrap items-center gap-4 text-sm text-base-content/60">
			{originally && (
				<span className="flex items-center gap-1">
					<CalendarIcon className="size-4" />
					First released {originally}
				</span>
			)}
			{released && <span>Released {released}</span>}
		</div>
	);
}

/**
 * The rating where a user meets it — the header's version, whose *Change* opens the
 * Rating tab rather than scrolling to a form that no longer exists down-page.
 */
function RatingLineInHeader({
	maturity,
	notes,
	onChangeTo,
}: {
	maturity: Exclude<MaturityRating, "unrated"> | null;
	notes: ContentNote[];
	onChangeTo: () => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			{maturity ? (
				<span
					className={`badge badge-sm ${
						maturity === "general"
							? "badge-ghost"
							: maturity === "adult"
								? "badge-error"
								: "badge-warning"
					}`}
				>
					{maturityLabel(maturity)}
				</span>
			) : (
				<span className="badge badge-sm badge-warning badge-outline">Not rated yet</span>
			)}
			{maturity && maturity !== "general" && notes.length > 0 && (
				<span className="text-base-content/60">{notes.map(contentNoteLabel).join(" · ")}</span>
			)}
			{maturity === "general" && (
				<span className="text-xs text-base-content/50">Users see no rating on a General Work.</span>
			)}
			<button type="button" className="link link-hover text-xs" onClick={onChangeTo}>
				{maturity ? "Change" : "Rate it"}
			</button>
		</div>
	);
}

/**
 * The thumbnail's edit state: the upload and the paused-frame act are what the edit IS.
 * The check stays disabled until one settles — and the field read state shows the settled
 * (or first) value, so a saved thumbnail vanishes from here the moment it lands.
 */
function ThumbEditor({
	preview,
	required,
	onFile,
	onClear,
	onFrame,
	frameBusy,
	inFlight,
	frameError,
}: {
	preview: string | null;
	required?: boolean;
	onFile: (file: File) => void;
	onClear: () => void;
	onFrame?: () => void;
	frameBusy: boolean;
	inFlight: boolean;
	frameError: string | null;
}) {
	return (
		<div className="flex flex-wrap items-start gap-4">
			<div className="w-48 flex flex-col gap-2">
				<FileUpload
					accept="image/*"
					maxSize={10 * 1024 * 1024}
					preview={preview}
					label="Upload a thumbnail"
					compact
					onFileSelect={onFile}
					onClear={onClear}
				/>
				{onFrame && (
					<button
						type="button"
						className="btn btn-outline btn-sm"
						onClick={onFrame}
						disabled={frameBusy || inFlight}
					>
						{frameBusy ? "Taking this moment…" : "Use This Frame"}
					</button>
				)}
				{inFlight && <p className="text-xs text-base-content/60">The image is uploading…</p>}
			</div>
			{frameError && <p className="w-full text-xs text-warning">{frameError}</p>}
		</div>
	);
}

/** The release read view: the row's status, said as a status rather than a control. */
export function ReleaseSummary({ work, scheduled }: { work: WorkDetail; scheduled: string | null }) {
	const released = work.releasedAt
		? new Date(work.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;
	const scheduledAt = scheduled
		? new Date(scheduled).toLocaleString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})
		: null;
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span
				className={`badge badge-sm ${work.visibility === "released" ? "badge-success" : "badge-ghost"}`}
			>
				{work.visibility === "released" ? "Released" : "Private"}
			</span>
			{released && <span className="text-base-content/60">released {released}</span>}
			{!released && scheduledAt && (
				<span className="text-base-content/60">scheduled for {scheduledAt}</span>
			)}
		</div>
	);
}

/** The delivery switches, inside the Access field's edit state. */
function DeliverySwitches({
	streamEnabled,
	downloadEnabled,
	onStream,
	onDownload,
}: {
	streamEnabled: boolean;
	downloadEnabled: boolean;
	onStream: (next: boolean) => void;
	onDownload: (next: boolean) => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap gap-4">
				<label className="label cursor-pointer justify-start gap-2">
					<input
						type="checkbox"
						className="checkbox checkbox-sm"
						checked={streamEnabled}
						// A Work must keep at least one way to be consumed; the server enforces it
						// against the resulting state, so don't offer the click that fails.
						disabled={streamEnabled && !downloadEnabled}
						onChange={(e) => onStream(e.target.checked)}
					/>
					<span className="label-text text-sm">Stream</span>
				</label>
				<label className="label cursor-pointer justify-start gap-2">
					<input
						type="checkbox"
						className="checkbox checkbox-sm"
						checked={downloadEnabled}
						disabled={downloadEnabled && !streamEnabled}
						onChange={(e) => onDownload(e.target.checked)}
					/>
					<span className="label-text text-sm">Download</span>
				</label>
			</div>
			<p className="text-xs text-base-content/50">
				At least one is required. Only streaming work can be Public Access — downloads are paid for
				by whoever bought or unlocked them.
			</p>
		</div>
	);
}

/** The access read view — what being able to open this Work means, in a line. */
export function AccessSummary({
	publicAccess,
	anyoneAllowed,
}: {
	publicAccess: boolean;
	anyoneAllowed: boolean;
}) {
	if (publicAccess) {
		return (
			<p className="text-sm">
				<span className="badge badge-sm badge-success badge-outline mr-2">Public Access</span>
				Free to everyone, and earning from the Time Pool.
			</p>
		);
	}
	if (anyoneAllowed) {
		return (
			<p className="text-sm text-base-content/60">
				Free is off. The Access table decides who pays what.
			</p>
		);
	}
	return (
		<p className="text-sm text-base-content/60">Nobody can open this yet — allow someone in.</p>
	);
}

/** The rating read view: the badge (or the answered state) as a user meets it. */
function RatingSummary({
	maturity,
	notes,
	incomplete,
}: {
	maturity: Exclude<MaturityRating, "unrated"> | null;
	notes: ContentNote[];
	incomplete: boolean;
}) {
	if (incomplete) {
		return (
			<p className="text-sm text-base-content/60">
				A rating exists on this Work, but not every row of its matrix is answered — answering every
				row replaces it with the rating the rows add up to.
			</p>
		);
	}
	if (!maturity) {
		return (
			<p className="text-sm text-warning">
				Not rated yet — nothing releases until every row has an answer.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span
				className={`badge badge-sm ${
					maturity === "general"
						? "badge-ghost"
						: maturity === "adult"
							? "badge-error"
							: "badge-warning"
				}`}
			>
				{maturityLabel(maturity)}
			</span>
			{maturity !== "general" && notes.length > 0 && (
				<span className="text-base-content/60">{notes.map(contentNoteLabel).join(" · ")}</span>
			)}
			{maturity === "general" && (
				<span className="text-xs text-base-content/50">Users see no rating on a General Work.</span>
			)}
		</div>
	);
}

/** The accessibility read view: the caption tracks, said as what a viewer can turn on. */
export function CaptionsSummary({
	captions,
}: {
	captions: Array<{ label: string | null; language: string }>;
}) {
	if (captions.length === 0) {
		return <p className="text-sm text-base-content/60">No caption tracks yet.</p>;
	}
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span className="badge badge-sm badge-ghost mr-2">CC</span>
			<span className="text-base-content/60">
				Closed captions in {captions.map((c) => c.label || c.language).join(", ")}.
			</span>
		</div>
	);
}
