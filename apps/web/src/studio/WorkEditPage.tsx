// SPDX-License-Identifier: Apache-2.0
/**
 * Edit a **Work** — the Catalog's authoring surface, and the second of the two pages a Work is
 * made on. `WorkUploadPage` makes the Work from its file and lands here; returning to a Work from
 * anywhere in the Studio lands here too.
 *
 * ⭐ **The page is the Work as a reader sees it, with what they see editable in place** (Parker,
 * 2026-09-17: *"the edit page should feel more like the public page, rather than just being an
 * isolated form where the creator can't get a feel for how the work will look"*). The title, the
 * dates, the rating, the Work itself, its cover, its lyrics, its description and its downloads
 * sit where a reader meets them, drawn by the same parts the public page is drawn with
 * (`components/work/WorkLayout.tsx`). Everything a reader never sees (delivery, the rating's
 * controls, access and release) is gathered below under a heading that says so. That shared
 * layout is why this page lives in `apps/web` rather than beside the other Studio pages in
 * `@anthers/web-shared`: the players belong to this app.
 *
 * 🚨 **The container is the point, and it is about addressability rather than size.** Two
 * controls on this page send the creator somewhere else: the Access table needs Badge rungs
 * that live in Settings, and Release needs payout setup that lives in Settings. Both are
 * things a first-time creator meets on their first Work, and from the modal this used to be
 * they were an instruction to discard everything typed. A page can be left and come back to.
 * The rest follows from having a URL at all — the Catalog card's Edit is a link, the
 * blocked-release hint is a link, and an e2e walk can reach the page by typing it.
 *
 * 🚨 **The Work's file may still be uploading while this page is open, and the save is shaped
 * around that.** The Upload page creates the Work the moment its file is picked (Parker,
 * 2026-09-16) and `lib/work-uploads` attaches the file when it lands. So this save never sends a
 * `sourceKey`, and sends a thumbnail only when the creator changed it: the server makes an image
 * its own thumbnail when its file arrives, and a save carrying the empty thumbnail this page
 * loaded would erase it. When an upload for this Work finishes, the media half of the row is
 * re-read without touching anything typed.
 *
 * **One explicit Save, and the page stays where it is** (Parker, 2026-09-17). A bar appears while
 * anything is unsaved, with Save and Discard, and saving leaves the creator looking at the result
 * rather than sending them to the Catalog. Keeping one save keeps the upload handling above in one
 * code path. `work-edit.ts` decides what counts as unsaved.
 *
 * The route is keyed on **`publicId`**, the durable public address a Work carries, not on
 * the internal row id. `GET /works/:id` resolves either and short-circuits to the
 * owner-facing serialization for the creator, which is the shape with the editable access
 * table in it; every mutation then goes out on the numeric `id` from that response, because
 * `PATCH`, `DELETE` and the asset routes take that one alone.
 *
 * 🚨 **Release is edit-only.** `POST /works` refuses `visibility: "released"` outright
 * (`code: "release_on_create"`) — release is a separate deliberate act, which is the whole
 * point of separating the Catalog from posting — and the Upload page offers no release control.
 */

import {
	isEmptyWriting,
	isOwnThumbnail,
	needsChosenThumbnail,
	THUMBNAIL_RULE,
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
import { useAuth } from "@anthers/web-shared/auth";
import RatingAppeal from "@anthers/web-shared/content/RatingAppeal";
import {
	fileRules,
	isFileWorkType,
	UploadProgress,
	useWorkDetails,
	WorkFileSection,
} from "@anthers/web-shared/content/work-media";
import { authoredToIso, isoToAuthoredValue } from "@anthers/web-shared/content/work-state";
import { isBuildType, typeLabel } from "@anthers/web-shared/content/works";
import RichTextEditor from "@anthers/web-shared/editor/RichTextEditor";
import { isoToLocalInput, localInputToIso } from "@anthers/web-shared/local-datetime";
import { usePayoutsReady } from "@anthers/web-shared/payouts";
import AccessTables, {
	buildSeedRows,
	type SeedRowDraft,
	serializeSeedRows,
} from "@anthers/web-shared/post/AccessTables";
import { keyToPreview, uploadImageFile } from "@anthers/web-shared/post/mediaUpload";
import { workUrl } from "@anthers/web-shared/postUrl";
import { publishingPermissionMissing, usePublishingState } from "@anthers/web-shared/publishing";
import {
	RATED_PUBLIC_ACCESS_HELP,
	showsRatedPublicAccessNotice,
} from "@anthers/web-shared/rated-public-access";
import { Link, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { studioUrl } from "@anthers/web-shared/studio";
import type {
	AuthoredPrecision,
	CreatorGate,
	UploadableWorkType,
	Work,
	WorkInput,
} from "@anthers/web-shared/types";
import FileUpload from "@anthers/web-shared/ui/FileUpload";
import FormField from "@anthers/web-shared/ui/FormField";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { uploadMediaFile } from "@anthers/web-shared/upload";
import { isUploading, useWorkUploads, workUploads } from "@anthers/web-shared/work-uploads";
import { ArrowUpTrayIcon, CalendarIcon, EyeIcon, TrashIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	isWriting,
	WORK_DESCRIPTION_CLASS,
	WORK_LYRICS_CLASS,
	WORK_LYRICS_HEADING_CLASS,
	WorkColumn,
	WorkDeliverable,
	type WorkDetail,
	WorkHeader,
	WRITING_BODY_STYLE,
	WRITING_STANDFIRST_CLASS,
	workTitleTypography,
} from "../components/work/WorkLayout";
import { useMediaPlayer } from "../lib/media-player";
import { frameOf } from "../lib/video-frame";
import RatingMatrix from "./RatingMatrix";
import { unsavedKey } from "./work-edit";

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The creator's own view of one Work, or null when it is not theirs or does not exist. */
async function fetchOwnWork(id: string | number): Promise<Work | null> {
	const res = await client.api.content.works[":id"].$get({ param: { id: String(id) }, query: {} });
	if (!res.ok) return null;
	const { work } = (await res.json()) as unknown as { work: Work };
	return work;
}

/**
 * A control that reads as the text it edits: no box until it is pointed at or focused, so the
 * page looks like the Work rather than like a form laid over it.
 */
const IN_PLACE =
	"rounded-md border border-transparent bg-transparent px-2 -mx-2 hover:border-base-300 focus:border-primary focus:outline-none";

/** A text area that grows with what is in it, the way the text it stands in for would. */
const GROWS = "resize-none [field-sizing:content]";

export default function WorkEditPage() {
	const { publicId } = useParams<{ publicId: string }>();
	const [loading, setLoading] = useState(true);
	const [loaded, setLoaded] = useState<Work | null>(null);
	/** Bumped by Discard, which reloads the Work and rebuilds the page from what is saved. */
	const [generation, setGeneration] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new generation is a reload, and is the only reason it changes
	useEffect(() => {
		if (!publicId) return;
		let live = true;
		setLoading(true);
		fetchOwnWork(publicId)
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
	}, [publicId, generation]);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (!loaded) {
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

	// Keyed so that moving from one Work's page to another's rebuilds the page rather than
	// carrying the first Work's typed state into the second, and so a Discard starts afresh.
	return (
		<WorkEditor
			key={`${loaded.id}:${generation}`}
			editing={loaded}
			onDiscard={() => setGeneration((g) => g + 1)}
		/>
	);
}

function WorkEditor({ editing, onDiscard }: { editing: Work; onDiscard: () => void }) {
	const { user } = useAuth();
	const { currentTrack } = useMediaPlayer();

	const [current, setCurrent] = useState<Work>(editing);
	const type = editing.type as UploadableWorkType;
	// Which rating grid this Work is rated on, which its type alone decides.
	const grid = gridFor(type);

	const [title, setTitle] = useState(editing.title ?? "");
	const [description, setDescription] = useState(editing.description ?? "");
	// A piece of writing's body, written in place in the typography it is read in. The plain-text
	// shadow goes with it, as it does from the post editor, because search reads that one.
	const writing = isWriting(editing.type);
	const [bodyHtml, setBodyHtml] = useState(editing.bodyHtml ?? "");
	const [bodyText, setBodyText] = useState(editing.body ?? "");
	const handleBody = (html: string) => {
		setBodyHtml(html);
		const holder = document.createElement("div");
		holder.innerHTML = html;
		setBodyText(holder.textContent ?? "");
	};
	const [lyrics, setLyrics] = useState(editing.lyrics ?? "");
	const [thumbnailUrl, setThumbnailUrl] = useState(editing.thumbnail ?? "");
	const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(
		editing.thumbnail ? keyToPreview(editing.thumbnail) : null,
	);
	/**
	 * Whether the creator changed the thumbnail here, and so whether a save may send it. A ref,
	 * because the re-reads below run from timers and must see the answer as it is now.
	 */
	const thumbnailTouched = useRef(false);
	/** The video's `<video>` element, once it plays, for *Use This Frame*. */
	const videoEl = useRef<HTMLVideoElement | null>(null);
	/** Why taking a frame did not work, said beside the button. */
	const [frameError, setFrameError] = useState<string | null>(null);

	const details = useWorkDetails(type, editing);

	// Created date — the creator's claim about when the work was MADE, distinct from the
	// upload date (`createdAt`, creator-facing only) and the release date (ours).
	const [authoredPrecision, setAuthoredPrecision] = useState<AuthoredPrecision | null>(
		editing.authoredAt ? (editing.authoredPrecision ?? "day") : null,
	);
	const [authoredValue, setAuthoredValue] = useState(() =>
		editing.authoredAt
			? isoToAuthoredValue(editing.authoredAt, editing.authoredPrecision ?? "day")
			: "",
	);

	// Delivery. A Work must keep at least one of them on, which the server enforces against the
	// state the edit RESULTS IN.
	const [streamEnabled, setStreamEnabled] = useState(editing.streamEnabled ?? true);
	const [downloadEnabled, setDownloadEnabled] = useState(editing.downloadEnabled ?? false);

	// The content rating, as the matrix a creator marks row by row (`RatingMatrix`). Nothing is
	// preselected: an unanswered row is not a declaration, and a default would be the editor
	// answering on the creator's behalf, which is the one thing `unrated` exists in the schema to
	// prevent. The release checkbox below refuses to be ticked until there is a rating.
	const [rows, setRows] = useState<MaturityRows>(() =>
		normalizeMaturityRows(editing.maturityRows, grid),
	);
	/**
	 * Whether the rows differ from what is saved, and so whether a save sends them. Sent
	 * unchanged, they would re-declare the rating they add up to, which an operator's correction
	 * above it would refuse on every save of anything else.
	 */
	const rowsChanged =
		JSON.stringify(normalizeMaturityRows(rows, grid)) !==
		JSON.stringify(normalizeMaturityRows(current.maturityRows, grid));
	// The rating the page stands at: what the rows add up to once every row is answered, and the
	// Work's own rating until then, because an incomplete matrix changes no rating on the server.
	// 🚨 Release and scheduling wait on `fromRows` rather than on `maturity`: a rated Work has every
	// row answered (Parker, 2026-09-18), and the server refuses a stored rating with none behind it.
	const fromRows = ratingFromRows(rows);
	const storedMaturity =
		current.maturity && current.maturity !== "unrated" ? current.maturity : null;
	const maturity = fromRows ?? storedMaturity;
	const contentNotes = fromRows
		? notesFromRows(rows)
		: normalizeContentNotes(current.maturityNotes ?? []);
	// An operator's correction. The creator may make it more cautious at any time and may
	// not make it less, so the control stays live and the appeal is what the copy points at.
	const maturityLocked = current.maturityLocked ?? false;

	// Access. The creator's Badge ladder is fetched below because rungs live on the creator,
	// not on the Work — `buildSeedRows` merges the Work's stored rows onto whatever rungs
	// exist, so the rows are the only state worth holding.
	const [seedRows, setSeedRows] = useState<SeedRowDraft[]>(() =>
		buildSeedRows([], editing.seedAccess),
	);

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [visibility, setVisibility] = useState<"private" | "released">(
		editing.visibility === "released" ? "released" : "private",
	);

	// A scheduled release, as the datetime input holds it. Sent only when changed, so a Work
	// waiting past its time on processing still saves: the route checks a changed schedule, and
	// an unchanged one in the past would read as a new time that has already gone by. Read off
	// the last SAVED row rather than the loaded one, because a save leaves the page open.
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
	/**
	 * Whether the server holding the creator's identity is down. Said here as well as in the
	 * banner, because this is the moment it touches what they are doing — and it blocks nothing.
	 */
	const serverDown = publishing?.server?.reachable === false;

	// Uploads into this Work from this tab — its own file, and any builds started on the Upload
	// page. When one lands, the row's media half is re-read, so the file section, the builds
	// table and an image's new thumbnail catch up without discarding anything typed.
	const uploads = useWorkUploads().filter((u) => u.workId === editing.id);
	const landed = uploads.filter((u) => u.status === "done").length;
	/** How many landed uploads the row has been re-read after — see `WorkFileSection`'s `landing`. */
	const [readAfter, setReadAfter] = useState(0);
	const buildUploads = uploads.filter((u) => u.target.kind === "build" && u.status !== "done");
	const fileUploading = uploads.some((u) => u.target.kind === "source" && isUploading(u));
	/**
	 * Re-read the media half of the row — the file, its processing, the builds, and a thumbnail
	 * the server set — without touching anything the creator has typed.
	 */
	const refreshMedia = async (afterLanded?: number) => {
		const fresh = await fetchOwnWork(editing.id).catch(() => null);
		if (!fresh) return;
		if (afterLanded != null) setReadAfter(afterLanded);
		setCurrent((prev) => ({
			...prev,
			sourceKey: fresh.sourceKey,
			thumbnail: fresh.thumbnail,
			assets: fresh.assets,
			transcoding: fresh.transcoding,
			pageCount: fresh.pageCount,
		}));
		if (!thumbnailTouched.current && fresh.thumbnail) {
			setThumbnailUrl(fresh.thumbnail);
			setThumbnailPreview(keyToPreview(fresh.thumbnail));
		}
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: re-read on each upload that lands, and only then
	useEffect(() => {
		if (landed > 0) void refreshMedia(landed);
	}, [landed]);

	// While the file is processing, follow it, so the progress and estimate move on the page a
	// creator lands on after uploading. Ticks are skipped while the tab is hidden, as the
	// Catalog's are.
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
		thumbnailTouched.current = true;
		setThumbnailPreview(URL.createObjectURL(file));
		try {
			const { url } = await uploadImageFile(file, "thumbnail");
			setThumbnailUrl(url);
			setThumbnailPreview(url);
		} catch {
			setThumbnailPreview(thumbnailUrl ? keyToPreview(thumbnailUrl) : null);
		}
	};

	/** Make the frame the video is paused on its thumbnail. See `lib/video-frame.ts`. */
	const takeCurrentFrame = async () => {
		setFrameError(null);
		const video = videoEl.current;
		if (!video?.videoWidth) {
			setFrameError("Play the video to the moment you want first.");
			return;
		}
		let frame: File;
		try {
			frame = await frameOf(video);
		} catch {
			setFrameError("This browser can't take a frame from the video. Upload an image instead.");
			return;
		}
		await handleThumbnail(frame);
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

	/** What a save would send, as the page stands. */
	const payload = (): WorkInput => {
		const json: WorkInput = {
			title: title.trim(),
			description: description.trim(),
			// Sent unconditionally on a music Work, including empty — deleting the lyrics
			// is a real edit, and an omitted field cannot express it.
			...(type === "music" ? { lyrics } : {}),
			// Only when changed here: see the header on why a save must not carry what was loaded.
			...(thumbnailTouched.current ? { thumbnail: thumbnailUrl } : {}),
			visibility,
			...(visibility !== "released" && scheduledRelease !== loadedSchedule
				? { scheduledReleaseAt: scheduledIso }
				: {}),
			streamEnabled,
			downloadEnabled,
			seedAccess: serializeSeedRows(seedRows),
			// Sent unconditionally, including as `null` — clearing a Created date is a real
			// edit, and an omitted field cannot express it. The server clears the precision
			// alongside it, since a precision without a date claims accuracy about nothing.
			authoredAt: authoredToIso(authoredPrecision, authoredValue),
			...details.fields(),
			...(writing ? { bodyHtml, body: bodyText } : {}),
		};
		if (rowsChanged) json.maturityRows = normalizeMaturityRows(rows, grid);
		if (authoredPrecision && json.authoredAt) json.authoredPrecision = authoredPrecision;
		return json;
	};

	// What the page last saved or loaded, as `unsavedKey` reduces it. Null for the moment between
	// a save and the render after it, which re-baselines on what then stands: a save changes what
	// the page would send next (the thumbnail stops being "changed here"), without changing
	// anything the creator has to save again.
	const key = unsavedKey(payload());
	const [baseline, setBaseline] = useState<string | null>(null);
	useEffect(() => {
		setBaseline((b) => b ?? key);
	}, [key]);
	const dirty = baseline !== null && key !== baseline;
	const [savedAt, setSavedAt] = useState<number | null>(null);
	useEffect(() => {
		if (savedAt == null) return;
		const timer = setTimeout(() => setSavedAt(null), 4000);
		return () => clearTimeout(timer);
	}, [savedAt]);

	// Closing the tab on unsaved changes is asked about. Moving around the app is not, because
	// the router this app uses has no way to hold a navigation, and the bar is the warning there.
	useEffect(() => {
		if (!dirty) return;
		const warn = (e: BeforeUnloadEvent) => e.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);

	const handleSave = async () => {
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(current.id) },
				json: payload(),
			});
			if (!res.ok) {
				await failed(res, "Failed to save this Work.");
				return;
			}
			const { work: updated } = await res.json();
			setCurrent(updated as Work);
			thumbnailTouched.current = false;
			setBaseline(null);
			setSavedAt(Date.now());
		} catch {
			setError("Failed to save this Work.");
		} finally {
			setSaving(false);
		}
	};

	// ── Builds (game/software downloadable assets) ──
	// These persist the moment they are added or deleted, as they always have, so they are never
	// part of what the bar calls unsaved.

	const assets = current.assets ?? [];
	const [buildFile, setBuildFile] = useState<File | null>(null);
	const [buildPlatform, setBuildPlatform] = useState("windows");
	const [buildVersion, setBuildVersion] = useState("");
	const [buildPrimary, setBuildPrimary] = useState(false);
	const [buildUploading, setBuildUploading] = useState(false);

	const handleAddBuild = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!buildFile) return;
		setBuildUploading(true);
		setError(null);
		try {
			const fileKey = await uploadMediaFile(buildFile, "asset");
			const res = await client.api.content.works[":id"].assets.$post({
				param: { id: String(current.id) },
				json: {
					file: fileKey,
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
			setCurrent((prev) => ({ ...prev, assets: [asset, ...prev.assets] }));
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
		try {
			const res = await client.api.content.works[":id"].assets[":assetId"].$delete({
				param: { id: String(current.id), assetId: String(assetId) },
			});
			if (!res.ok) throw new Error("Delete failed");
			setCurrent((prev) => ({ ...prev, assets: prev.assets.filter((a) => a.id !== assetId) }));
		} catch {
			setError("Failed to delete build.");
		}
	};

	// Mirrors the server's own definition of the commons (`isFree && streamEnabled &&
	// released`) against the rows as they stand on the page, so the notes answer for what is
	// about to be saved rather than for what was loaded.
	const anyoneAllowed = seedRows.some((r) => r.allow);
	const baselineRow = seedRows.find((r) => r.threshold === 0);
	const publicAccessNow = !!baselineRow?.allow && Number(baselineRow.price) === 0 && streamEnabled;
	// The server refuses to release a file-kind Work with no file (`media_missing`); don't offer
	// the click that earns it. An upload in flight from this tab is the same state, sooner.
	const fileMissing = isFileWorkType(type) && (!current.sourceKey || fileUploading);
	// And the same for a piece of writing with nothing in it yet (`text_missing`), which is the
	// creator's to fix rather than to wait for, so it locks scheduling as well as releasing.
	const writingEmpty = writing && isEmptyWriting(bodyHtml);
	// And a video with no thumbnail its creator chose (`thumbnail_missing`), judged against the
	// thumbnail this page would save, which is also the creator's to fix.
	const thumbnailMissing = needsChosenThumbnail(type) && !thumbnailUrl;
	/**
	 * Whether the Work itself can be shown as a reader sees it: its file is here, and whatever
	 * processing it needs has finished. Until then the file section stands in for it, with the
	 * upload's or the processing's progress.
	 */
	const fileReady =
		isFileWorkType(type) &&
		!!current.sourceKey &&
		!fileUploading &&
		(type === "image" || current.transcoding?.status === "completed");

	/**
	 * The Work as the reader's page would draw it: the saved row, with the creator named as a
	 * reader sees them. The fields being edited are drawn by the controls in their slots, so
	 * what the parts read from here is only what the page does not edit in place.
	 */
	const asRead: WorkDetail = {
		...current,
		sourceKey:
			type === "image" && current.sourceKey ? keyToPreview(current.sourceKey) : current.sourceKey,
		creator: user?.handle
			? {
					handle: user.handle,
					displayName: user.displayName ?? null,
					avatar: user.avatar ?? null,
				}
			: undefined,
	};
	const released = current.releasedAt
		? new Date(current.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;

	const lyricsEditor =
		type === "music" ? (
			/*
			 * Lyrics — plain text, untimestamped, under the player where a listener reads them.
			 *
			 * The help text says the gate covers them on purpose. Lyrics ride with the payload
			 * (`serializeWorkForViewer` blanks them alongside the audio), and a creator who
			 * assumed the opposite would only find out from a reader. The escape hatch is stated
			 * too: Description stays visible when locked.
			 */
			<section className={WORK_LYRICS_CLASS}>
				<h2 className={WORK_LYRICS_HEADING_CLASS}>Lyrics</h2>
				<textarea
					aria-label="Lyrics"
					className={`${IN_PLACE} ${GROWS} w-full min-h-32 font-mono text-sm leading-relaxed`}
					value={lyrics}
					onChange={(e) => setLyrics(e.target.value)}
					rows={8}
					placeholder={"One line per line.\nBlank lines separate verses."}
				/>
				<p className="mt-1 text-xs text-base-content/50">
					Shown while the track plays. Gated with the audio — if this track is behind a Badge Gate
					or a price, the words are too. Put anything you want everyone to read in the Description
					instead.
				</p>
			</section>
		) : null;

	/*
	 * 🚨 **The hint is the point, not decoration.** A description is shown to
	 * everyone — including somebody who has not cleared this Work's gate, and, once
	 * a creator holds an Anthers handle, on the AT Protocol network where it cannot
	 * be un-published. A creator writing one aimed at buyers would reasonably assume
	 * it sat behind the gate with everything else, and the label said nothing.
	 * Saying so is what makes this a field the creator controls rather than one
	 * they are caught by. A piece of writing sets it as its standfirst.
	 */
	const descriptionEditor = (
		<section>
			<textarea
				aria-label="Description"
				className={`${writing ? WRITING_STANDFIRST_CLASS : WORK_DESCRIPTION_CLASS} ${IN_PLACE} ${GROWS} w-full ${writing ? "min-h-12" : "min-h-16"}`}
				style={writing ? WRITING_BODY_STYLE : undefined}
				value={description}
				onChange={(e) => setDescription(e.target.value)}
				rows={writing ? 2 : 3}
				placeholder={writing ? "A line or two under the headline…" : "Describe this Work…"}
			/>
			<p className="text-xs text-base-content/50">
				Shown to everyone, including people who haven't unlocked this.
			</p>
		</section>
	);

	return (
		<WorkColumn type={type}>
			{/* What this page is, and the way to see it exactly as a reader does. The reader's view
			    shows what is saved, which is why it says so while anything is not. */}
			<div className="flex flex-wrap items-center gap-2">
				<h1 className="text-sm font-semibold">Edit {typeLabel(type)}</h1>
				<span
					className={`badge badge-sm ${current.visibility === "released" ? "badge-success" : "badge-ghost"}`}
				>
					{current.visibility === "released" ? "Released" : "Private"}
				</span>
				<span className="text-xs text-base-content/60">
					Laid out as a reader sees it. Change what they see in place, and everything else below.
				</span>
				<Link
					to={`${workUrl(current)}?previewAs=out`}
					className="btn btn-outline btn-sm gap-1.5 ml-auto"
					title={dirty ? "Shows what's saved, so save first to see your changes there" : undefined}
				>
					<EyeIcon className="size-4" />
					Preview as a reader
				</Link>
			</div>

			<WorkHeader
				work={asRead}
				title={
					// A text area rather than an input, because a title wraps where a reader sees it
					// and an input cannot. It grows to its content, and Enter is refused, since a
					// title is one line that happens to be long.
					<textarea
						aria-label="Title"
						rows={1}
						className={`${workTitleTypography(type).className} ${IN_PLACE} ${GROWS} w-full min-w-0 flex-1`}
						style={workTitleTypography(type).style}
						value={title}
						onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
						onKeyDown={(e) => {
							if (e.key === "Enter") e.preventDefault();
						}}
						placeholder="Work title"
					/>
				}
				dates={
					<CreatedDate
						precision={authoredPrecision}
						value={authoredValue}
						released={released}
						onPrecision={(next) => {
							// Re-cut the value to the new precision rather than dropping it, so
							// narrowing "2015-06" to a year keeps 2015 instead of blanking.
							const iso = authoredToIso(authoredPrecision, authoredValue);
							setAuthoredPrecision(next);
							setAuthoredValue(next ? isoToAuthoredValue(iso, next) : "");
						}}
						onValue={setAuthoredValue}
					/>
				}
				rating={<RatingLine maturity={maturity} notes={contentNotes} />}
			/>

			{/* A piece of writing's description is its standfirst, under the headline. */}
			{writing && descriptionEditor}

			{/* ── The Work itself ── */}
			<section className="space-y-4">
				{isFileWorkType(type) &&
					(fileReady ? (
						<>
							<WorkDeliverable work={asRead} lyrics={lyricsEditor} videoRef={videoEl} />
							{/* An image is replaced in place, as it could be before it had an upload
							    step. Other kinds are not offered this: a new video re-encodes, and a
							    released one would be unplayable while it did. */}
							{type === "image" && (
								<div className="max-w-xs">
									<FileUpload
										accept={fileRules("image").accept}
										maxSize={fileRules("image").maxSize}
										compact
										label="Replace the image"
										onFileSelect={(file) =>
											workUploads.start(current.id, file, { kind: "source", type: "image" })
										}
									/>
								</div>
							)}
						</>
					) : (
						<>
							<WorkFileSection work={current} landing={landed > readAfter} />
							{lyricsEditor}
						</>
					))}
				{/* A game or software's embedded build: the address it runs from, and the build
				    running from it once saved. */}
				{isBuildType(type) && (
					<>
						{details.slot}
						{current.embedUrl && <WorkDeliverable work={asRead} />}
					</>
				)}

				{/* A piece of writing is its body, written here in the typography it is read in. */}
				{writing && (
					<RichTextEditor
						variant="article"
						content={bodyHtml}
						onChange={handleBody}
						placeholder="Start writing…"
					/>
				)}

				{/* An image is its own thumbnail, so it has no control of its own. */}
				{!isOwnThumbnail(type) && (
					<Thumbnail
						preview={thumbnailPreview}
						required={needsChosenThumbnail(type)}
						onFile={handleThumbnail}
						onClear={() => {
							thumbnailTouched.current = true;
							setThumbnailUrl("");
							setThumbnailPreview(null);
						}}
						onFrame={type === "video" && fileReady ? takeCurrentFrame : undefined}
						frameError={frameError}
					/>
				)}
			</section>

			{!writing && descriptionEditor}

			{isBuildType(type) && (
				<section className="flex flex-col gap-3">
					<h2 className="font-semibold">Downloadable Builds</h2>

					{buildUploads.map((upload) => (
						<div key={upload.id} className="flex flex-col gap-2">
							{upload.status === "failed" ? (
								<div className="alert alert-error text-sm">
									<span className="flex-1">{upload.error}</span>
									<button
										type="button"
										className="btn btn-sm"
										onClick={() => workUploads.retry(upload.id)}
									>
										Try again
									</button>
								</div>
							) : (
								<UploadProgress upload={upload} />
							)}
						</div>
					))}

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
				</section>
			)}

			{/* ── What a reader never sees ── */}
			<section
				aria-labelledby="work-settings-heading"
				className="rounded-box border border-base-300 bg-base-200/40 p-5 flex flex-col gap-4"
			>
				<div>
					<h2 id="work-settings-heading" className="text-lg font-semibold">
						Only you see these
					</h2>
					<p className="text-xs text-base-content/60">
						How this Work is delivered, rated, gated and released.
					</p>
				</div>

				{/* A physical good's or a service's note is for the creator's own fulfillment and is
				    shown to nobody, so it sits here rather than on the page. */}
				{!isFileWorkType(type) && !isBuildType(type) && details.slot}

				<div className="flex flex-col gap-3">
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

				{/* The content rating, as one matrix of content and rating. Nothing is preselected —
				    see the state above. */}
				<div id="work-rating" className="border-t border-base-300 pt-4 flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Rating</h2>
					<RatingMatrix grid={grid} rows={rows} onChange={setRows} />
					{!fromRows && storedMaturity && (
						<p className="text-xs text-base-content/60">
							This Work is rated {maturityLabel(storedMaturity)} today, but not every row is
							answered. Answering every row replaces that with the rating the rows add up to.
							{current.visibility === "released" &&
								" Until then, readers who hide a kind of content won't see it."}
						</p>
					)}
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

				<div className="border-t border-base-300 pt-4 flex flex-col gap-3">
					<h2 className="font-semibold text-sm">Access</h2>
					<AccessTables seedRows={seedRows} onSeedChange={setSeedRows} />
					{seedRows.length === 1 && (
						<p className="text-xs text-base-content/50">
							Want to gate this by monthly support?{" "}
							<Link to={studioUrl("/settings")} className="link">
								Add Badge rungs in Settings
							</Link>{" "}
							and they appear here. Save first, and this page is here when you come back.
						</p>
					)}
				</div>

				<div className="border-t border-base-300 pt-4 flex flex-col gap-2">
					<h2 className="font-semibold text-sm">Release</h2>
					<label className="label cursor-pointer justify-start gap-2">
						<input
							type="checkbox"
							className="checkbox checkbox-sm checkbox-primary"
							checked={visibility === "released"}
							// The server refuses a release with an unanswered row with
							// `maturity_undeclared`, one with no payout setup with `payouts_required`,
							// one Anthers has no permission to list with
							// `publishing_permission_required`, and one whose file has not arrived with
							// `media_missing`. Don't offer the click that fails — the same reasoning as
							// the delivery switches above. `=== false` and `=== true` rather than
							// truthiness, so an unanswered status request leaves the control alone
							// instead of locking it for a reason nobody stated. The rating, file and
							// permission checks apply only before release, so none of them locks the
							// control that would make a released Work private.
							disabled={
								payoutsReady === false ||
								((!fromRows ||
									fileMissing ||
									writingEmpty ||
									thumbnailMissing ||
									permissionMissing === true) &&
									visibility !== "released")
							}
							onChange={(e) => {
								setVisibility(e.target.checked ? "released" : "private");
								// Releasing now supersedes a schedule, as it does on the server.
								if (e.target.checked) setScheduledRelease("");
							}}
						/>
						<span className="label-text text-sm">Released to my public Catalog</span>
					</label>
					{/*
					 * The released Work's listing on the network, as its record, read raw from the
					 * creator's own server (Parker, 2026-09-18). Said of what is SAVED, since a listing
					 * is written after a save rather than while a box is ticked, and "not yet" rather
					 * than "missing": the listing is written by a job a moment after release, and one
					 * that cannot be written is explained by the permission warnings instead.
					 */}
					{current.visibility === "released" &&
						(current.recordUrl ? (
							<p className="text-xs text-base-content/60">
								Its listing is on the network, where other software can read it.{" "}
								<a href={current.recordUrl} target="_blank" rel="noreferrer" className="link">
									View the record
								</a>
							</p>
						) : (
							<p className="text-xs text-base-content/50">Its listing isn't on the network yet.</p>
						))}
					{/*
					 * Scheduling. It is refused for the things only the creator can fix, exactly as the
					 * checkbox is, and not for a file still uploading or processing, because waiting on
					 * those is what a schedule is for. `jobs/release-scheduled.ts` is what happens at
					 * the time.
					 */}
					{visibility !== "released" && (
						<div className="flex flex-col gap-1">
							<span className="text-sm">Or release it later</span>
							<div className="flex flex-wrap items-center gap-2">
								<input
									type="datetime-local"
									className="input input-bordered input-sm"
									aria-label="Release time"
									value={scheduledRelease}
									disabled={
										!fromRows ||
										writingEmpty ||
										thumbnailMissing ||
										payoutsReady === false ||
										permissionMissing === true
									}
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
					{writingEmpty && visibility !== "released" && (
						<p className="text-xs text-warning">
							Write something above first. There's nothing to release until this piece has words in
							it.
						</p>
					)}
					{thumbnailMissing && visibility !== "released" && (
						<p className="text-xs text-warning">
							Choose a thumbnail above first. A video isn't released without one.
						</p>
					)}
					{fileMissing && visibility !== "released" && (
						<p className="text-xs text-warning">
							{fileUploading
								? "This can be released once its file has finished uploading and processing."
								: "Upload this Work's file above first. There's nothing to release until it arrives."}
						</p>
					)}
					{!fromRows && visibility !== "released" && (
						<p className="text-xs text-warning">
							Answer every row of the Rating above first. Nothing goes into your public Catalog
							until every row has an answer.
						</p>
					)}
					{serverDown && visibility !== "released" && (
						<div className="alert alert-info text-sm">
							<span>
								The server holding your identity isn't answering right now. You can still release
								this: it goes out on Anthers straight away, and its listing reaches the network once
								the server is back.
								{publishing?.server?.statusUrl && (
									<>
										{" "}
										<a
											href={publishing.server.statusUrl}
											target="_blank"
											rel="noreferrer"
											className="link"
										>
											Check its status
										</a>
										.
									</>
								)}
							</span>
						</div>
					)}
					{permissionMissing === true && visibility !== "released" && (
						<div className="alert alert-warning text-sm">
							<span>
								<strong>Give Anthers permission to publish before releasing.</strong> A release
								writes this Work's listing into your own repository, and Anthers doesn't have your
								permission to do that.{" "}
								<Link to={studioUrl("/settings")} className="link">
									Give it in Studio settings
								</Link>
								, and save anything you've changed here before you go.
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
								<Link to={studioUrl("/settings")} className="link">
									Set it up in Studio settings
								</Link>
								, and save anything you've changed here before you go.
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
					{showsRatedPublicAccessNotice({
						released: visibility === "released",
						publicAccess: publicAccessNow,
						maturity,
					}) && (
						// Info rather than warning: nothing is wrong, and the note must not read as a
						// reason to rate lower or leave Public Access. See `rated-public-access.ts`.
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
						Released means listed publicly. It does not mean free — the Access table decides that.
					</p>
				</div>
			</section>

			<SaveBar
				dirty={dirty}
				saving={saving}
				saved={savedAt != null}
				error={error}
				// Above the player bar when one is showing, rather than behind it.
				raised={currentTrack != null}
				onSave={handleSave}
				onDiscard={onDiscard}
			/>
		</WorkColumn>
	);
}

/**
 * The Created date, where a reader sees "Made 2015": the creator's claim about when the work was
 * made, at the precision they pick, beside the release date Anthers records.
 */
function CreatedDate({
	precision,
	value,
	released,
	onPrecision,
	onValue,
}: {
	precision: AuthoredPrecision | null;
	value: string;
	released: string | null;
	onPrecision: (next: AuthoredPrecision | null) => void;
	onValue: (next: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<div className="flex flex-wrap items-center gap-2 text-sm text-base-content/60">
				<CalendarIcon className="w-4 h-4" />
				<span>Made</span>
				<select
					aria-label="Created date"
					className="select select-bordered select-xs w-auto"
					value={precision ?? ""}
					onChange={(e) => onPrecision((e.target.value || null) as AuthoredPrecision | null)}
				>
					<option value="">Not stated</option>
					<option value="year">Year</option>
					<option value="month">Month</option>
					<option value="day">Exact date</option>
				</select>
				{precision === "year" && (
					<input
						type="number"
						aria-label="Year made"
						className="input input-bordered input-xs w-24"
						value={value}
						min="1900"
						max="2200"
						placeholder="2015"
						onChange={(e) => onValue(e.target.value)}
					/>
				)}
				{precision === "month" && (
					<input
						type="month"
						aria-label="Month made"
						className="input input-bordered input-xs"
						value={value}
						onChange={(e) => onValue(e.target.value)}
					/>
				)}
				{precision === "day" && (
					<input
						type="date"
						aria-label="Date made"
						className="input input-bordered input-xs"
						value={value}
						onChange={(e) => onValue(e.target.value)}
					/>
				)}
				{released && <span>Released {released}</span>}
			</div>
			<p className="text-xs text-base-content/40">
				When this was made, not when you uploaded it, to whatever precision you know it.
			</p>
		</div>
	);
}

/**
 * The rating where a reader meets it, above the Work. A reader sees nothing for a General Work,
 * so the creator's version always says what the rating is, and says so loudly while there is
 * none, since nothing can be released until there is.
 */
function RatingLine({
	maturity,
	notes,
}: {
	maturity: Exclude<MaturityRating, "unrated"> | null;
	notes: ContentNote[];
}) {
	const change = (
		<button
			type="button"
			className="link link-hover text-xs"
			onClick={() => document.getElementById("work-rating")?.scrollIntoView({ behavior: "smooth" })}
		>
			{maturity ? "Change" : "Rate it"}
		</button>
	);
	const label = maturity ? maturityLabel(maturity) : null;
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
					{label ?? maturity}
				</span>
			) : (
				<span className="badge badge-sm badge-warning badge-outline">Not rated yet</span>
			)}
			{maturity && maturity !== "general" && notes.length > 0 && (
				<span className="text-base-content/60">{notes.map(contentNoteLabel).join(" · ")}</span>
			)}
			{maturity === "general" && (
				<span className="text-xs text-base-content/50">
					Readers see no rating on a General Work.
				</span>
			)}
			{change}
		</div>
	);
}

/**
 * The thumbnail feeds, listings and libraries show of a Work, before a video plays, and in front
 * of a locked Work, with the rule it is held to beside it (`THUMBNAIL_RULE`). A video's is
 * required and can be taken from the frame the player is paused on (`onFrame`).
 */
function Thumbnail({
	preview,
	required,
	onFile,
	onClear,
	onFrame,
	frameError,
}: {
	preview: string | null;
	required: boolean;
	onFile: (file: File) => void;
	onClear: () => void;
	onFrame?: () => void;
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
					<button type="button" className="btn btn-outline btn-sm" onClick={onFrame}>
						Use This Frame
					</button>
				)}
			</div>
			<div className="flex-1 min-w-48 flex flex-col gap-1 text-xs text-base-content/60">
				<span className="font-medium text-base-content/80">
					{required ? "Thumbnail" : "Thumbnail (optional)"}
				</span>
				<p>
					Shown on cards, before a video plays, and in front of this Work for anyone who hasn't
					unlocked it.
					{required &&
						" A video needs one before it's released: upload an image, or pause the video above and use that frame."}
				</p>
				<p>{THUMBNAIL_RULE}</p>
				{frameError && <p className="text-warning">{frameError}</p>}
			</div>
		</div>
	);
}

/**
 * Save and Discard, on screen while anything is unsaved (Parker, 2026-09-17), and a moment of
 * "Saved" afterwards. It sticks to the bottom of the page so it is in reach wherever the creator
 * has scrolled to, and it carries the save's error, because the top of the page may be far away.
 */
function SaveBar({
	dirty,
	saving,
	saved,
	error,
	raised,
	onSave,
	onDiscard,
}: {
	dirty: boolean;
	saving: boolean;
	saved: boolean;
	error: string | null;
	raised: boolean;
	onSave: () => void;
	onDiscard: () => void;
}): ReactNode {
	if (!dirty && !saving && !saved && !error) return null;
	return (
		<div
			className={`sticky ${raised ? "bottom-16" : "bottom-0"} z-20 -mx-4 border-t border-base-300 bg-base-100/95 px-4 py-3 backdrop-blur`}
		>
			<div className="flex flex-wrap items-center gap-3">
				<span role="status" className="text-sm">
					{error ? (
						<span className="text-error">{error}</span>
					) : dirty || saving ? (
						"Unsaved changes"
					) : (
						<span className="text-success">Saved</span>
					)}
				</span>
				{(dirty || saving) && (
					<div className="ml-auto flex gap-2">
						<button
							type="button"
							className="btn btn-ghost btn-sm"
							onClick={onDiscard}
							disabled={saving}
						>
							Discard
						</button>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={onSave}
							disabled={saving}
						>
							{saving ? "Saving…" : "Save Work"}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
