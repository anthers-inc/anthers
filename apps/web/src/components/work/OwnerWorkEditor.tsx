// SPDX-License-Identifier: Apache-2.0
/**
 * A **Work's editing surface, on the Work's own page** — the unified layout Parker
 * set in motion 2026-10-13 and propagated to every kind on 2026-10-14: the creator
 * and any user see the SAME page, and the creator's edit controls live inline in
 * the very places the user sees the result.
 *
 * ⭐ **The Studio ends at the Works list.** Editing one Work happens on its page, which is
 * a place users can see; the only things here a user never sees are the things carried in
 * styling that says so — the editing banner, the pencils, the working tables inside a
 * field's edit state, and the Media Status card.
 *
 * Below the deliverable the page is two columns: the left is the **Info tab group**
 * (Details · Credits · Rating · Accessibility) shared with the user's rendering
 * of the same page (`WorkInfoTabs`), the right is **Manage · Reviews · Showings**
 * (`WorkSideColumn`) — Manage first and active by default on the creator's own page
 * (Parker, 2026-10-16), and a visitor's column never renders it. Each editable thing the
 * user can see is an `InlineField` — pencil opens it, X cancels, checkmark saves the
 * field alone; there is no page-wide Save.
 *
 * ⭐ **The pencils are always visible, and the Rating tab is no pencil's** (Parker,
 * 2026-10-16). Hover-reveal was retired because an unfilled field left nothing to hover
 * for it; every field now renders its full structure at any value, so the pencil sits in
 * the open. The Rating tab is its own exception for a structural reason: the table is the
 * field, it saves as one act, and it is always open — see `studio/RatingMatrix.tsx`.
 *
 * The deliverable is whatever the kind is: a rendered medium through `WorkDeliverable`,
 * or the store through `ProjectPricing` for the goods kinds, exactly where every user
 * meets the same Work — the creator's copy is that view with pencils in it. The one
 * place the kinds legitimately differ is the **Manage tab**, which carries each kind's
 * own machinery: a video's or an audio Work's media status and thumbnail, a comic's page
 * set, a game's builds and embed, a good's fulfillment details, a writing's body.
 *
 * ⚠️ **Saves are narrow, one field per request, and adopt the response.** The server's
 * own rules (release gates, the rating re-declaration refusal, the media floors) are the
 * authority and answer in their own words; a field's error shows where the field lives —
 * which is what the batch bar's one shared error string could never do. The two deliberate
 * carries from the batch editor: a save NEVER sends `sourceKey`, and the thumbnail is
 * sent only from its settled value (the race into work 23's lost thumbnail).
 */

import {
	deliverableIsEmpty,
	embedUrlProblem,
	isEmptyWriting,
	isListened,
	isOwnThumbnail,
	isPaged,
	supportsPreviewMedia,
} from "@anthers/shared/content";
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
import { normalizeWorkTags } from "@anthers/shared/tags";
import { useAuth } from "@anthers/web-shared/auth";
import RatingAppeal from "@anthers/web-shared/content/RatingAppeal";
import { RELEASE_FIELD_HINT } from "@anthers/web-shared/content/release-date";
import WebBuildSection from "@anthers/web-shared/content/WorkWebBuildSection";
import {
	type FileWorkType,
	isFileWorkType,
	WorkFileDropzone,
	WorkFileSection,
	WorkTypeFacts,
} from "@anthers/web-shared/content/work-media";
import { isBuildType, LIBRARY_TYPE_OPTIONS, typeLabel } from "@anthers/web-shared/content/works";
import RichTextEditor from "@anthers/web-shared/editor/RichTextEditor";
import {
	isoToLocalInput,
	localInputToIso,
	nowLocalInput,
} from "@anthers/web-shared/local-datetime";
import TranscodingStatus from "@anthers/web-shared/media/TranscodingStatus";
import { usePayoutsReady } from "@anthers/web-shared/payouts";
import AccessTables, {
	type AccessRowDraft,
	buildAccessRows,
	serializeAccessRows,
} from "@anthers/web-shared/post/AccessTables";
import {
	frameImageFile,
	keyToPreview,
	uploadImageFile,
} from "@anthers/web-shared/post/mediaUpload";
import { profileUrl } from "@anthers/web-shared/profile";
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
import ImageEditMenu from "@anthers/web-shared/ui/ImageEditMenu";
import ImageFrameModal from "@anthers/web-shared/ui/ImageFrameModal";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import { uploadMediaFile } from "@anthers/web-shared/upload";
import { useWebBuildUploads } from "@anthers/web-shared/web-build-uploads";
import {
	isUploading,
	useSourceUpload,
	useWorkUploads,
	workUploads,
} from "@anthers/web-shared/work-uploads";
import {
	ExclamationTriangleIcon,
	PencilSquareIcon,
	PhotoIcon,
	TrashIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import CreditsSection from "../../studio/CreditsSection";
import PanelEditor from "../../studio/PanelEditor";
import RatingMatrix from "../../studio/RatingMatrix";
import WorkCaptionsEditor from "../../studio/WorkCaptionsEditor";
import SaveButton from "../library/SaveButton";
import ProjectPricing from "../project/ProjectPricing";
import WorkReviews from "../project/WorkReviews";
import { InlineField } from "./Editing";
import { LyricsBody } from "./LyricsPanel";
import MediaStatusCard from "./MediaStatusCard";
import PreviewMediaSection from "./PreviewMediaSection";
import ShareLinkButton from "./ShareLinkButton";
import { WorkViewAsSection } from "./ViewAs";
import WorkInfoTabs, { type InfoTab } from "./WorkInfoTabs";
import {
	DescriptionBody,
	formatOriginallyReleased,
	isGoods,
	isWriting,
	WORK_DESCRIPTION_CLASS,
	WORK_DETAILS_HEADING_CLASS,
	WORK_LYRICS_CLASS,
	WorkByline,
	WorkColumn,
	WorkCredits,
	WorkDeliverable,
	WorkDescription,
	type WorkDetail,
	WorkPlaceholder,
	workTitleTypography,
} from "./WorkLayout";
import WorkMediaFrame from "./WorkMediaFrame";
import WorkMediaManager, { type MediaManagerTab } from "./WorkMediaManager";
import WorkSideColumn, { ShowingsStub } from "./WorkSideColumn";
import { WorkTagChips, WorkTagPicker } from "./WorkTags";
import WorkVersionsSection from "./WorkVersionsSection";

const IN_PLACE =
	"rounded-md border border-transparent bg-transparent px-2 -mx-2 hover:border-base-300 focus:border-primary focus:outline-none";

/** The in-place style a control gets while it is EMPTY — a placeholder in an invisible
 * field would read as stray text on the page, so an empty control carries a quiet border
 * that says a field is here. */
const IN_PLACE_EMPTY =
	"rounded-md border border-base-300 bg-transparent px-2 -mx-2 hover:border-primary/40 focus:border-primary focus:outline-none placeholder:text-base-content/40";

/** A text area that grows with what is in it, the way the text it stands in for would. */
const GROWS = "resize-none [field-sizing:content]";

/**
 * The Original Release Date explainer, on the (i) beside its label (Parker, 2026-10-23).
 * It was printed under the input until the field's own control needed the room.
 */
const ORIGINAL_RELEASE_HINT =
	"When this first came out anywhere, if it was somewhere else first. Leave it empty if this is its first release. If you only know the year, pick a date in it.";

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
	// The Work's tags — the same list the Details tab shows a reader, edited in place.
	const [tags, setTags] = useState<string[]>(work.tags ?? []);
	// A piece of writing's body, written in place in the typography it is read in. The
	// plain-text shadow goes with it, as it does from the post editor, because search
	// reads that one.
	const writing = isWriting(current.type);
	const [bodyHtml, setBodyHtml] = useState(work.bodyHtml ?? "");
	const [bodyText, setBodyText] = useState(work.body ?? "");
	// A song's words, edited on the panel the user reads them on.
	const [lyrics, setLyrics] = useState(work.lyrics ?? "");
	// The image an image Work is — the description its picture announces to a screen
	// reader. Empty keeps the reader's title fallback, and sending it unconditionally on
	// an image Work (including empty) means clearing it is a real edit, as with lyrics.
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
		normalizeMaturityRows(work.maturityRows, gridFor(current.type)),
	);
	const grid = gridFor(current.type);
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

	// The Rating tab IS the matrix, always visible and always answering (Parker, 2026-10-16,
	// replacing the hover-in pencil field, whose read view could not show a table that did
	// not exist yet): the draft rides the saved rows the credits' way — a save adopts the
	// response, and the sync clears the tab's own dirty bar underneath it.
	const [ratingDraft, setRatingDraft] = useState<MaturityRows>(rows);
	useEffect(() => setRatingDraft(rows), [rows]);
	const ratingNext = normalizeMaturityRows(ratingDraft, grid);
	const ratingDirty =
		JSON.stringify(ratingNext) !== JSON.stringify(normalizeMaturityRows(rows, grid));
	const [ratingSaving, setRatingSaving] = useState(false);
	const [ratingError, setRatingError] = useState<string | null>(null);
	const saveRating = async () => {
		if (ratingSaving) return;
		setRatingSaving(true);
		setRatingError(null);
		const changed =
			JSON.stringify(ratingNext) !== JSON.stringify(normalizeMaturityRows(rows, grid));
		if (!changed) {
			// Sent unchanged, they re-declare the rating they add up to, which an operator's
			// correction refuses — an unchanged save returns the tab to its read instead.
			setRatingSaving(false);
			return;
		}
		try {
			await saveFields({ maturityRows: ratingNext });
			setRows(ratingNext);
		} catch (err) {
			setRatingError(err instanceof Error ? err.message : "Couldn't save the rating just now.");
		} finally {
			setRatingSaving(false);
		}
	};

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
	// A save's (or a decision's) answer is what the page now shows: the editor's rows
	// follow the row rather than arguing with it. Safe while an edit is open too — the
	// InlineField copies the saved value into its own draft at open time, so a re-sync
	// never reaches into a control somebody is typing in.
	useEffect(() => {
		setCreditRows((current.credits ?? []).map((r) => ({ ...r, types: [...r.types] })));
	}, [current.credits]);

	const [error, setError] = useState<string | null>(null);
	/** Whether the media area is showing its management surface instead of the medium. */
	const [mediaManaging, setMediaManaging] = useState(false);
	/** The management tab the card opens on; the manager falls back if a type lacks it. */
	const [mediaTab, setMediaTab] = useState("delivery");
	/** Whether the frame picker (a video's paused moment) is open. */
	const [thumbPicker, setThumbPicker] = useState<"none" | "frame">("none");
	/**
	 * The framing dialog: a file the creator just chose, or the full source behind the
	 * stored thumbnail. `source` is null while a new file is still local.
	 */
	const [thumbFrame, setThumbFrame] = useState<{
		preview: string;
		file: File | null;
		source: string | null;
	} | null>(null);
	const thumbInput = useRef<HTMLInputElement>(null);
	/** A render-visible twin of `thumbnailInFlight`, which is a ref for the timer reads. */
	const [thumbSaving, setThumbSaving] = useState(false);
	/** Whether the upload failed, said beside the thumbnail and inside the upload modal. */
	const [thumbError, setThumbError] = useState<string | null>(null);
	/** Which Info tab is open — lifted, because the header's *Change* rating link opens Rating. */
	const [activeInfoTab, setActiveInfoTab] = useState("details");

	/**
	 * The Release field's draft, as the datetime input holds it: the Work's own release
	 * instant when it is out, its schedule when one is set, and empty when it is neither.
	 * One field carries all three states, so `releaseField`'s save reads the draft to decide
	 * which act it is (Parker, 2026-10-23).
	 */
	const releaseSaved = isoToLocalInput(
		current.visibility === "released"
			? (current.releasedAt ?? current.scheduledReleaseAt)
			: current.scheduledReleaseAt,
	);

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

	/** Save a delivery switch from the manager; a refusal stands the switches back. */
	const saveDelivery = async (stream: boolean, download: boolean): Promise<void> => {
		const priorStream = streamEnabled;
		const priorDownload = downloadEnabled;
		setStreamEnabled(stream);
		setDownloadEnabled(download);
		try {
			await saveFields({ streamEnabled: stream, downloadEnabled: download });
		} catch (err) {
			setStreamEnabled(priorStream);
			setDownloadEnabled(priorDownload);
			setError(err instanceof Error ? err.message : "The delivery change didn't save.");
		}
	};

	// ── The Work's file: the media half of the row re-read as it changes under us ──
	const sourceUpload = useSourceUpload(current.id);
	const fileUploading = sourceUpload != null && isUploading(sourceUpload);
	/**
	 * An upload landing re-reads the media half of the row — the file attach is a
	 * separate request whose answer arrives under nobody's cursor, and nothing typed
	 * should be touched on the way (the Studio editor's landed/readAfter counter,
	 * carried whole but simpler: per-field saves own the typed fields here). The
	 * store keeps a settled upload's entry, so each settled id fires once.
	 */
	const uploads = useWorkUploads().filter((u) => u.workId === current.id);
	const landedSeen = useRef<Set<string>>(new Set());
	const landedNow = uploads.filter((u) => u.status === "done" && !landedSeen.current.has(u.id));
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires on a landing, and only then
	useEffect(() => {
		if (landedNow.length === 0) return;
		for (const u of landedNow) landedSeen.current.add(u.id);
		void refreshMedia();
	}, [uploads]);

	// A hosted build started from the media area lands the same way, one file list at a time.
	const webBuilds = useWebBuildUploads().filter((u) => u.workId === current.id);
	const webBuildsLandedSeen = useRef<Set<string>>(new Set());
	const webBuildsLanded = webBuilds.filter(
		(u) => u.status === "done" && !webBuildsLandedSeen.current.has(u.id),
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires on a landing, and only then
	useEffect(() => {
		if (webBuildsLanded.length === 0) return;
		for (const u of webBuildsLanded) webBuildsLandedSeen.current.add(u.id);
		void refreshMedia();
	}, [webBuilds]);

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
	/**
	 * A chosen file or a repositioned stored image both arrive as a crop window; the act
	 * uploads the source when it is new, lets the server frame it at 16:9, and saves the
	 * derivative beside its full source. The settled-value guard (`thumbnailInFlight`)
	 * blocks the row save until that answers — the same race the batch editor lost
	 * (work 23's lost thumbnail).
	 */
	const closeThumbFrame = () => {
		if (thumbFrame?.file) URL.revokeObjectURL(thumbFrame.preview);
		setThumbFrame(null);
	};

	const thumbPicked = (file: File) => {
		setThumbError(null);
		setThumbFrame({ preview: URL.createObjectURL(file), file, source: null });
	};

	const startThumbReposition = () => {
		const source = keyToPreview(current.thumbnailSource || thumbnailUrl);
		if (!source) return;
		setThumbError(null);
		setThumbFrame({ preview: source, file: null, source });
	};

	const saveFramedThumbnail = async (crop: {
		x: number;
		y: number;
		width: number;
		height: number;
	}) => {
		if (!thumbFrame) return;
		thumbnailTouched.current = true;
		thumbnailInFlight.current += 1;
		setThumbSaving(true);
		setThumbError(null);
		try {
			const source = thumbFrame.file
				? (await uploadImageFile(thumbFrame.file, "thumbnail")).url
				: thumbFrame.source;
			if (!source) throw new Error("That image isn't available any more. Upload it again.");
			const { url } = await frameImageFile(source, "thumbnail", crop);
			setThumbnailUrl(url);
			setThumbnailPreview(url);
			await saveFields({ thumbnail: url, thumbnailSource: source, thumbnailCrop: crop });
			thumbnailTouched.current = false;
			closeThumbFrame();
		} catch (err) {
			setThumbnailPreview(thumbnailUrl ? keyToPreview(thumbnailUrl) : null);
			if (!thumbnailUrl) thumbnailTouched.current = false;
			setThumbError(
				err instanceof Error && err.message
					? err.message
					: "The image didn't make it up. Try again.",
			);
		} finally {
			thumbnailInFlight.current -= 1;
			setThumbSaving(false);
		}
	};

	/**
	 * Store the frame the picker's player is paused on as the thumbnail — the SERVER
	 * extracts it, so the answering route is the save (one act, no client upload in
	 * flight). The picker carries its own player: any moment of the original, seekable
	 * in the modal, is what the route saves.
	 */
	const takeCurrentFrame = async (video: HTMLVideoElement | null): Promise<boolean> => {
		setFrameError(null);
		if (!video?.videoWidth) {
			setFrameError("Play the video to the moment you want first.");
			return false;
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
				return false;
			}
			const { work: updated } = (await res.json()) as { work: Work };
			adopt(updated);
			thumbnailTouched.current = false;
			thumbnailInFlight.current = 0;
			if (updated.thumbnail) {
				setThumbnailUrl(updated.thumbnail);
				setThumbnailPreview(keyToPreview(updated.thumbnail));
			}
			return true;
		} catch {
			setFrameError("Taking the frame didn't work. Upload an image instead.");
			return false;
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
	 *  nothing of its own is still arriving. A video plays its original before the ladder
	 *  (the 2026-10-10/11 delivery ruling), and since 2026-10-16 a track does the same
	 *  while its MP3 and waveform process — so neither gates here; what stands in the
	 *  deliverable's place while the Work's own shape has not arrived is `kindWaiting`
	 *  below, which the paged kinds (pages, the reflow reader) still read. The retired
	 *  batch editor's "audio and ebooks keep the completed gate" reasoning died with the
	 *  move, its premise having never considered the original as the deliverable. */
	const fileReady = isFileWorkType(current.type) && !!current.sourceKey && !fileUploading;
	/** The frame picker can open: only a video has frames to take, and only its original
	 *  file (the picker's own player plays that) answers a frame's moment. */
	const frameChoosable = current.type === "video" && fileReady && !!current.originalUrl;

	// ── Release: the facts each control waits on (the batch editor's predicates, against the page as it stands) ──
	const unpublished = !current.releasedAt && current.visibility !== "withdrawn";
	const anyoneAllowed = accessRows.some((r) => r.allow);
	const baselineRow = accessRows.find((r) => r.threshold === 0);
	const publicAccessNow = !!baselineRow?.allow && Number(baselineRow.price) === 0 && streamEnabled;
	const fileMissing = isFileWorkType(current.type) && (!current.sourceKey || fileUploading);
	// And the same for a piece of writing with nothing in it yet (`text_missing`), the
	// server's own word for it — the creator's to fix rather than to wait for.
	const writingEmpty = writing && isEmptyWriting(bodyHtml);
	const creditsMissing = !creditRows.some((r) => r.types.includes("created"));
	/**
	 * The first thing that would refuse a release-now, in the server's own order — the notices
	 * below say each one in full, and this short form rides the checkmark's tooltip while it
	 * waits. A schedule is still offered while these stand, as the batch editor's rule had it.
	 */
	const releaseNowRefusal =
		payoutsReady === false
			? "Set up payouts before releasing — the notice below says where."
			: permissionMissing === true
				? "Give Anthers permission to publish before releasing — the notice below says where."
				: fileMissing
					? "This Work's file has to arrive before it can be released."
					: writingEmpty
						? "This piece of writing is empty."
						: !fromRows
							? "Answer every row of the Rating first — every row, no exceptions."
							: creditsMissing
								? "Credit at least one person as Created before releasing."
								: undefined;

	// ── The Info tabs' contents ──
	/**
	 * Whether the Work itself is still forming — its file is in and processing, and
	 * nothing the player can carry exists yet — so the processing block stands in the
	 * deliverable's place. A video is out (it plays its original before the ladder, the
	 * 2026-10-10/11 ruling), and since 2026-10-16 the listened kinds are out too: a
	 * track under processing plays its own original. What remains is the paged and
	 * written kinds, whose processing products — page images, the reflow reader —
	 * genuinely do not exist until the job finishes.
	 */
	const kindWaiting =
		running && current.type !== "video" && current.type !== "image" && !isListened(current.type);
	/**
	 * Whether the deliverable's place is empty — a draft before its medium exists — so
	 * the silhouette can hold it. The predicate is shared with the user's Record, which
	 * asks the same question of the same Work when the owner previews it (the no-file
	 * preview must show the same box the editor does, Parker, 2026-10-17); only the
	 * in-flight upload is the editor's own knowledge, and only a writing's live draft
	 * body is — the creator is typing the body this page saves.
	 */
	const deliverableEmpty =
		fileUploading || deliverableIsEmpty(writing ? { ...current, bodyHtml } : current);
	/**
	 * Whether the empty box is itself the intake — every media kind now, not only the
	 * single-file ones. The paged kinds' set editor and the build kinds' embed/builds
	 * moved into the box (Parker, 2026-10-23), so the act of filling the Work happens
	 * where the Work will be. A writing's body and a good's details are page-level
	 * fields and stay on the Manage tab; the box simply names that.
	 */
	const deliverableIntake = !writing && !isGoods(current.type);
	/**
	 * The silhouette's note, said per kind — what fills the box, and where. The intake's
	 * own controls say what to do, so a media Work's note is silent; an upload in flight
	 * says so, and the two kinds without an intake point at the Manage tab.
	 */
	const deliverableNote = writing
		? "Its Manage tab is where the pen is."
		: fileUploading
			? "It's uploading now — keep this tab open until it lands."
			: "";
	/** The kind, while a private draft could still be another kind. */
	const kindChangeable =
		current.visibility !== "released" &&
		!current.sourceKey &&
		!current.embedUrl &&
		!fileUploading &&
		// A piece of writing is its body, on the page as on the row: prose typed here
		// that a save would send counts as existing, and a kind cannot change from
		// under it (the batch editor's rule, binding here identically).
		!(writing && !isEmptyWriting(bodyHtml)) &&
		!current.body;

	const asRead: WorkDetail = {
		...current,
		// The image's deliverable reads its key as an address, as the Studio editor's row did.
		sourceKey:
			current.type === "image" && current.sourceKey
				? keyToPreview(current.sourceKey)
				: current.sourceKey,
		gallery: current.type === "image" ? (current.gallery ?? []).map(keyToPreview) : undefined,
		thumbnail: thumbnailPreview ?? current.thumbnail,
		creator: user?.handle
			? {
					handle: user.handle,
					displayName: user.displayName ?? null,
					avatar: user.avatar ?? null,
					bio: user.bio ?? null,
				}
			: current.creator,
	};

	const thumbnailField = (
		<div className="flex flex-wrap items-start gap-4">
			{thumbnailPreview ? (
				<img
					src={thumbnailPreview}
					alt="The Work's thumbnail"
					className="w-40 aspect-video rounded-lg object-cover"
				/>
			) : (
				/* The blank frame the thumbnail fills: a picker's answer or an upload lands
				   here, and until then the empty box says a thumbnail's place (Parker,
				   2026-10-16 — the read state acts, no pencil and no edit state; each
				   button is the act, and each saves the field itself; this pass
				   supersedes the same day's placeholder-over-InlineField shape). */
				<div
					aria-hidden="true"
					className="flex aspect-video w-40 items-center justify-center rounded-lg border border-dashed border-base-content/25 bg-base-200/30 text-base-content/25"
				>
					<PhotoIcon className="h-7 w-7" />
				</div>
			)}
			<div className="flex flex-col gap-2">
				<input
					ref={thumbInput}
					type="file"
					accept="image/*"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						e.target.value = "";
						if (file) thumbPicked(file);
					}}
				/>
				<ImageEditMenu
					label="thumbnail"
					triggerLabel="Edit Thumbnail"
					hasImage={Boolean(thumbnailPreview)}
					busy={thumbSaving}
					onUpload={() => {
						setThumbError(null);
						thumbInput.current?.click();
					}}
					onReposition={startThumbReposition}
					extra={
						frameChoosable
							? {
									label: "Choose from Work",
									onSelect: () => {
										setFrameError(null);
										setThumbPicker("frame");
									},
								}
							: undefined
					}
				/>
			</div>
			{thumbError && <p className="w-full text-xs text-error">{thumbError}</p>}
		</div>
	);

	const descriptionField = (
		<InlineField<string>
			label="Description"
			saved={description}
			renderRead={() => (
				// The same rendering the user's Details tab carries — including the read-more
				// truncation (Parker, 2026-10-16; `whitespace-pre-line` keeps the line breaks
				// the edit textarea wrote) — and, below it, an empty field's note.
				<DescriptionBody description={description} />
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
			save={(draft) => {
				setDescription(draft.trim());
				return saveFields({ description: draft.trim() });
			}}
		/>
	);

	// The Work's tags, below the description in the Details tab. The picker lives only in
	// the edit state, so its directory request fires when the pencil is opened rather than
	// on every page load.
	const tagsField = (
		<InlineField<string[]>
			label="Tags"
			saved={tags}
			renderRead={() => <WorkTagChips tags={tags} />}
			renderEdit={(draft, setDraft) => <WorkTagPicker selected={draft} onChange={setDraft} />}
			save={(draft) => {
				const next = normalizeWorkTags(draft);
				setTags(next);
				return saveFields({ tags: next });
			}}
		/>
	);

	// A song's words — edited where the user reads them: the deliverable's lyrics drawer
	// takes this field, and the read view is the panel the user already sees.
	const lyricsField = (
		// `fill` puts the field in the stage's aside drawer at full height — the words
		// the creator composes are the words the user reads over the waveform.
		<InlineField<string>
			label="Lyrics"
			saved={lyrics}
			fill
			renderRead={() =>
				lyrics ? (
					<LyricsBody lyrics={lyrics} />
				) : (
					<p className="text-sm text-base-content/40">No lyrics written yet.</p>
				)
			}
			renderEdit={(draft, setDraft) => (
				<div>
					<textarea
						aria-label="Lyrics"
						className={`${WORK_LYRICS_CLASS} w-full min-h-32 ${GROWS} whitespace-pre-wrap text-sm`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="Type the song's words…"
					/>
				</div>
			)}
			save={(draft) => {
				setLyrics(draft);
				return saveFields({ lyrics: draft });
			}}
		/>
	);

	// A piece of writing's body, in the editor it is written with — the article variant,
	// set in the typography the read prints. It lives in the Manage tab: a rich surface
	// among tabs, the one heavy control the unified page keeps off the user's read.
	const bodyField = (
		<InlineField<string>
			label="Body"
			saved={bodyHtml}
			className="w-full"
			renderRead={() => {
				const words = bodyText.trim() ? bodyText.trim().split(/\s+/).length : 0;
				return (
					<p className="text-sm text-base-content/60">
						{words > 0
							? `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"} written — the full read is above, where users meet it.`
							: "Nothing written yet."}
					</p>
				);
			}}
			renderEdit={(draft, setDraft) => (
				<RichTextEditor
					variant="article"
					content={draft}
					onChange={(html) => setDraft(html)}
					placeholder="Start writing…"
				/>
			)}
			save={async (draft) => {
				// The plain-text shadow, computed at save the way every keystroke did.
				const holder = document.createElement("div");
				holder.innerHTML = draft;
				const text = holder.textContent ?? "";
				setBodyHtml(draft);
				setBodyText(text);
				await saveFields({ bodyHtml: draft, body: text });
			}}
		/>
	);

	// A game or software's embed address, edited in place. The server refuses the
	// shapes it refuses; saying so here means the creator hears it beside the field.
	const embedUrlField = (
		<InlineField<string>
			label="Embed URL"
			saved={current.embedUrl ?? ""}
			renderRead={() =>
				current.embedUrl ? (
					<p className="text-sm break-all">{current.embedUrl}</p>
				) : (
					<p className="text-sm text-base-content/40">
						No embed — a hosted build below plays instead of one.
					</p>
				)
			}
			renderEdit={(draft, setDraft) => (
				<div>
					<input
						type="url"
						aria-label="Embed URL"
						className={`input input-bordered input-sm w-full ${embedUrlProblem(draft.trim()) ? "input-error" : ""}`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						placeholder="https://example.com/embed"
					/>
					{embedUrlProblem(draft.trim()) && (
						<p className="text-xs text-error">{embedUrlProblem(draft.trim())}</p>
					)}
					<p className="text-xs text-base-content/50">
						For a build hosted on another site, at an https:// address. Downloadable builds live in
						their own section below.
					</p>
				</div>
			)}
			save={(draft) => {
				const problem = embedUrlProblem(draft.trim());
				if (problem) throw new Error(problem);
				return saveFields({ embedUrl: draft.trim() });
			}}
		/>
	);

	// A physical good or a service's fulfillment details — the one field of the kind's
	// own, and a creator-only one: the user never sees it, which is why it is here and
	// not in the Details tab.
	const detailsNoteField = (
		<InlineField<string>
			label="Details"
			saved={typeof current.metadata?.note === "string" ? current.metadata.note : ""}
			renderRead={() =>
				typeof current.metadata?.note === "string" && current.metadata.note ? (
					<p className="whitespace-pre-wrap text-sm">{current.metadata.note}</p>
				) : (
					<p className="text-sm text-base-content/40">Nothing written yet.</p>
				)
			}
			renderEdit={(draft, setDraft) => (
				<div>
					<textarea
						aria-label="Details"
						className={`textarea textarea-bordered w-full ${GROWS} min-h-20`}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						rows={3}
						placeholder={
							current.type === "physical"
								? "Fulfillment notes, dimensions, shipping…"
								: "What the service includes, turnaround, terms…"
						}
					/>
				</div>
			)}
			save={(draft) => {
				return saveFields({ metadata: { note: draft.trim() } });
			}}
		/>
	);

	const releaseField = (
		<InlineField<string>
			label="Release"
			saved={releaseSaved}
			disabledSave={(draft) => {
				const iso = localInputToIso(draft);
				// Only a release-now waits on readiness; a future time is a schedule, which is
				// offered while those stand.
				return iso && Date.parse(iso) <= Date.now() ? releaseNowRefusal : undefined;
			}}
			renderRead={() => (
				<div className="flex flex-col gap-2">
					{/* The record link's globe moved to the byline's Released line
					    (Parker, 2026-10-19); this line only says when there is no
					    listing on the network yet. */}
					<ReleaseSummary work={current} scheduled={current.scheduledReleaseAt ?? null} />
					{current.visibility === "released" && !current.recordUrl && (
						<p className="text-xs text-base-content/50">Its listing isn't on the network yet.</p>
					)}
				</div>
			)}
			renderEdit={(draft, setDraft) => {
				const draftIso = localInputToIso(draft);
				// A time that has already passed is the release-now act, so every note that
				// qualifies a release answers from the draft rather than from the saved row.
				const releasingNow = draftIso !== null && Date.parse(draftIso) <= Date.now();
				return (
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-2">
							<div className="flex items-center gap-1.5">
								<label className="text-sm" htmlFor="owner-anthers-release">
									Anthers Release Date
								</label>
								<InfoTip text={RELEASE_FIELD_HINT} />
							</div>
							<div className="flex flex-wrap items-center gap-2 py-1">
								<input
									id="owner-anthers-release"
									type="datetime-local"
									aria-label="Anthers Release Date"
									className="input input-bordered w-full max-w-56"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
								/>
								<button
									type="button"
									className="btn btn-sm"
									title="Set the release date to right now"
									onClick={() => setDraft(nowLocalInput())}
								>
									Now
								</button>
								{draft && (
									// Empty is "not released": this is how a creator takes the Work back out
									// or drops a schedule, where the checkbox's unticking used to say it.
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										onClick={() => setDraft("")}
									>
										Clear
									</button>
								)}
							</div>
						</div>
						{current.visibility === "released" && !current.recordUrl && (
							<p className="text-xs text-base-content/50">Its listing isn't on the network yet.</p>
						)}
						{releasingNow && !anyoneAllowed && (
							<div className="alert alert-warning text-sm">
								<span>
									Nobody can open this. Released puts it in your Catalog; the Access tab is what
									lets anyone in — allow <strong>Everyone</strong> at $0 to make it Public Access.
								</span>
							</div>
						)}
						{releasingNow && publicAccessNow && (
							<p className="text-xs text-success">
								Public Access — free to everyone, and earning from the Time Pool.
							</p>
						)}
						{showsRatedPublicAccessNotice({
							released: releasingNow,
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
						{/* The waiting states a creator can act on, gathered from the batch editor. */}
						{fileMissing && !releasingNow && (
							<p className="text-xs text-warning">
								{fileUploading
									? "This can be released once its file has finished uploading and processing."
									: "Add the Work's file first. There's nothing to release until it arrives."}
							</p>
						)}
						{creditsMissing && !releasingNow && (
							<p className="text-xs text-warning">
								A Work isn't released until at least one credit has its Created box ticked.
							</p>
						)}
						{!fromRows && !releasingNow && (
							<p className="text-xs text-warning">
								Answer every row of the Rating first — every row, no exceptions.
							</p>
						)}
						{serverDown && !releasingNow && (
							<div className="alert alert-info text-sm">
								<span>
									The server holding your identity isn't answering right now. You can still release
									this: it goes out on Anthers straight away, and its listing reaches the network
									once the server is back.
								</span>
							</div>
						)}
						{permissionMissing === true && !releasingNow && (
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
									<strong>Set up payouts before releasing.</strong> It is how you get paid, and it
									is also what lets us say every creator here is an adult — Stripe checks identity
									so Anthers never has to ask you for an ID. Anthers takes no cut, so all of it
									comes to you.{" "}
									<Link to={studioUrl("/payments")} className="link">
										Set it up in the Studio's Payments tab
									</Link>
									.
								</span>
							</div>
						)}
					</div>
				);
			}}
			save={async (draft) => {
				const iso = localInputToIso(draft);
				if (!iso) {
					// Empty is "not released": it takes a released Work back out of the Catalog and
					// clears a schedule, and does nothing to a Work that is neither.
					if (current.visibility === "released") await saveFields({ visibility: "private" });
					else if (current.scheduledReleaseAt) await saveFields({ scheduledReleaseAt: null });
					return;
				}
				if (Date.parse(iso) <= Date.now()) {
					// A passed time is the release-now act. The server refuses a past schedule, and a
					// creator who picks today's date — or presses Now — means "out now".
					await saveFields({ visibility: "released", scheduledReleaseAt: null });
					return;
				}
				// A future time is a schedule, and a schedule is a private Work's: on a released
				// one, this takes it back out and lines it up for the new date.
				await saveFields({ visibility: "private", scheduledReleaseAt: iso });
			}}
		/>
	);

	const originalDateField = (
		<InlineField<string>
			label="Original release date"
			saved={originalDate}
			renderRead={() => (
				<DateValueLine
					label="Original Release"
					value={originalDate ? formatOriginallyReleased(`${originalDate}T00:00:00.000Z`) : "—"}
				/>
			)}
			renderEdit={(draft, setDraft) => (
				<div className="flex flex-col gap-2">
					<div className="flex items-center gap-1.5">
						<label className="text-sm" htmlFor="owner-original-release">
							Original Release Date
						</label>
						<InfoTip text={ORIGINAL_RELEASE_HINT} />
					</div>
					<input
						id="owner-original-release"
						type="date"
						aria-label="Original release date"
						className="input input-bordered w-full max-w-56"
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
					/>
				</div>
			)}
			save={(draft) => {
				setOriginalDate(draft);
				return saveFields({ originallyReleased: draft ? `${draft}T00:00:00.000Z` : null });
			}}
		/>
	);

	const creditsField = (
		<InlineField<WorkCredit[]>
			label="Credits"
			saved={creditRows}
			renderRead={(() => {
				const shown: WorkDetail = { ...asRead, credits: creditRows };
				if (creditRows.length === 0) {
					// The full structure, at its empty value (Parker, 2026-10-16): credits are a
					// list, so an empty one is said where its lines would sit, not as an absent
					// field — a creator hunting for the release floor finds it at first glance.
					return () => (
						<p className="text-sm text-base-content/40">
							A Work needs at least one Created credit naming a human before it can be released.
						</p>
					);
				}
				return () => <WorkCredits work={shown} />;
			})()}
			renderEdit={(draft, setDraft) => (
				<CreditsSection
					rows={draft}
					onChange={setDraft}
					showErrors={showCreditErrors}
					selfIdentity={
						user
							? {
									did: user.atprotoDid,
									handle: user.handle,
									displayName: user.displayName,
									avatar: user.avatar,
								}
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

	/**
	 * The access, edited from the chip in the byline strip (Parker's fourth pass,
	 * 2026-10-13): the Details tab loses its Access section — the chip below the video
	 * already names it — and for the creator the chip is the door: it opens the access
	 * table and the delivery switches in a modal, and the same save they made commits it.
	 */
	const accessField = (
		<OwnerAccessChipEditor
			rows={accessRows}
			publicAccess={publicAccessNow}
			onSave={async (draft) => {
				await saveFields({
					streamEnabled,
					downloadEnabled,
					access: serializeAccessRows(draft),
				});
				setAccessRows(draft);
			}}
		/>
	);

	const ratingField = (
		<div className="flex flex-col gap-3">
			{/* The summary first — Unrated with its warning icon, or the rating the rows add
			    up to — then the table, which is the tab's reason to exist and is always here. */}
			<RatingSummary
				maturity={maturity}
				notes={contentNotes}
				incomplete={!!storedMaturity && !fromRows}
			/>
			<RatingMatrix grid={grid} rows={ratingDraft} onChange={setRatingDraft} />
			{maturityLocked && (
				<div className="alert alert-info text-sm">
					<span>
						An operator set this rating. You can make it more cautious at any time — to lower it,
						appeal below and tell us why.
					</span>
				</div>
			)}
			{maturityLocked && (
				<RatingAppeal workId={current.id} corrected={current.maturity ?? "mature"} />
			)}
			{/* The table saves as one act, because one heading click answers every row; the
			    bar is the tab's own, shown while the draft stands away from the saved rows. */}
			{(ratingDirty || ratingError) && (
				<div className="flex flex-wrap items-center gap-2">
					<button
						type="button"
						className="btn btn-primary btn-sm"
						disabled={ratingSaving}
						onClick={() => void saveRating()}
					>
						{ratingSaving ? "Saving…" : "Save Rating"}
					</button>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						disabled={ratingSaving}
						onClick={() => {
							setRatingDraft(rows);
							setRatingError(null);
						}}
					>
						Discard
					</button>
					{ratingError && <span className="text-xs text-error">{ratingError}</span>}
				</div>
			)}
		</div>
	);

	// Accessibility, per kind: a video's caption tracks (the editor manages its own acts);
	// an image's alt text — the description its picture announces to a screen reader, which
	// is this tab's fact for the kind; kinds with nothing to offer yet say so in one line,
	// the same silence a tab's absence would have been, named rather than blank.
	const accessibilityField =
		current.type === "video" ? (
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
		) : current.type === "image" ? (
			<InlineField<string>
				label="Alt text"
				saved={imageAlt}
				renderRead={() => (
					<p className="text-sm">
						{imageAlt || <span className="text-sm text-base-content/40">No alt text yet.</span>}
					</p>
				)}
				renderEdit={(draft, setDraft) => (
					<div>
						<textarea
							aria-label="Alt text"
							className={`textarea textarea-bordered w-full ${GROWS} min-h-16`}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							rows={2}
							placeholder="What does the picture show?"
						/>
						<p className="text-xs text-base-content/50">
							Read to a screen reader instead of the picture. Empty falls back to the Work's title.
						</p>
					</div>
				)}
				save={(draft) => {
					setImageAlt(draft);
					return saveFields({ imageAlt: draft });
				}}
			/>
		) : (
			<p className="text-sm text-base-content/40">
				Nothing to set up here for a {typeLabel(current.type)} yet.
			</p>
		);

	// The thumbnail block is one object, placed by kind: the paged kinds carry it high in
	// the Manage tab, under View As and above Pages (Parker, 2026-10-19), because the cover
	// and the pages are the two things a comic is. Every other kind keeps it at the tab's end.
	const thumbnailTab = !isOwnThumbnail(current.type) ? (
		<div className="flex flex-col gap-2">
			{/* The terms ride the (i) now (Parker, 2026-10-16) — a hoverable beside
			    the heading instead of a paragraph the section always carried. */}
			<h3 className={`${WORK_DETAILS_HEADING_CLASS} flex items-center`}>
				Thumbnail
				<InfoTip text="Leave it empty and the Work shows a placeholder drawn for its kind. You can take one from the Work — a frame of a video, say — or upload an image." />
			</h3>
			{thumbnailField}
		</div>
	) : null;

	const detailsSection = (
		// Named parts (Parker's third pass, 2026-10-13): the Details tab is the Work's
		// composition — what it says, when it came out, who may open it — each under its
		// own heading rather than a flat run of controls. The Kind row moved to the
		// Manage tab (Parker, 2026-10-17): the kind is the machinery's first fact, and
		// the machinery is the Manage tab's, not the composition's. The description
		// leads the tab (Parker, 2026-10-19): what the Work is comes before when it
		// came out.
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Description</h3>
				{descriptionField}
			</section>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Tags</h3>
				{tagsField}
			</section>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Release</h3>
				{releaseField}
				{originalDateField}
			</section>
			{/* The Access section is gone (Parker, 2026-10-13): the chip in the byline strip
			    below the video names who may open this, and for the creator that chip is the
			    way in — the table lives in the dialog it opens. */}
		</div>
	);

	const infoTabs: InfoTab[] = [
		{ key: "details", label: "Details", content: detailsSection },
		{ key: "credits", label: "Credits", content: creditsField },
		{ key: "rating", label: "Rating", content: ratingField },
		{ key: "accessibility", label: "Accessibility", content: accessibilityField },
	];

	// The changing-kind save — the row's kind is page-resolved in the batch editor; here
	// the select saves at once and the row answers (the server rules govern; it may
	// refuse). A carried change unrates the row (the server's own act), so the matrix
	// the next open reads is the new kind's empty one — the batch editor's setRows({}).
	const saveKind = async (next: UploadableWorkType) => {
		if (next === current.type) return;
		try {
			await saveFields({ type: next });
			setRows({});
		} catch (err) {
			setError(err instanceof Error ? err.message : "The kind change didn't save.");
			// A refused change stands where it was — the next save re-syncs the select.
			await onRefetch?.();
		}
	};

	// ── The media area's two modes ──
	// The intake is the empty card's content for a kind whose media is uploaded; the
	// manager is the same card swapped to its controls. Both reuse the sections the
	// Manage tab used to carry, so the two surfaces cannot drift apart.
	const mediaIntake =
		!writing && !isGoods(current.type) ? (
			isBuildType(current.type) ? (
				<div className="flex w-full flex-col gap-6 text-left">
					<section className="flex flex-col gap-2">
						<h3 className={WORK_DETAILS_HEADING_CLASS}>Embed</h3>
						{embedUrlField}
					</section>
					<section className="flex flex-col gap-2">
						<h3 className={WORK_DETAILS_HEADING_CLASS}>Downloadable Builds</h3>
						<BuildsEditor work={current} onChanged={() => void refreshMedia()} />
					</section>
					<section className="flex flex-col gap-2">
						<h3 className={WORK_DETAILS_HEADING_CLASS}>Hosted Build</h3>
						<WebBuildSection work={current} onChanged={() => void refreshMedia()} />
					</section>
				</div>
			) : (
				<div className="flex w-full flex-col gap-3 text-left">
					{isFileWorkType(current.type) && !isPaged(current.type) && current.type !== "image" ? (
						<WorkFileDropzone work={current} showFormats={false} />
					) : (
						<WorkFileSection work={current} />
					)}
					<WorkTypeFacts type={current.type} />
				</div>
			)
		) : undefined;

	const sourceContent =
		current.type === "video" || isListened(current.type) ? (
			!current.sourceKey && !fileUploading ? (
				<div className="flex flex-col gap-3">
					<WorkFileDropzone work={current} showFormats={false} />
					<WorkTypeFacts type={current.type} />
				</div>
			) : (
				<MediaStatusCard
					work={asRead}
					sourceUpload={sourceUpload}
					unpublished={unpublished}
					canReplace={unpublished || current.visibility === "released"}
					canRemove={unpublished}
					cancelBusy={cancelBusy}
					removeBusy={removalBusy}
					onCancel={() => void cancelProcessing()}
					onRemove={() => void removeMedia()}
					onReplaceFile={(file) =>
						workUploads.start(current.id, file, {
							kind: "source",
							type: current.type as FileWorkType,
						})
					}
					onRetry={() => {
						if (sourceUpload) workUploads.retry(sourceUpload.id);
					}}
				/>
			)
		) : isBuildType(current.type) ? (
			<div className="flex flex-col gap-6">
				<section className="flex flex-col gap-2">
					<h3 className={WORK_DETAILS_HEADING_CLASS}>Embed</h3>
					{embedUrlField}
				</section>
				<section className="flex flex-col gap-2">
					<h3 className={WORK_DETAILS_HEADING_CLASS}>Downloadable Builds</h3>
					<BuildsEditor work={current} onChanged={() => void refreshMedia()} />
				</section>
				<section className="flex flex-col gap-2">
					<h3 className={WORK_DETAILS_HEADING_CLASS}>Hosted Build</h3>
					<WebBuildSection work={current} onChanged={() => void refreshMedia()} />
				</section>
			</div>
		) : (
			<WorkFileSection work={current} />
		);

	const mediaManagerTabs: MediaManagerTab[] = [];
	if (!writing && !isGoods(current.type)) {
		mediaManagerTabs.push({
			key: "delivery",
			label: "Delivery",
			content: (
				<DeliverySwitches
					streamEnabled={streamEnabled}
					downloadEnabled={downloadEnabled}
					onStream={(next) => void saveDelivery(next, downloadEnabled)}
					onDownload={(next) => void saveDelivery(streamEnabled, next)}
				/>
			),
		});
		mediaManagerTabs.push({ key: "source", label: "Source", content: sourceContent });
		if (thumbnailTab) {
			mediaManagerTabs.push({ key: "thumbnail", label: "Thumbnail", content: thumbnailTab });
		}
		if (isPaged(current.type)) {
			mediaManagerTabs.push({
				key: "pages",
				label: "Pages",
				content: <PanelEditor workId={current.id} />,
			});
		}
		mediaManagerTabs.push({
			key: "versions",
			label: "Versions",
			content: (
				<WorkVersionsSection
					workId={current.id}
					versionAddedAt={current.versionAddedAt}
					versionLabel={current.versionLabel}
				/>
			),
		});
	}

	const sideTabs = [
		{
			// The creator's tab, FIRST on the right column and active by default on it
			// (Parker, 2026-10-16) — the tab a creator lands on opens the page's machinery,
			// and the visitor's column never renders it. A user's page keeps the visitor's
			// order (the surface is the creator's alone and says so).
			key: "manage",
			label: "Manage",
			content: (
				<div className="flex flex-col gap-6">
					{kindChangeable && (
						// The kind leads the Manage tab (Parker, 2026-10-17): the kind decides
						// what this tab's machinery even is — every section below is the
						// chosen kind's — so it is the tab's first fact, and it moved here
						// from the Details tab for exactly that reason.
						<div className="flex items-center gap-2">
							<span className="text-sm font-medium">Kind</span>
							{/* The select reads the ROW (current), not the page-load prop: its save
							    adopts the response, and a refused change stands where it was — the
							    value is the page's truth here, as every other field's read is. */}
							<select
								aria-label="Work kind"
								className="select select-sm select-bordered"
								value={current.type}
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
					{/* The View As row, under the Kind row when a draft can still change its
					    kind (Parker, 2026-10-16 for the row's place on this tab): the
					    creator's four ways to look at the page — and since Manage opens by
					    default, at the top of the page itself, standing where the editing
					    banner stood. */}
					<WorkViewAsSection />
					{supportsPreviewMedia(current.type) && (
						// The storefront set sits after the kind's own machinery (media, file
						// or builds) and before the thumbnail — the same place a reader meets
						// it, under the locked card (Parker, 2026-10-19).
						<PreviewMediaSection work={current} onChanged={() => void refreshMedia()} />
					)}
					{isGoods(current.type) && (
						// Same doubling rule: the InlineField names itself "Details".
						<section className="flex flex-col gap-2">{detailsNoteField}</section>
					)}
					{writing && (
						<section className="flex flex-col gap-2">
							<h3 className={WORK_DETAILS_HEADING_CLASS}>Body</h3>
							{bodyField}
						</section>
					)}
				</div>
			),
		},
		{
			key: "reviews",
			label: "Reviews",
			// The Sticker for a Work rides a review, added from the review editor itself
			// (Parker, 2026-09-13) — there is no give on the Work page.
			content: <WorkReviews workId={current.id} />,
		},
		{
			key: "showings",
			label: "Showings",
			content: <ShowingsStub work={current} />,
		},
	];

	return (
		<WorkColumn type={current.type} wide tight>
			{/* The editing banner is gone (Parker, 2026-10-16): editing is inline, the
			    pencil is the only edit affordance, and the mode a creator is in is what the
			    page itself is — the View As row on the Manage tab carries the previewing. */}

			{/* ── The Work itself, full width, inside the page's one media card
			    (WorkMediaFrame — the media-frame task, 2026-10-16: the video layout is
			    canonical and every kind holds it). Nothing sits above the work (Parker's
			    third pass, 2026-10-13, and the upload banner's retirement, 2026-10-25): a
			    player wants no header block above it, and a file's progress reads where
			    the file is — in the media frame's own box, or the media manager's Source
			    tab. What a Work is and who made it reads under it, between the thing and
			    its record. A piece of writing reads at its measure centered inside the
			    card; a good's deliverable is the store panel, exactly where every user
			    meets it. ── */}
			<section className="relative">
				{!writing && !isGoods(current.type) && !mediaManaging && (
					<button
						type="button"
						className="btn btn-ghost btn-sm btn-circle absolute right-4 top-4 z-10 bg-base-100/80 text-base-content/70 backdrop-blur hover:text-base-content"
						aria-label={mediaManaging ? "Close Media Management" : "Manage This Work's Media"}
						aria-expanded={mediaManaging}
						onClick={() => setMediaManaging((open) => !open)}
					>
						<PencilSquareIcon className="size-4" />
					</button>
				)}
				{mediaManaging ? (
					<WorkMediaManager
						tabs={mediaManagerTabs}
						active={mediaTab}
						onActive={setMediaTab}
						onDone={() => setMediaManaging(false)}
					/>
				) : isGoods(current.type) ? (
					// The creator's copy of the user's store panel: it mounts without a
					// verdict, the same absence a creator's own visit has always read.
					// `w-full` as on the user page: the panel has no width of its own and
					// would shrink-to-fit in the frame's centered column.
					// `h-full` as on the user page: the store's columns fill the media
					// frame's whole profile (the store-panel task, 2026-10-17).
					<WorkMediaFrame>
						<div className="h-full w-full">
							<ProjectPricing
								workId={current.id}
								slug={current.slug ?? ""}
								title={current.title ?? "Untitled"}
								creatorHandle={asRead.creator?.handle ?? ""}
								workType={current.type}
							/>
						</div>
					</WorkMediaFrame>
				) : deliverableEmpty ? (
					// The silhouette: where the Work will be, at the media frame's one
					// profile, so the page below it doesn't move when the file lands.
					// And, for the kinds whose deliverable is a picked-up file, the
					// dropper rides IN the box (the dropper task, 2026-10-17) — the act
					// of filling the Work happens where the Work will be. It goes quiet
					// itself while an upload climbs; the note and the aside say so.
					<WorkMediaFrame>
						{writing && <WorkDescription work={asRead} />}
						<WorkPlaceholder
							type={current.type}
							note={deliverableNote}
							action={deliverableIntake ? mediaIntake : undefined}
						/>
					</WorkMediaFrame>
				) : kindWaiting ? (
					// The processing the landed file started, held INSIDE the media frame
					// (the placeholder task, 2026-10-16): the card keeps the one profile and
					// the progress rides in it, rather than the box being replaced by a
					// status card. The visitor's page shows the same shape through its own
					// call site.
					<WorkMediaFrame>
						{writing && <WorkDescription work={asRead} />}
						<WorkPlaceholder
							type={current.type}
							note=""
							status={
								<TranscodingStatus
									status={current.transcoding?.status ?? "pending"}
									progress={current.transcoding?.progress ?? 0}
									etaSeconds={current.transcoding?.etaSeconds ?? undefined}
									errorMessage={current.transcoding?.errorMessage ?? undefined}
								/>
							}
						/>
					</WorkMediaFrame>
				) : (
					<WorkDeliverable
						work={asRead}
						lead={writing ? <WorkDescription work={asRead} /> : undefined}
						lyrics={current.type === "music" ? lyricsField : undefined}
					/>
				)}
			</section>

			{/* ── The byline strip: the title (editable in place as everywhere) on the first
			    line, the creator with the kind and access chips on the second. The rating
			    line is not here — it is the Rating tab's fact, already above where the tabs
			    name it (Parker's third pass, 2026-10-13). ── */}
			<WorkByline
				work={asRead}
				// Share and Save ride the maker's line for the creator too (Parker, 2026-10-13):
				// the centered strip fans out symmetrically, and a creator's line with an empty
				// right half would sit lopsided. The verbs are a user's; they are what the strip
				// offers.
				actions={
					<div className="flex shrink-0 items-center gap-1">
						<ShareLinkButton workId={current.id} slug={asRead.slug ?? ""} />
						<SaveButton workId={current.id} className="shrink-0" />
					</div>
				}
				title={
					<InlineField<string>
						label="Title"
						saved={title}
						className="w-full min-w-0"
						pencilPlacement="corner"
						renderRead={() => (
							<h1
								className={`${workTitleTypography(current.type).className} truncate`}
								style={workTitleTypography(current.type).style}
							>
								{title || "Untitled"}
							</h1>
						)}
						renderEdit={(draft, setDraft) => (
							<textarea
								aria-label="Title"
								rows={1}
								className={`${workTitleTypography(current.type).className} ${IN_PLACE} ${GROWS} w-full min-w-0 flex-1`}
								style={workTitleTypography(current.type).style}
								value={draft}
								onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
								onKeyDown={(e) => {
									if (e.key === "Enter") e.preventDefault();
								}}
								placeholder="Work title"
							/>
						)}
						save={(draft) => {
							const next = draft.trim() || "Untitled";
							setTitle(next);
							return saveFields({ title: next });
						}}
					/>
				}
				chips={accessField}
			/>

			{/* ── The record's halves. The rule between them is its own grid column, a
			    two-pixel span the row's full height: it stands at the player's midline and
			    reaches the content area's bottom, which a border on one half only ever
			    reached that half (Parker's third pass, 2026-10-13). Above the whole pair,
			    the same hair laid flat (Parker, 2026-10-16), as the visitor's page draws. ── */}
			<div aria-hidden className="h-0.5 bg-base-content/20" />
			<div className="grid lg:grid-cols-[minmax(0,1fr)_2px_minmax(0,1fr)]">
				<div className="lg:pr-4">
					<WorkInfoTabs
						tabs={infoTabs}
						activeKey={activeInfoTab}
						onActiveChange={setActiveInfoTab}
					/>
				</div>
				<div aria-hidden className="w-0.5 self-stretch bg-base-content/20 max-lg:hidden" />
				<div className="lg:pl-4">
					<WorkSideColumn tabs={sideTabs} work={current} />
				</div>
			</div>

			{error && <p className="text-sm text-error">{error}</p>}

			{/* The frame picker and the framing dialog. Each is an overlay, so opening one
			    changes nothing about the page's height — the scroll-keeper's concern is the
			    section's buttons and the tabs, not these. */}
			{thumbPicker === "frame" && frameChoosable && (
				<ThumbFramePicker
					// Local mode hands the stored key as the original's address; `keyToPreview`
					// passes a real URL through and resolves a key onto the API's content
					// route, so a key does not resolve against the page URL (the silent
					// HTML-not-video fetch a bare key becomes).
					src={keyToPreview(current.originalUrl as string)}
					captions={current.captions}
					busy={frameBusy}
					inFlight={thumbnailInFlight.current > 0}
					error={frameError}
					onTake={takeCurrentFrame}
					onClose={() => setThumbPicker("none")}
				/>
			)}
			<ImageFrameModal
				open={thumbFrame !== null}
				src={thumbFrame?.preview ?? null}
				mediaType="thumbnail"
				busy={thumbSaving}
				error={thumbError}
				initialCrop={current.thumbnailCrop ?? null}
				onCancel={closeThumbFrame}
				onSave={(crop) => void saveFramedThumbnail(crop)}
			/>
		</WorkColumn>
	);
}

/* ── The read views and small controls the tabs and header use ─────────────── */

/**
 * The thumbnail's **frame picker** — its own player over the Work's original, seekable
 * to any moment, with the act that hands the paused second to the server. The route
 * extracts the frame and saves the field itself, so a settled `Use This Frame` IS the
 * save, and the picker's close rides the act's own success.
 */
function ThumbFramePicker({
	src,
	captions,
	busy,
	inFlight,
	error,
	onTake,
	onClose,
}: {
	src: string;
	/** The Work's caption tracks, played as they are over the Work wherever it goes. */
	captions?: { id: number; language: string; label: string; kind: string; url: string }[];
	busy: boolean;
	inFlight: boolean;
	error: string | null;
	onTake: (video: HTMLVideoElement | null) => Promise<boolean>;
	onClose: () => void;
}) {
	const videoRef = useRef<HTMLVideoElement | null>(null);

	// Escape closes, for the keyboard half of the door (the pattern ReportDialog set);
	// the pointer half is the ✕.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div className="modal modal-open" role="dialog" aria-label="Thumbnail from this Work">
			<div className="modal-box max-w-2xl">
				<button
					type="button"
					className="btn btn-ghost btn-sm btn-circle absolute right-2 top-2"
					aria-label="Close"
					onClick={onClose}
				>
					<XMarkIcon className="h-4 w-4" />
				</button>
				<h3 className="text-lg font-semibold">Thumbnail from this Work</h3>
				<p className="mt-1 text-xs text-base-content/60">
					Play or drag the video to the moment you want, then take that frame.
				</p>
				{/* biome-ignore lint/a11y/useMediaCaption: the caption tracks render from the
				    Work's own captions below; a video without any has none to provide. */}
				<video ref={videoRef} src={src} controls className="mt-3 w-full rounded-lg bg-black">
					{(captions ?? []).map((track) => (
						<track
							key={track.id}
							kind="captions"
							src={track.url}
							srcLang={track.language}
							label={track.label}
						/>
					))}
				</video>
				<div className="mt-4 flex items-center justify-end gap-3">
					{(busy || inFlight) && (
						<span className="text-xs text-base-content/60">Taking this moment…</span>
					)}
					<button
						type="button"
						className="btn btn-primary btn-sm"
						disabled={busy || inFlight}
						onClick={() => {
							// The act saves itself; the close rides its own success.
							void onTake(videoRef.current).then((taken) => {
								if (taken) onClose();
							});
						}}
					>
						Use This Frame
					</button>
				</div>
				{error && <p className="mt-2 text-xs text-warning">{error}</p>}
			</div>
		</div>
	);
}

/** The release read view: the row's status, said as a status rather than a control. */
/**
 * One labeled date line, shared by both of the Release section's lines (Parker's fourth
 * pass, 2026-10-13): the label in its fixed column, the value starting at the same x on
 * every line — the tab stop a text editor would give — with the same type per line and
 * the dash where the Work carries no value. The record link's globe lives on the
 * byline's Released line rather than here (Parker, 2026-10-19).
 */
export function DateValueLine({
	label,
	value,
	hint,
}: {
	label: string;
	value: ReactNode;
	/** A qualifier after the value, for a scheduled release. */
	hint?: string;
}) {
	return (
		<div className="grid grid-cols-[8rem_1fr] items-baseline text-sm">
			<span className="text-base-content/50">{label}</span>
			<span className="flex flex-wrap items-center gap-x-2">
				{value}
				{hint && <span className="text-base-content/60"> — {hint}</span>}
			</span>
		</div>
	);
}

export function ReleaseSummary({
	work,
	scheduled,
}: {
	work: WorkDetail;
	scheduled: string | null;
}) {
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
		<DateValueLine
			label="Anthers Release"
			value={released ?? "—"}
			hint={scheduledAt ? `scheduled for ${scheduledAt}` : undefined}
		/>
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

/** The access read view — what being able to open this Work means, in a line. The chip
 *  itself lives in the byline strip; this line says the terms. */
export function AccessSummary({
	publicAccess,
	anyoneAllowed,
}: {
	publicAccess: boolean;
	anyoneAllowed: boolean;
}) {
	if (publicAccess) {
		return <p className="text-sm">Free to everyone.</p>;
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

/**
 * The creator's access chip (Parker, 2026-10-13): the Work's access as a chip in the
 * byline strip, and for the creator the chip is the door — it opens the Access table
 * and the delivery switches in a modal, asked for deliberately. The chip's look comes
 * from the rows themselves, so a save answers it the way it answers every read.
 */
function OwnerAccessChipEditor({
	rows,
	publicAccess,
	onSave,
}: {
	rows: AccessRowDraft[];
	publicAccess: boolean;
	onSave: (rows: AccessRowDraft[]) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<AccessRowDraft[]>(rows);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	// The advice links to this creator's own profile, where the ladder is edited.
	const { user } = useAuth();

	useEffect(() => {
		if (open) dialog.current?.showModal();
	}, [open]);

	const commit = async () => {
		setBusy(true);
		setError(null);
		try {
			await onSave(draft);
			dialog.current?.close();
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "The access change didn't save.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<button
				type="button"
				title="Edit who can open this Work"
				className={`badge badge-sm cursor-pointer gap-1 border py-1.5 pr-2 ${
					publicAccess ? "badge-success badge-outline" : "badge-outline"
				}`}
				onClick={() => {
					setDraft(rows);
					setError(null);
					setOpen(true);
				}}
			>
				{publicAccess ? "Public Access" : "Gated"}
				<PencilSquareIcon className="size-3 opacity-60" />
			</button>
			{open && (
				<dialog ref={dialog} className="modal" onClose={() => setOpen(false)}>
					<div className="modal-box max-w-2xl">
						<h3 className="text-lg font-semibold">Who Can Open This Work</h3>
						<p className="mt-1 text-xs text-base-content/60">
							The Access table decides who pays what. The chip above answers from these rows: Public
							Access is Everyone at $0.
						</p>
						<div className="mt-4 flex flex-col gap-4">
							<AccessTables rows={draft} onRowsChange={setDraft} />
							{/* The release section's warning, live here while the rows are being
							    cut: the dialog is where the creator makes nobody able to open the
							    Work, so it says so before the save rather than after. */}
							{!draft.some((r) => r.allow) && (
								<div className="alert alert-warning text-sm">
									<span>
										Nobody can open this yet — allow <strong>Everyone</strong> at $0 to make it
										Public Access.
									</span>
								</div>
							)}
							{draft.length === 1 && user?.handle && (
								<p className="text-xs text-base-content/50">
									Want to gate this by monthly support?{" "}
									<Link to={`${profileUrl(user.handle)}?tab=badges`} className="link">
										Add Badge rungs on your profile
									</Link>
									.
								</p>
							)}
							{error && <p className="text-xs text-error">{error}</p>}
						</div>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => dialog.current?.close()}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-primary btn-sm"
								disabled={busy}
								onClick={() => void commit()}
							>
								{busy ? "Saving…" : "Save Access"}
							</button>
						</div>
					</div>
					<form method="dialog" className="modal-backdrop">
						<button type="button" aria-label="Close the access dialog" />
					</form>
				</dialog>
			)}
		</>
	);
}

/**
 * The rating's summary line, above the always-visible table. An unrated Work is not a blank:
 * "Unrated" said in a badge with the warning icon is what the table's waiting rows mean
 * (Parker, 2026-10-16) — the creator sees the Work needs its rows before it releases, at the
 * glance the empty tab used to turn into a hunt.
 */
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
			<div className="flex flex-wrap items-center gap-2">
				<span className="badge badge-sm badge-warning gap-1">
					<ExclamationTriangleIcon className="size-3.5" />
					Unrated
				</span>
				<span className="text-sm text-base-content/60">
					Nothing releases until every row has an answer.
				</span>
			</div>
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
			{/* The "users see no rating" line is gone (Parker, 2026-10-19): the badge says
			    General, and the table below answers the rest. */}
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

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A game or software's downloadable builds — the table and its add/delete form, moved
 * whole from the Studio editor's section (the kinds pass, 2026-10-14). These persist the
 * moment they are added or deleted, as they always have here too: nothing waits a save,
 * and `onChanged` re-reads the row so the table and the deliverable follow.
 */
function BuildsEditor({ work, onChanged }: { work: WorkDetail; onChanged: () => void }) {
	const assets = work.assets ?? [];
	const [file, setFile] = useState<File | null>(null);
	const [platform, setPlatform] = useState("windows");
	const [version, setVersion] = useState("");
	const [primary, setPrimary] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const add = async (e: FormEvent) => {
		e.preventDefault();
		if (!file) return;
		setBusy(true);
		setError(null);
		try {
			const fileKey = await uploadMediaFile(file, "asset");
			const res = await client.api.content.works[":id"].assets.$post({
				param: { id: String(work.id) },
				json: {
					file: fileKey,
					filename: file.name,
					fileSize: file.size,
					mimeType: file.type || "application/octet-stream",
					platform,
					version,
					isPrimary: primary,
				},
			});
			if (!res.ok) throw new Error("Create failed");
			setFile(null);
			setVersion("");
			setPrimary(false);
			onChanged();
		} catch {
			setError("Failed to upload build.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (assetId: number) => {
		try {
			const res = await client.api.content.works[":id"].assets[":assetId"].$delete({
				param: { id: String(work.id), assetId: String(assetId) },
			});
			if (!res.ok) throw new Error("Delete failed");
			onChanged();
		} catch {
			setError("Failed to delete build.");
		}
	};

	return (
		<div className="flex flex-col gap-3">
			<form onSubmit={add} className="flex flex-col gap-2">
				<div className="flex flex-col sm:flex-row gap-2 sm:items-end">
					<div className="flex-1">
						<FileUpload
							accept="*/*"
							maxSize={4 * 1024 * 1024 * 1024}
							compact
							label="Choose a build file"
							onFileSelect={setFile}
						/>
					</div>
					<select
						aria-label="Platform"
						className="select select-bordered select-sm w-32"
						value={platform}
						onChange={(e) => setPlatform(e.target.value)}
					>
						<option value="windows">Windows</option>
						<option value="mac">macOS</option>
						<option value="linux">Linux</option>
						<option value="web">Web</option>
						<option value="android">Android</option>
						<option value="ios">iOS</option>
						<option value="other">Other</option>
					</select>
					<input
						type="text"
						aria-label="Version"
						className="input input-bordered input-sm w-24"
						value={version}
						onChange={(e) => setVersion(e.target.value)}
						placeholder="1.0.0"
					/>
					<button type="submit" className="btn btn-primary btn-sm" disabled={busy || !file}>
						{busy ? "Adding…" : "Add"}
					</button>
				</div>
				<label className="label cursor-pointer justify-start gap-2 w-fit">
					<input
						type="checkbox"
						className="checkbox checkbox-sm"
						checked={primary}
						onChange={(e) => setPrimary(e.target.checked)}
					/>
					<span className="label-text text-sm">Primary build</span>
				</label>
			</form>

			{error && <p className="text-xs text-error">{error}</p>}

			{/* The card under the build picker follows its Platform select: what a person can
			    run is the file type, and the fact that changes with the platform belongs to
			    the row being added rather than to the kind in the abstract. */}
			<WorkTypeFacts type={work.type} platform={platform} />

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
											onClick={() => void remove(asset.id)}
										>
											<TrashIcon className="size-4" />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
