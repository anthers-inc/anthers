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
 * (Details · Credits · Ratings · Accessibility) shared with the user's rendering
 * of the same page (`WorkInfoTabs`), the right is **Reviews · Showings**
 * (`WorkSideColumn`). The creator's four ways to look at the page live in the **top bar's
 * View As control**, not in a tab (Parker, 2026-11-07). Each section the
 * creator can edit has one pencil — the pair opens and closes the section's fields as
 * one act, and only the fields whose values moved are sent; there is no page-wide Save.
 *
 * ⭐ **The pencils are always visible, and each section owns one** (Parker, 2026-11-07).
 * Hover-reveal was retired because an unfilled field left nothing to hover for it; every
 * section now renders its full structure at any value, so its pencil sits in the open.
 * The pencil's place is the pair's place: a tab's action column and the byline's action
 * slot both keep one rectangle across the read/edit switch, and the save check lands on
 * the pencil the creator just clicked.
 *
 * The deliverable is whatever the kind is: a rendered medium through `WorkDeliverable`,
 * or the store through `ProjectPricing` for the goods kinds, exactly where every user
 * meets the same Work — the creator's copy is that view with pencils in it. Each kind's
 * own machinery lives in the **media management card** the corner pencil opens
 * (`WorkMediaManager`): the file kinds' delivery, thumbnail, pages, builds, source and
 * versions, and — for the kinds with no media of their own — a writing Work's body and a
 * good's fulfillment details. The top bar's View As control carries the previewing.
 *
 * ⚠️ **Saves are narrow, and adopt the response.** A section's save diffs its draft
 * against the row and sends only what changed — the title and each date independently,
 * Description and Tags independently, credits and ratings only when their normalized
 * rows differ. The server's own rules (release gates, the rating re-declaration refusal,
 * the media floors) are the authority and answer in their own words; a section's error
 * shows where the section lives. The two deliberate carries from the batch editor: a
 * save NEVER sends `sourceKey`, and the thumbnail is sent only from its settled value
 * (the race into work 23's lost thumbnail).
 */

import {
	deliverableIsEmpty,
	embedUrlProblem,
	isBuildType,
	isEmptyWriting,
	isListened,
	isOwnThumbnail,
	isPaged,
	processingFor,
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
	releaseRatingRefusal,
} from "@anthers/shared/content-rating";
import { normalizeWorkTags } from "@anthers/shared/tags";
import { useAuth } from "@anthers/web-shared/auth";
import RatingAppeal from "@anthers/web-shared/content/RatingAppeal";
import { RELEASE_FIELD_HINT } from "@anthers/web-shared/content/release-date";
import WebBuildSection from "@anthers/web-shared/content/WorkWebBuildSection";
import {
	type FileWorkType,
	isFileWorkType,
	UploadProgressBar,
	WorkFileDropzone,
	WorkFileSection,
	WorkTypeFacts,
} from "@anthers/web-shared/content/work-media";
import {
	LIBRARY_TYPE_OPTIONS,
	TypeIcon,
	typeLabel,
	WORK_TYPE_DESCRIPTIONS,
} from "@anthers/web-shared/content/works";
import RichTextEditor from "@anthers/web-shared/editor/RichTextEditor";
import { isoToLocalInput, localInputToIso } from "@anthers/web-shared/local-datetime";
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
	uploadImageSource,
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
	type ContentType,
	type CreatorBadge,
	type Work,
	type WorkCredit,
	type WorkInput,
} from "@anthers/web-shared/types";
import FileUpload from "@anthers/web-shared/ui/FileUpload";
import ImageEditMenu from "@anthers/web-shared/ui/ImageEditMenu";
import ImageFrameModal from "@anthers/web-shared/ui/ImageFrameModal";
import InfoTip from "@anthers/web-shared/ui/InfoTip";
import Modal from "@anthers/web-shared/ui/Modal";
import SetupChecklist, { type SetupChecklistItem } from "@anthers/web-shared/ui/SetupChecklist";
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
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import { useExclusivePlayback } from "../../lib/playback";
import CreditsSection from "../../studio/CreditsSection";
import PanelEditor from "../../studio/PanelEditor";
import RatingMatrix, { RatingMatrixReadOnly } from "../../studio/RatingMatrix";
import WorkCaptionsEditor from "../../studio/WorkCaptionsEditor";
import ProjectPricing from "../project/ProjectPricing";
import WorkReviews from "../project/WorkReviews";
import { contentTypeMeta } from "../ui/ContentTypeBadge";
import { InlineField, SectionPencil, useSectionEdit } from "./Editing";
import { LyricsBody } from "./LyricsPanel";
import MediaStatusCard from "./MediaStatusCard";
import PreviewMediaSection from "./PreviewMediaSection";
import ShareLinkButton from "./ShareLinkButton";
import WorkInfoTabs, { type InfoTab } from "./WorkInfoTabs";
import {
	DescriptionBody,
	isGoods,
	isWriting,
	WORK_DESCRIPTION_CLASS,
	WORK_DETAILS_HEADING_CLASS,
	WORK_LYRICS_CLASS,
	WorkByline,
	WorkColumn,
	WorkCredits,
	WorkDateLine,
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
 * What every release-warning marker in the editor says on hover (Parker, 2026-11-06): the
 * thing it marks is not a suggestion, and a scheduled release refuses without it.
 */
const RELEASE_WARNING = "This is mandatory for release. Fill it in before the scheduled date.";

/** A checklist row, plus the sentence the Release field carries when it is the first blocker. */
type ReleaseItem = SetupChecklistItem & { refusal?: string };

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
	/** Whether the persistent player bar owns the bottom edge, so the floating card clears it. */
	const playerUp = useMediaPlayer().currentTrack !== null;
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

	// The rating tab's draft lives in its section editor below; an unread `rows` is the
	// saved matrix, and the read view is the table the visitor sees.

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
	/** The last downloadable build that landed, said at the page level because the media
	 *  card unmounts the editor when the first build exists. */
	const [buildMessage, setBuildMessage] = useState<string | null>(null);
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
	const preReleaseSaved = isoToLocalInput(current.preReleaseAt);

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
				? (await uploadImageSource(thumbFrame.file, "thumbnail")).url
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
	/** The rating's other refusal: a complete rating at a rung Anthers is not taking today. */
	const ratingRungRefusal = fromRows ? releaseRatingRefusal(fromRows) : null;

	/** Open an Info tab and bring it into view from the floating checklist. */
	const openInfoTab = (key: string) => {
		setActiveInfoTab(key);
		requestAnimationFrame(() =>
			document.getElementById("work-info-tabs")?.scrollIntoView({
				behavior: "smooth",
				block: "start",
			}),
		);
	};
	/** Open the media manager where this kind's file lives, and bring the media area into view. */
	const openMediaManager = () => {
		setMediaManaging(true);
		setMediaTab(isPaged(current.type) ? "pages" : "source");
		requestAnimationFrame(() =>
			document.getElementById("work-media-area")?.scrollIntoView({
				behavior: "smooth",
				block: "start",
			}),
		);
	};

	/**
	 * **The creator's own setup** — the two things publishing takes that belong to the
	 * account rather than to any one Work. They are one-time facts, so they are not rows on
	 * every Work's checklist; a Work shows them only while one is still missing (Parker,
	 * 2026-11-07). Each answer arrives a moment after the page, and a row exists only once
	 * its answer does, so the card never claims a fact nobody has checked.
	 */
	const permissionItem: ReleaseItem | null =
		permissionMissing === null
			? null
			: {
					key: "permission",
					label: "Allow ATProto creator permissions",
					state: permissionMissing ? "todo" : "done",
					refusal:
						"Give Anthers permission to publish before releasing — the notice below says where.",
					href: studioUrl("/settings"),
				};
	const payoutsItem: ReleaseItem | null =
		payoutsReady === null
			? null
			: {
					key: "payouts",
					label: "Complete your Stripe Payout Setup",
					state: payoutsReady ? "done" : "todo",
					refusal: "Set up payouts before releasing — the notice below says where.",
					href: studioUrl("/payments"),
				};
	const creatorSetupItems = [permissionItem, payoutsItem].filter(
		(item): item is ReleaseItem => item !== null,
	);
	const creatorSetupKnown = permissionItem !== null && payoutsItem !== null;
	const creatorSetupMissing = permissionItem?.state === "todo" || payoutsItem?.state === "todo";

	/**
	 * **The Work's own setup**, in the order the card reads it: its medium, a human credit,
	 * the rating. The card and the Release field share these predicates, so neither can call
	 * a Work ready while the release gate refuses it.
	 *
	 * ⚠️ **Processing is folded into the media row rather than given a row of its own.** The
	 * file is not set up until it can play, and a creator who has just uploaded one should see
	 * the medium row waiting rather than a checked row beside a second one saying to wait.
	 */
	const transcodeStatus = current.transcoding?.status;
	const mediaStalled = transcodeStatus === "failed" || transcodeStatus === "canceled";
	const mediaWaiting =
		fileUploading ||
		running ||
		(!!processingFor(current.type) && !current.transcoding && !!current.sourceKey);
	const workItems: ReleaseItem[] = [];

	if (writing) {
		workItems.push({
			key: "writing",
			label: (
				<>
					The <strong>writing</strong> for the Work
				</>
			),
			state: writingEmpty ? "todo" : "done",
			refusal: "This piece of writing is empty.",
			onOpen: () => {
				setMediaTab("body");
				setMediaManaging(true);
				requestAnimationFrame(() =>
					document.getElementById("work-body-field")?.scrollIntoView({
						behavior: "smooth",
						block: "center",
					}),
				);
			},
		});
	} else if (isFileWorkType(current.type)) {
		workItems.push({
			key: "media",
			label: (
				<>
					The <strong>media</strong> for the Work
				</>
			),
			state: mediaWaiting ? "waiting" : current.sourceKey && !mediaStalled ? "done" : "todo",
			refusal: mediaStalled
				? "Processing this Work's media was stopped, so it can't be released — replace the media or start the processing again."
				: mediaWaiting && current.sourceKey
					? "Can't release yet — the media is still processing."
					: "This Work's file has to arrive before it can be released.",
			onOpen: openMediaManager,
		});
	} else if (isBuildType(current.type)) {
		workItems.push({
			key: "build",
			label: (
				<>
					A <strong>build</strong> or embed for the Work
				</>
			),
			state: deliverableIsEmpty(current) ? "todo" : "done",
			// The release gate does not ask for a build, so this row carries no refusal: the
			// card may name the page's empty medium without inventing a release condition.
			onOpen: openMediaManager,
		});
	}
	workItems.push({
		key: "credits",
		label: (
			<>
				At least one human <strong>credit</strong>
			</>
		),
		state: creditsMissing ? "todo" : "done",
		refusal: "Credit at least one person as Created before releasing.",
		onOpen: creditsMissing ? () => openInfoTab("credits") : undefined,
	});
	workItems.push({
		key: "rating",
		label: (
			<>
				A full set of <strong>ratings</strong>
			</>
		),
		state: !fromRows ? "todo" : ratingRungRefusal === "closed" ? "waiting" : "done",
		refusal: !fromRows
			? "Answer every row of the Rating first — every row, no exceptions."
			: ratingRungRefusal === "closed"
				? `Anthers isn't accepting ${maturityLabel(fromRows)} work at the moment, so this Work can't be released. The rating is right and has been saved — you'll be able to release when ${maturityLabel(fromRows)} reopens.`
				: undefined,
		onOpen: !fromRows ? () => openInfoTab("rating") : undefined,
	});

	/**
	 * The first thing that would refuse a release-now, said in the server's own order: the
	 * creator's standing, the Work's medium, the rating, the credits. The notices below say
	 * each one in full, and this short form rides the checkmark's tooltip while it waits. A
	 * schedule is still offered while these stand, as the batch editor's rule had it.
	 */
	const releaseNowRefusal = [
		permissionItem,
		payoutsItem,
		...workItems.filter(
			(item) => item.key === "media" || item.key === "writing" || item.key === "build",
		),
		workItems.find((item) => item.key === "rating"),
		workItems.find((item) => item.key === "credits"),
	]
		.filter((item): item is ReleaseItem => item != null)
		.find((item) => item.state !== "done" && item.refusal)?.refusal;

	/**
	 * Which checklist the floating card shows. A creator who has not finished their own setup
	 * sees that first, because it is what has to change before anything can be published; a
	 * Work they have already set up sees the Work's own rows. Never both at once (Parker,
	 * 2026-11-07), and nothing until the account answers are known.
	 */
	const checklist = creatorSetupMissing
		? {
				title: "Creator Setup Checklist",
				intro: "Before you can publish Works or posts, you need to:",
				items: creatorSetupItems,
			}
		: {
				title: "Work Setup Checklist",
				intro: "Before you can release a Work, you need to add:",
				items: workItems,
			};

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
	 * where the Work will be. A writing's body and a good's details live in the media
	 * management card, and the corner pencil is already an affordance on the box, so the
	 * box does not narrate them.
	 */
	const deliverableIntake = !writing && !isGoods(current.type);
	/**
	 * The silhouette's note, said per kind — what fills the box, and where. The intake's
	 * own controls say what to do, so a media Work's note is silent; an upload in flight
	 * says so. A writing's empty article names itself and the pencil stands in its corner.
	 */
	const deliverableNote = fileUploading
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

	/**
	 * The byline's one edit (Parker, 2026-11-07): the title and the three release dates
	 * open together, and the action that opens them stands where the library Save button
	 * was. On save, only the fields whose values actually moved are sent — the title and
	 * each date are diffed against the row before the one PATCH is built.
	 */
	const titleSection = useSectionEdit<{
		title: string;
		release: string;
		original: string;
		preRelease: string;
	}>({
		label: "Title and Dates",
		saved: { title, release: releaseSaved, original: originalDate, preRelease: preReleaseSaved },
		disabledSave: (draft) => {
			const datesChanged =
				draft.release !== releaseSaved ||
				draft.preRelease !== preReleaseSaved ||
				draft.original !== originalDate;
			if (!datesChanged) return undefined;
			const pre = localInputToIso(draft.preRelease);
			const release = localInputToIso(draft.release);
			if (pre && release && Date.parse(pre) >= Date.parse(release)) {
				return "The pre-release date has to be before the release date.";
			}
			if (draft.release === releaseSaved) return undefined;
			const iso = localInputToIso(draft.release);
			return iso && Date.parse(iso) <= Date.now() ? releaseNowRefusal : undefined;
		},
		save: async (draft) => {
			const updates: Partial<WorkInput> = {};
			const nextTitle = draft.title.trim() || "Untitled";
			if (nextTitle !== title) updates.title = nextTitle;
			const originalIso = draft.original ? `${draft.original}T00:00:00.000Z` : null;
			const originalChanged = originalIso !== (current.originallyReleased ?? null);
			if (originalChanged) updates.originallyReleased = originalIso;
			const preIso = localInputToIso(draft.preRelease);
			if (preIso !== (current.preReleaseAt ?? null)) updates.preReleaseAt = preIso;
			if (draft.release !== releaseSaved) {
				const iso = localInputToIso(draft.release);
				if (!iso) {
					if (current.visibility === "released") updates.visibility = "private";
					else if (current.scheduledReleaseAt) updates.scheduledReleaseAt = null;
				} else if (Date.parse(iso) <= Date.now()) {
					updates.visibility = "released";
					updates.scheduledReleaseAt = null;
				} else {
					updates.visibility = "private";
					updates.scheduledReleaseAt = iso;
				}
			}
			if (Object.keys(updates).length === 0) return;
			await saveFields(updates);
			if (updates.title !== undefined) setTitle(nextTitle);
			if (originalChanged) setOriginalDate(draft.original);
		},
	});

	const titleRead = (
		<h1
			className={`${workTitleTypography(current.type).className} truncate`}
			style={workTitleTypography(current.type).style}
		>
			{title || "Untitled"}
		</h1>
	);
	const titleEdit = (
		<textarea
			aria-label="Title"
			rows={1}
			className={`${workTitleTypography(current.type).className} ${IN_PLACE} ${GROWS} mx-auto w-full max-w-3xl text-center`}
			style={workTitleTypography(current.type).style}
			value={titleSection.draft.title}
			onChange={(e) =>
				titleSection.setDraft({
					...titleSection.draft,
					title: e.target.value.replace(/\n/g, " "),
				})
			}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.preventDefault();
			}}
			placeholder="Work title"
		/>
	);

	// The read view is the one release line the page has always carried: the pre-release
	// date belongs to the edit state only (Parker, 2026-11-07).
	const datesRead = <WorkDateLine work={current} scheduled={current.scheduledReleaseAt ?? null} />;

	const datesEdit = (() => {
		const draft = titleSection.draft;
		const setDraft = titleSection.setDraft;
		const draftIso = localInputToIso(draft.release);
		const releasingNow =
			draft.release !== releaseSaved && draftIso !== null && Date.parse(draftIso) <= Date.now();
		return (
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 text-left">
				<div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-3">
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex items-center gap-1.5">
							<label className="text-sm" htmlFor="owner-anthers-pre-release">
								Pre-Release Date
							</label>
							<InfoTip text="Opens this Work's page to everyone on this date, with its preview media and its coming-soon card. Buying, downloading, streaming and reviews stay closed until the Anthers Release Date." />
						</div>
						<input
							id="owner-anthers-pre-release"
							type="datetime-local"
							aria-label="Pre-Release Date"
							className="input input-bordered w-full"
							value={draft.preRelease}
							onChange={(e) => setDraft({ ...draft, preRelease: e.target.value })}
						/>
					</div>
					<div className="flex min-w-0 flex-col gap-1.5">
						<div className="flex items-center gap-1.5">
							<label className="text-sm" htmlFor="owner-anthers-release">
								Anthers Release Date
							</label>
							<InfoTip text={RELEASE_FIELD_HINT} />
						</div>
						<input
							id="owner-anthers-release"
							type="datetime-local"
							aria-label="Anthers Release Date"
							className="input input-bordered w-full"
							value={draft.release}
							onChange={(e) => setDraft({ ...draft, release: e.target.value })}
						/>
					</div>
					<div className="flex min-w-0 flex-col gap-1.5">
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
							className="input input-bordered w-full"
							value={draft.original}
							onChange={(e) => setDraft({ ...draft, original: e.target.value })}
						/>
					</div>
				</div>
				<div className="flex flex-col gap-2">
					{current.visibility === "released" && !current.recordUrl && (
						<p className="text-xs text-base-content/50">Its listing isn't on the network yet.</p>
					)}
					{releasingNow && !anyoneAllowed && (
						<div className="alert alert-warning text-sm">
							<span>
								Nobody can open this. Released puts it in your Catalog; the Access tab is what lets
								anyone in — allow <strong>Everyone</strong> at $0 to make it Public Access.
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
								this: it goes out on Anthers straight away, and its listing reaches the network once
								the server is back.
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
			</div>
		);
	})();

	/**
	 * The Details tab's one edit (Parker, 2026-11-07): description and tags open together,
	 * and the save sends only the field that changed. The tab's action column carries the
	 * pencil/pair, so the read and edit views occupy the same box.
	 */
	const detailsEdit = useSectionEdit<{ description: string; tags: string[] }>({
		label: "Details",
		saved: { description, tags },
		save: async (draft) => {
			const updates: Partial<WorkInput> = {};
			const nextDescription = draft.description.trim();
			if (nextDescription !== description) updates.description = nextDescription;
			const nextTags = normalizeWorkTags(draft.tags);
			if (JSON.stringify(nextTags) !== JSON.stringify(tags)) updates.tags = nextTags;
			if (Object.keys(updates).length === 0) return;
			await saveFields(updates);
			if (updates.description !== undefined) setDescription(nextDescription);
			if (updates.tags !== undefined) setTags(nextTags);
		},
	});

	const detailsSectionContent = (
		<div className="flex flex-col gap-6">
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Description</h3>
				{detailsEdit.editing ? (
					<div>
						<textarea
							aria-label="Description"
							className={`${WORK_DESCRIPTION_CLASS} ${description ? IN_PLACE : IN_PLACE_EMPTY} ${GROWS} w-full min-h-16`}
							value={detailsEdit.draft.description}
							onChange={(e) =>
								detailsEdit.setDraft({ ...detailsEdit.draft, description: e.target.value })
							}
							rows={3}
							placeholder="Describe this Work…"
						/>
						<p className="text-xs text-base-content/50">
							Shown to everyone, including people who haven't unlocked this.
						</p>
					</div>
				) : (
					<DescriptionBody description={description} />
				)}
			</section>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Tags</h3>
				{detailsEdit.editing ? (
					<WorkTagPicker
						selected={detailsEdit.draft.tags}
						onChange={(next) => detailsEdit.setDraft({ ...detailsEdit.draft, tags: next })}
					/>
				) : (
					<WorkTagChips tags={tags} />
				)}
			</section>
			{detailsEdit.error && <p className="text-xs text-error">{detailsEdit.error}</p>}
		</div>
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
	// set in the typography the read prints. It lives in the media management card, the
	// card the pencil over the media area opens: a rich surface, the one heavy control
	// the unified page keeps off the user's read.
	const bodyField = (
		<InlineField<string>
			label="Body"
			saved={bodyHtml}
			className="w-full"
			initiallyEditing
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
	// own, and a creator-only one: the user never sees it, which is why it lives in the
	// media management card and not in the Details tab.
	const detailsNoteField = (
		<InlineField<string>
			label="Details"
			saved={current.note ?? ""}
			initiallyEditing
			renderRead={() =>
				current.note ? (
					<p className="whitespace-pre-wrap text-sm">{current.note}</p>
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
				return saveFields({ note: draft.trim() });
			}}
		/>
	);

	/**
	 * The Credits tab's one edit (Parker, 2026-11-07): the row editor opens from the tab's
	 * action column, and the save sends the credits only when they actually changed.
	 */
	const creditsEdit = useSectionEdit<WorkCredit[]>({
		label: "Credits",
		saved: creditRows,
		save: async (draft) => {
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
			if (JSON.stringify(rows) === JSON.stringify(creditRows)) return;
			await saveFields({ credits: rows });
			setCreditRows(rows);
		},
	});

	const creditsContent = (
		<>
			{creditsEdit.editing ? (
				<CreditsSection
					rows={creditsEdit.draft}
					onChange={creditsEdit.setDraft}
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
			) : creditRows.length === 0 ? (
				// The full structure, at its empty value (Parker, 2026-10-16): credits are a
				// list, so an empty one is said where its lines would sit, not as an absent
				// field — a creator hunting for the release floor finds it at first glance.
				<p className="text-sm text-base-content/40">
					A Work needs at least one Created credit naming a human before it can be released.
				</p>
			) : (
				<WorkCredits work={{ ...asRead, credits: creditRows }} />
			)}
			{creditsEdit.error && <p className="text-xs text-error">{creditsEdit.error}</p>}
		</>
	);

	// The changing-kind save — the row's kind is page-resolved in the batch editor; here
	// the kind chip saves at once and the row answers (the server rules govern; it may
	// refuse). A carried change unrates the row (the server's own act), so the matrix
	// the next open reads is the new kind's empty one — the batch editor's setRows({}).
	// A refusal is thrown back to the chip's dialog, which says it where the choice was
	// made, and the page is re-read so the chip never reads a kind the row does not hold.
	const saveKind = async (next: ContentType) => {
		if (next === current.type) return;
		try {
			await saveFields({ type: next });
			setRows({});
		} catch (err) {
			await onRefetch?.();
			throw err instanceof Error ? err : new Error("The kind change didn't save.");
		}
	};

	/**
	 * The kind, edited from the chip in the byline strip (Parker, 2026-10-29): the chip a
	 * reader reads is the door a draft's kind is changed through, the same shape as the
	 * access chip beside it, and no separate Kind control stands anywhere else.
	 */
	const kindField = (
		<OwnerKindChipEditor
			type={current.type}
			onSave={async (next) => {
				await saveKind(next);
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

	/**
	 * The Ratings tab's one edit (Parker, 2026-11-07): the matrix reads as the visitor's
	 * read-only table until the tab's pencil opens it, and an unchanged save writes
	 * nothing. Renamed from "Rating" because the tab is the whole matrix, not the one
	 * summary line.
	 */
	const ratingsEdit = useSectionEdit<MaturityRows>({
		label: "Ratings",
		saved: rows,
		save: async (draft) => {
			const next = normalizeMaturityRows(draft, grid);
			if (JSON.stringify(next) === JSON.stringify(normalizeMaturityRows(rows, grid))) return;
			await saveFields({ maturityRows: next });
			setRows(next);
		},
	});

	const ratingsContent = (
		<div className="flex flex-col gap-3">
			{/* The summary first — Unrated with its warning icon, or the rating the rows add
			    up to — then the table, read-only until the section's pencil opens it. */}
			<RatingSummary
				maturity={maturity}
				notes={contentNotes}
				incomplete={!!storedMaturity && !fromRows}
			/>
			{ratingsEdit.editing ? (
				<RatingMatrix grid={grid} rows={ratingsEdit.draft} onChange={ratingsEdit.setDraft} />
			) : (
				<RatingMatrixReadOnly grid={grid} rows={rows} />
			)}
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
			{ratingsEdit.error && <p className="text-xs text-error">{ratingsEdit.error}</p>}
		</div>
	);

	// Accessibility, per kind: a video's caption tracks (the editor manages its own acts);
	// an image's alt text — the description its picture announces to a screen reader, which
	// is this tab's fact for the kind; kinds with nothing to offer yet say so in one line,
	// the same silence a tab's absence would have been, named rather than blank.
	const accessibilityEditable = current.type === "video" || current.type === "image";
	const accessibilityEdit = useSectionEdit<string | null>({
		label: "Accessibility",
		saved: current.type === "image" ? imageAlt : null,
		save: async (draft) => {
			// The captions editor writes each track itself; the section's check is the way
			// out of the editor, not a second save.
			if (current.type !== "image") return;
			const next = typeof draft === "string" ? draft : "";
			if (next === imageAlt) return;
			await saveFields({ imageAlt: next });
			setImageAlt(next);
		},
	});

	const accessibilityContent =
		current.type === "video" ? (
			accessibilityEdit.editing ? (
				<WorkCaptionsEditor
					workId={current.id}
					captions={current.captions ?? []}
					onChanged={() => void refreshMedia()}
				/>
			) : (
				<CaptionsSummary captions={current.captions ?? []} />
			)
		) : current.type === "image" ? (
			accessibilityEdit.editing ? (
				<div>
					<textarea
						aria-label="Alt text"
						className={`textarea textarea-bordered w-full ${GROWS} min-h-16`}
						value={accessibilityEdit.draft ?? ""}
						onChange={(e) => accessibilityEdit.setDraft(e.target.value)}
						rows={2}
						placeholder="What does the picture show?"
					/>
					<p className="text-xs text-base-content/50">
						Read to a screen reader instead of the picture. Empty falls back to the Work's title.
					</p>
				</div>
			) : (
				<p className="text-sm">
					{imageAlt || <span className="text-sm text-base-content/40">No alt text yet.</span>}
				</p>
			)
		) : (
			<p className="text-sm text-base-content/40">
				Nothing to set up here for a {typeLabel(current.type)} yet.
			</p>
		);

	// The thumbnail block is one object, placed by kind: every file kind carries it after
	// Delivery, and the paged kinds keep Pages directly after it (Parker, 2026-10-19),
	// because the cover and the pages are the two things a comic is.
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

	const infoTabs: InfoTab[] = [
		{
			key: "details",
			label: "Details",
			content: detailsSectionContent,
			action: detailsEdit.actions,
		},
		{
			key: "credits",
			label: "Credits",
			content: creditsContent,
			action: creditsEdit.actions,
			warning: creditsMissing ? RELEASE_WARNING : undefined,
		},
		{
			key: "rating",
			label: "Ratings",
			content: ratingsContent,
			action: ratingsEdit.actions,
			warning: !fromRows ? RELEASE_WARNING : undefined,
		},
		{
			key: "accessibility",
			label: "Accessibility",
			content: accessibilityContent,
			action: accessibilityEditable ? accessibilityEdit.actions : undefined,
		},
	];

	// ── The media area's two modes ──
	// The intake is the empty card's content for a kind whose media is uploaded; the
	// manager is the same card swapped to its controls. Both reuse the sections the
	// manager carries, so the two surfaces cannot drift apart.
	const buildDownloadsSection = (
		<section className="flex flex-col gap-2">
			<h3 className={WORK_DETAILS_HEADING_CLASS}>Downloadable Builds</h3>
			<BuildsEditor
				work={current}
				onChanged={() => void refreshMedia()}
				onAdded={setBuildMessage}
			/>
		</section>
	);
	const buildStreamingSections = (
		<>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Embed</h3>
				{embedUrlField}
			</section>
			<section className="flex flex-col gap-2">
				<h3 className={WORK_DETAILS_HEADING_CLASS}>Hosted Build</h3>
				<WebBuildSection work={current} onChanged={() => void refreshMedia()} />
			</section>
		</>
	);

	const mediaIntake =
		!writing && !isGoods(current.type) ? (
			isBuildType(current.type) ? (
				// A build's intake offers only the doors its delivery allows: a download-only
				// game is not asked for an embed, and a streaming-only one is not asked for a
				// build it will never hand over.
				<div className="flex w-full flex-col gap-6 text-left">
					{streamEnabled && buildStreamingSections}
					{downloadEnabled && buildDownloadsSection}
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
		) : (
			<WorkFileSection work={current} />
		);

	const versionsSection = (
		<WorkVersionsSection
			workId={current.id}
			versionAddedAt={current.versionAddedAt}
			versionLabel={current.versionLabel}
		/>
	);

	const sourceAndVersions = (
		<div className="flex flex-col gap-6">
			{sourceContent}
			{versionsSection}
		</div>
	);

	const previewMedia = supportsPreviewMedia(current.type);
	const thumbnailAndPreviews =
		thumbnailTab || previewMedia ? (
			<div className="flex flex-col gap-6">
				{thumbnailTab}
				{previewMedia && (
					<PreviewMediaSection work={current} onChanged={() => void refreshMedia()} />
				)}
			</div>
		) : null;

	const mediaManagerTabs: MediaManagerTab[] = [];
	if (writing) {
		// A piece of writing has no media of its own — its body is the deliverable, and
		// this card is the one surface heavy enough to hold the editor rather than the read.
		mediaManagerTabs.push({
			key: "body",
			label: "Body",
			content: (
				<div id="work-body-field" className="flex flex-col gap-2">
					{bodyField}
				</div>
			),
		});
	} else if (isGoods(current.type)) {
		// A good keeps its storefront for everything a buyer sees; this card holds the
		// fulfillment material a buyer never does.
		mediaManagerTabs.push({
			key: "details",
			label: "Details",
			content: <div className="flex flex-col gap-2">{detailsNoteField}</div>,
		});
	} else {
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
		// Thumbnail and preview media are one surface now, and paged Works keep Pages
		// directly after it — the order a creator met these before the merge.
		if (thumbnailAndPreviews) {
			mediaManagerTabs.push({
				key: "thumbnail",
				label: previewMedia ? "Thumbnail & Preview Media" : "Thumbnail",
				content: thumbnailAndPreviews,
			});
		}
		if (isPaged(current.type)) {
			mediaManagerTabs.push({
				key: "pages",
				label: "Pages",
				content: <PanelEditor workId={current.id} />,
			});
		}
		if (isBuildType(current.type)) {
			// A build can be handed over or played here, and the two are separate jobs: the
			// delivery the creator chose decides which tabs exist at all.
			if (streamEnabled) {
				mediaManagerTabs.push({
					key: "streaming",
					label: "Streaming",
					content: <div className="flex flex-col gap-6">{buildStreamingSections}</div>,
				});
			}
			if (downloadEnabled) {
				mediaManagerTabs.push({
					key: "downloads",
					label: "Downloads",
					content: buildDownloadsSection,
				});
			}
			// A build's history stays its own tab; a file Work's versions sit under the
			// source they belong to, where the merge put them.
			mediaManagerTabs.push({
				key: "versions",
				label: "Versions",
				content: versionsSection,
			});
		} else {
			mediaManagerTabs.push({
				key: "source",
				label: "Source & Versions",
				content: sourceAndVersions,
			});
		}
	}

	const sideTabs = [
		{
			key: "reviews",
			label: "Reviews",
			// The Sticker for a Work rides a review, added from the review editor itself
			// (Parker, 2026-09-13) — there is no give on the Work page.
			content: <WorkReviews workId={current.id} creatorId={current.creatorId ?? null} />,
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
			    page itself is — the top bar's View As control carries the previewing. */}

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
			<section id="work-media-area" className="relative">
				{!writing && !isGoods(current.type) && !mediaManaging && fileMissing && (
					// The same warning the refusal reads: no file, no release — and it sits
					// beside the media it is about, where the fix lands, as well as in the
					// floating checklist that tracks the whole set.
					<span
						className="absolute right-14 top-4 z-10 flex size-8 items-center justify-center rounded-full bg-base-100/80 text-warning backdrop-blur"
						title={RELEASE_WARNING}
					>
						<ExclamationTriangleIcon aria-hidden="true" className="size-4" />
						<span className="sr-only">{RELEASE_WARNING}</span>
					</span>
				)}
				{!mediaManaging && (
					<div className="absolute right-4 top-4 z-10">
						<SectionPencil
							label={writing ? "Body" : isGoods(current.type) ? "Details" : "Media"}
							onClick={() => {
								// The kinds with one concern open on it; the media kinds keep the
								// last tab they were on, unless a kind change left that tab behind.
								if (writing) setMediaTab("body");
								else if (isGoods(current.type)) setMediaTab("details");
								else if (!mediaManagerTabs.some((tab) => tab.key === mediaTab)) {
									setMediaTab("delivery");
								}
								setMediaManaging((open) => !open);
							}}
						/>
					</div>
				)}
				{mediaManaging ? (
					<WorkMediaManager
						title={writing ? "Body" : isGoods(current.type) ? "Fulfillment Details" : undefined}
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
								thumbnail={current.thumbnail}
								workType={current.type}
								owner
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

			{/* The build's landing, said where the media card is not: adding the first build
			    swaps the card to the deliverable, so the editor that announced it is gone. */}
			{buildMessage && (
				<div className="alert alert-success text-sm" role="status">
					<span className="flex-1">{buildMessage}</span>
					<button
						type="button"
						className="btn btn-ghost btn-xs"
						onClick={() => setBuildMessage(null)}
					>
						Dismiss
					</button>
				</div>
			)}

			{/* ── The byline strip: the title (editable as one section with the dates) on the
			    first line, the creator with the kind and access chips on the second. The
			    rating line is not here — it is the Ratings tab's fact, already above where
			    the tabs name it (Parker's third pass, 2026-10-13). ── */}
			<WorkByline
				work={asRead}
				dates={
					<>
						{titleSection.editing ? datesEdit : datesRead}
						{titleSection.error && <p className="text-xs text-error">{titleSection.error}</p>}
					</>
				}
				// Share rides the maker's line for the creator too (Parker, 2026-10-13), and
				// the Title section's pencil takes the library Save button's place (Parker,
				// 2026-11-07) — a creator's own Work is going to be saved to their Library
				// automatically, so the Save verb is not the creator's to press.
				actions={
					<div className="flex shrink-0 items-center gap-1">
						<ShareLinkButton workId={current.id} slug={asRead.slug ?? ""} />
						{/* The Save button's footprint, kept: the pencil sits at the slot's
						    right edge, so the save check lands on the pencil's rectangle when
						    the section opens (Parker, 2026-11-07). */}
						<div className="flex w-[5.5rem] shrink-0 items-center justify-end">
							{titleSection.actions}
						</div>
					</div>
				}
				title={titleSection.editing ? titleEdit : titleRead}
				// The kind chip is the same chip a reader sees, with its own pencil: only a
				// draft that could still be another kind gets the door (Parker, 2026-10-29).
				kindChip={kindChangeable ? kindField : undefined}
				chips={accessField}
			/>

			{/* ── The record's halves. The rule between them is its own grid column, a
			    two-pixel span the row's full height: it stands at the player's midline and
			    reaches the content area's bottom, which a border on one half only ever
			    reached that half (Parker's third pass, 2026-10-13). Above the whole pair,
			    the same hair laid flat (Parker, 2026-10-16), as the visitor's page draws. ── */}
			<div aria-hidden className="h-0.5 bg-base-content/20" />
			<div className="grid lg:grid-cols-[minmax(0,1fr)_2px_minmax(0,1fr)]">
				<div id="work-info-tabs" className="lg:pr-4">
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
			<ThumbFramePicker
				open={thumbPicker === "frame" && frameChoosable}
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
			<ImageFrameModal
				open={thumbFrame !== null}
				src={thumbFrame?.preview ?? null}
				mediaType="thumbnail"
				busy={thumbSaving}
				error={thumbError}
				initialCrop={thumbFrame?.file ? null : (current.thumbnailCrop ?? null)}
				onCancel={closeThumbFrame}
				onSave={(crop) => void saveFramedThumbnail(crop)}
			/>

			{/* The setup checklist, in the corner while the Work is still being made. It
			    leaves with the release, when there is nothing left to set up. A creator
			    whose own setup is unfinished sees that first; the Work's rows follow once
			    the account can publish at all. */}
			{unpublished && creatorSetupKnown && (
				<div
					className={`fixed right-4 z-40 sm:right-6 ${
						playerUp ? "bottom-40 sm:bottom-24" : "bottom-28 sm:bottom-6"
					}`}
				>
					<SetupChecklist
						variant="floating"
						title={checklist.title}
						intro={checklist.intro}
						items={checklist.items}
					/>
				</div>
			)}
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
	open,
	src,
	captions,
	busy,
	inFlight,
	error,
	onTake,
	onClose,
}: {
	/** Kept mounted while this is false so the shared wrapper can play the exit. */
	open: boolean;
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
	useExclusivePlayback(videoRef);

	// Escape closes, for the keyboard half of the door (the pattern ReportDialog set);
	// the pointer half is the ✕.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	return (
		<Modal open={open} label="Thumbnail from this Work">
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
		</Modal>
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
 * The creator's kind chip (Parker, 2026-10-29): the Work's kind as the byline strip's
 * chip, and for a draft that could still be another kind the chip is the door — it
 * opens the kinds in a dialog, asked for deliberately. It replaced the Kind select: the
 * chip a reader reads is the control a creator changes it with, the same shape as the
 * access chip beside it.
 */
function OwnerKindChipEditor({
	type,
	onSave,
}: {
	type: ContentType;
	onSave: (next: ContentType) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState<ContentType | null>(null);
	const [error, setError] = useState<string | null>(null);
	const dialog = useRef<HTMLDialogElement>(null);
	// The chip's look comes from the same catalog the user page's badge does, so the
	// creator's chip and the reader's cannot drift apart.
	const { label, Icon, color } = contentTypeMeta(type);

	useEffect(() => {
		if (open) dialog.current?.showModal();
	}, [open]);

	const choose = async (next: ContentType) => {
		if (next === type) {
			dialog.current?.close();
			setOpen(false);
			return;
		}
		setBusy(next);
		setError(null);
		try {
			await onSave(next);
			dialog.current?.close();
			setOpen(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "The kind change didn't save.");
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<button
				type="button"
				aria-label={`Change the kind, currently ${label}`}
				title="Change the kind of this Work"
				className={`badge badge-sm cursor-pointer gap-1 py-1.5 pr-2 ${color}`}
				onClick={() => {
					setError(null);
					setOpen(true);
				}}
			>
				<Icon className="w-3 h-3" />
				{label}
				<PencilSquareIcon className="size-3 opacity-60" />
			</button>
			{open && (
				<dialog
					ref={dialog}
					className="modal"
					aria-label="Change the kind of this Work"
					onClose={() => setOpen(false)}
				>
					<div className="modal-box max-w-2xl">
						<h3 className="text-lg font-semibold">Change the Kind</h3>
						<p className="mt-1 text-xs text-base-content/60">
							The kind decides the Work's page, its player or reader, and what its media area
							carries. Changing it unrates the draft — answer the matrix again before release.
						</p>
						<div className="mt-4 grid gap-2 sm:grid-cols-2">
							{LIBRARY_TYPE_OPTIONS.map((option) => {
								const chosen = option.value === type;
								return (
									<button
										key={option.value}
										type="button"
										aria-current={chosen ? "true" : undefined}
										className={`flex items-start gap-2 rounded-box border p-3 text-left transition disabled:opacity-60 ${
											chosen
												? "border-primary bg-primary/10 ring-2 ring-primary/20"
												: "border-base-300 bg-base-200 hover:border-primary/50"
										}`}
										disabled={busy !== null}
										onClick={() => void choose(option.value)}
									>
										<TypeIcon type={option.value} className="size-5 shrink-0 text-primary" />
										<span className="min-w-0">
											<span className="block text-sm font-semibold">{option.label}</span>
											<span className="block text-xs text-base-content/60">
												{WORK_TYPE_DESCRIPTIONS[option.value]}
											</span>
										</span>
									</button>
								);
							})}
						</div>
						{busy && (
							<p
								className="mt-3 flex items-center gap-2 text-xs text-base-content/60"
								role="status"
							>
								<span className="loading loading-spinner loading-xs" />
								Changing the kind…
							</p>
						)}
						{error && <p className="mt-3 text-sm text-error">{error}</p>}
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								onClick={() => dialog.current?.close()}
							>
								Cancel
							</button>
						</div>
					</div>
					<form method="dialog" className="modal-backdrop">
						<button type="button" aria-label="Close the kind dialog" />
					</form>
				</dialog>
			)}
		</>
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
						<h3 className="text-lg font-semibold">Edit Work Access</h3>
						<div className="mt-1 flex flex-col gap-2 text-xs text-base-content/60">
							{/* The one place this is explained. The table used to carry the same
							    explanation again, split from this half by a component boundary, and
							    a creator read it twice before reaching a single field. */}
							<p>
								Choose which Badges have access to this work, and at what price. By default,
								everyone can access your work for free. This is what we call Public Access.
								Streaming works in Public Access still pay, but through users' Time Pool rather than
								direct purchase or subscription to you.
							</p>
							<p>
								To gate access behind Badge subscriptions so only users with those Badges can access
								it, uncheck Everyone and check the specific Badge level(s) that users should be
								required to have to access the work. To set a direct purchase price for the work,
								add a value to the Price column. You can set different prices for different Badge
								levels to offer discounts to users with those Badges.
							</p>
						</div>
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
function BuildsEditor({
	work,
	onChanged,
	onAdded,
}: {
	work: WorkDetail;
	onChanged: () => void;
	/** Reports the landing at the page level: the media card unmounts this editor when the
	 *  first build lands, and a success message inside it would go with it. */
	onAdded?: (message: string | null) => void;
}) {
	const assets = work.assets ?? [];
	const [file, setFile] = useState<File | null>(null);
	const [platform, setPlatform] = useState("windows");
	const [version, setVersion] = useState("");
	const [primary, setPrimary] = useState(false);
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	const add = async (e: FormEvent) => {
		e.preventDefault();
		if (!file) return;
		const name = file.name;
		setBusy(true);
		setError(null);
		onAdded?.(null);
		setProgress(null);
		try {
			const fileKey = await uploadMediaFile(file, "asset", setProgress);
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
			onAdded?.(`${name} is in the builds table.`);
			onChanged();
		} catch {
			setError("Failed to upload build.");
		} finally {
			setBusy(false);
			setProgress(null);
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
							onFileSelect={(picked) => {
								setFile(picked);
								setError(null);
								onAdded?.(null);
							}}
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

			{/* The bar the file picker's own progress had no way to show: a build's bytes
			    travel as one session upload, and the button's "Adding…" said nothing about
			    how far along they were. */}
			{busy && file && <UploadProgressBar fileName={file.name} progress={progress} />}

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
