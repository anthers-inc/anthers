// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's page as a user sees it, in parts, shared by the public Work page and the Studio's
 * Edit page. Parker's direction (2026-09-17) is that the Edit page looks like the Work, with its
 * details editable where they appear, rather than being a form a creator fills in blind.
 *
 * 🚨 **One layout, so the Edit page cannot drift from what a user sees.** The Edit page exists
 * to show a creator the truth about their Work's page, and a second copy of this layout would
 * start lying the first time one of the two changed. Each part renders the user's version by
 * default, and the Edit page passes its controls into the slots for the parts a creator changes.
 *
 * Nothing here decides access. Whether the deliverable may be shown at all is the caller's
 * question, answered by the server's verdict on the user page and by ownership on the Edit page.
 */

import { workChapters } from "@anthers/shared/chapters";
import { isListened, isPaged } from "@anthers/shared/content";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import HostedEmbed from "@anthers/web-shared/content/HostedEmbed";
import { FONTS } from "@anthers/web-shared/fonts";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type { AccessResult, Work, WorkCredit } from "@anthers/web-shared/types";
import {
	BookOpenIcon,
	CalendarIcon,
	ClockIcon,
	DocumentTextIcon,
	PhotoIcon,
	PuzzlePieceIcon,
	SpeakerWaveIcon,
	VideoCameraIcon,
} from "@heroicons/react/24/outline";
import { PlayIcon } from "@heroicons/react/24/solid";
import {
	type CSSProperties,
	type ReactNode,
	type RefObject,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	readScrollFraction,
	refreshReadingPositions,
	SCROLL_OPEN_FLOOR,
	serverPositionOf,
	writeScroll,
} from "../../lib/reading-positions";
import { trackFromWork } from "../../lib/tracks";
import { useSeekPlayer, WorkPlayerProvider } from "../../lib/work-player";
import GalleryView from "../media/GalleryView";
import {
	LyricsBody,
	LyricsShelf,
	WORK_LYRICS_CLASS,
	WORK_LYRICS_HEADING_CLASS,
} from "./LyricsPanel";
import WorkMediaFrame from "./WorkMediaFrame";

// ⭐ The lyrics classes live beside the card that owns them; re-exported for the Studio's InlineField.
export { WORK_LYRICS_CLASS, WORK_LYRICS_HEADING_CLASS };

import AudioPlayer from "../media/AudioPlayer";
import ComicReader from "../media/ComicReader";
import EbookReader from "../media/EbookReader";
import { PublicAccessFooter } from "../media/PublicAccessNotice";
import SpokenPlayer from "../media/SpokenPlayer";
import TimestampedText from "../media/TimestampedText";
import VideoPlayer from "../media/VideoPlayer";
import ProjectEmbed from "../project/ProjectEmbed";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import SanitizedHtml from "../ui/SanitizedHtml";

/** A Work as the detail endpoint returns it — with its creator and posting history. */
export type WorkDetail = Work & {
	creator?: { handle: string; displayName: string | null; avatar: string | null };
	/** Whether the creator can actually take a direct payment (Connect onboarded). */
	creatorHasStripe?: boolean;
	/**
	 * Display name of whoever shared the link this page was reached by. Present only on a
	 * share view — a display name and nothing else, since the rest of that person's account
	 * is none of the recipient's business.
	 */
	sharedBy?: string | null;
	postedIn?: {
		slug: string;
		title: string | null;
		isPublished: boolean;
		postedAt: string | null;
	}[];
	/**
	 * Where this Work can be found — the facts of the Showings panel. The creator's
	 * profile is read off `creator`; the Projects carrying it ride here, in the order
	 * the project places them. Channels, collections and collaborations follow when
	 * their machinery exists; the panel's stub text is the promise's current shape.
	 */
	shownOn?: { projects: Array<{ slug: string; title: string }> };
};

/** The title's typography, so a control standing in for the title reads as the title. */
export const WORK_TITLE_CLASS = "text-3xl font-bold";

/**
 * The public blurb's typography, likewise — **not the `prose` class** (Parker,
 * 2026-10-16): the description is one plain paragraph the page renders directly
 * (`TimestampedText`), and `prose`'s paragraph margins sat between the tab's heading
 * and the text — unlayered CSS, which no `[&_p]:my-0` utility could beat.
 */
export const WORK_DESCRIPTION_CLASS = "max-w-none text-base-content/80";

/** The section labels of the Work's tab panels — Details, Credits, Reviews, Manage, all
 *  of them: small, named, uppercased (Parker, 2026-10-13; conformed across every tab as
 *  the page's one heading style, 2026-10-16). */
export const WORK_DETAILS_HEADING_CLASS =
	"text-xs font-semibold uppercase tracking-wider text-base-content/50";

/**
 * Whether a Work is a piece of writing, which reads as an article rather than as a player.
 *
 * ⭐ **The reading experience is what tells writing apart from a post** (Parker, 2026-09-11): a
 * post is social and a text Work is an essay, a story or a poem, and the two were prose in the same
 * editor with nothing on the page to say which a user was holding. So a text Work gets a reading
 * column, a display serif for its headline (Fraunces), its description as a standfirst under the
 * headline, and a text serif for its body (Spectral), where every post is set in the app's sans.
 */
export function isWriting(type: string): boolean {
	return type === "text";
}

/** The headline of a piece of writing, and the typography of a control standing in for it. */
export const WRITING_TITLE_CLASS = "text-4xl font-semibold leading-tight";
export const WRITING_TITLE_STYLE: CSSProperties = { fontFamily: FONTS.fraunces };

/** The standfirst: a piece of writing's description, set under its headline. */
export const WRITING_STANDFIRST_CLASS = "text-xl leading-snug text-base-content/70";
export const WRITING_BODY_STYLE: CSSProperties = { fontFamily: FONTS.spectral };

/** A piece of writing's body: a text serif at a reading size, with room between the lines
 *  and none added between paragraphs — a break is what the creator typed, and the gap
 *  they want is the blank paragraph they press return again for (flush, see globals.css). */
export const WRITING_ARTICLE_CLASS =
	"prose prose-lg max-w-none leading-relaxed prose-headings:font-semibold flush";

/** The title's typography for a Work of this kind. */
export function workTitleTypography(type: string): {
	className: string;
	style: CSSProperties | undefined;
} {
	return isWriting(type)
		? { className: WRITING_TITLE_CLASS, style: WRITING_TITLE_STYLE }
		: { className: WORK_TITLE_CLASS, style: undefined };
}

/** A music Work's lyrics panel, and its heading, likewise. */
/**
 * The goods kinds, whose deliverable is the store — buying, not a rendered medium —
 * and whose record carries no meter (see `pageHoldsTheMeter`).
 */
export function isGoods(type: string): boolean {
	return type === "physical" || type === "service";
}

/**
 * The empty deliverable's silhouette, for a draft the creator is looking at before any
 * file has arrived: an outlined area in the shape and aspect their Work will occupy, so
 * the page reads as a page rather than nothing, and the one line that says how the box
 * gets filled. A draft is private, so the note here is never shown to a user.
 *
 * `status` is the shape's second tenant (the placeholder task, 2026-10-16): the state
 * between "nothing attached" and "the deliverable exists" — the landed file under
 * processing — renders here rather than in the deliverable's place, so the box the
 * creator was looking at keeps its proportions and the progress lives inside it
 * (SoundCloud's greyed cloud, status inside, while the track processes). Visitors see
 * this form too, on a Work whose pages are still being made; with no note passed, the
 * label alone says what the box becomes.
 */
type PlaceholderShape = {
	icon: typeof PhotoIcon;
	label: string;
};

/**
 * The silhouette's tenant and its line, per kind — and only those two. The shapes
 * themselves are not per kind anymore (the media-frame task, 2026-10-16): the
 * silhouette mounts inside the page's `WorkMediaFrame`, whose one profile is every
 * kind's shape, so the aspect a draft's box draws no longer moves between kinds.
 */
const PLACEHOLDER_SHAPES: Record<string, PlaceholderShape> = {
	video: { icon: VideoCameraIcon, label: "The player starts here" },
	music: { icon: SpeakerWaveIcon, label: "The player starts here — the lyrics sit under it" },
	audio: { icon: SpeakerWaveIcon, label: "The player starts here" },
	image: { icon: PhotoIcon, label: "The picture hangs here" },
	comic: { icon: BookOpenIcon, label: "The pages open here" },
	ebook: { icon: BookOpenIcon, label: "The book opens here" },
	text: { icon: DocumentTextIcon, label: "The article reads here" },
	game: { icon: PuzzlePieceIcon, label: "The game plays here" },
	software: { icon: PuzzlePieceIcon, label: "The program runs here" },
};

export function WorkPlaceholder({
	type,
	note,
	status,
	action,
}: {
	type: string;
	note: string;
	/** The processing block that replaced the box, now riding inside it — see the docblock. */
	status?: ReactNode;
	/**
	 * The act that fills the box, riding inside it — the creator's file dropper (the
	 * dropper task, 2026-10-17): a draft with no file picks its file in the place the
	 * file will occupy, rather than being sent down a tab's form. The caller decides
	 * when the box is the creator's to fill; the visitor's silhouette passes nothing.
	 */
	action?: ReactNode;
}) {
	const shape = PLACEHOLDER_SHAPES[type] ?? {
		icon: DocumentTextIcon,
		label: "The Work goes here",
	};
	const Icon = shape.icon;
	return (
		// Fills the media frame it mounts in rather than carrying a shape of its own —
		// the frame is the page's shape-holder now — so the dashed box is the frame's
		// one profile for every kind, and the kind and its note live inside it.
		<div
			role="status"
			className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-base-300 bg-base-100/50 p-6 text-center"
		>
			<Icon className="size-10 text-base-content/30" aria-hidden />
			<p className="text-sm text-base-content/60">{shape.label}.</p>
			{note && <p className="max-w-prose text-xs text-base-content/40">{note}</p>}
			{status}
			{action && <div className="w-full max-w-lg">{action}</div>}
		</div>
	);
}

/**
 * The creator-asserted original release date, formatted as a plain date.
 *
 * We only ever claim a date the creator gave us — a creator who knows only the year
 * picks a date, and that date is what renders.
 */
export function formatOriginallyReleased(iso: string | null | undefined): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	return d.toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}

/**
 * Media whose METER the page owns, rather than the component.
 *
 * `VideoPlayer` and `AudioPlayer` each subscribe to the budget and render their own
 * countdown and wall, because they own the playback state the footer needs. Nothing
 * else does — and that now includes the **ebook** user, which is deliberate rather
 * than an oversight: its pages are fetched one at a time from a metered endpoint, so
 * a spent allowance would otherwise surface as a user full of broken images, which
 * is the dead-player failure this whole meter design exists to avoid. The page shows
 * the wall instead.
 */
export function pageHoldsTheMeter(type: string): boolean {
	// A goods Work (physical, service) holds no meter because it accrues no
	// attention of the kind the meter bills: nothing streams, nothing is read in
	// the page. (Parker, 2026-10-09 — the Public Access rules bind only streamable
	// Works.) A shirt's page must never wear a watch-time footer.
	return type !== "video" && type !== "physical" && type !== "service" && !isListened(type);
}

/**
 * The page's column, shared so the Edit page is the width a user's page is. A piece of writing
 * gets a reading column, narrow enough that a line of its body stays a comfortable length.
 *
 * `wide` is the Studio Edit page's own width, and deliberately not the user's: the Edit page
 * is a working form whose Access table, rating matrix and credits editor are controls rather
 * than reader surfaces, and each scrunched badly at the reading width (the "Widen and Reorder
 * the Work Edit Layout" task). The one-layout rule still binds — the parts above are the same
 * parts — so the cap is this page's only divergence, and it never binds below it: on a laptop
 * or a phone the page is the user's width still.
 */
export function WorkColumn({
	children,
	type,
	wide,
	tight,
}: {
	children: ReactNode;
	type?: string;
	wide?: boolean;
	/** Pull the content to the topbar's edge: a page whose first element is the thing
	 *  itself (a video's page, whose player starts under the mode banner) wants the top
	 *  gap the section spacing gives, not the page's own (Parker, 2026-10-13). */
	tight?: boolean;
}) {
	// `w-full` is load-bearing: this div sits in the shells' `flex flex-col` <main>, and
	// there an auto-width item with `mx-auto` is sized to its *content* rather than
	// stretched (auto cross-axis margins turn stretch off), capped by the max-w. A
	// video's page then rides the <video>'s intrinsic size — 300×150 until its metadata
	// resolves — so the whole column starts narrow and jumps wide seconds into the
	// load. A definite width restores the centered-block behavior this component is.
	const width = wide ? "max-w-7xl" : type && isWriting(type) ? "max-w-2xl" : "max-w-4xl";
	return (
		// The player scope wraps the whole column: the deliverable that mounts a
		// player and the description and reviews that link into it are the siblings
		// this binding exists for — see `lib/work-player.tsx`.
		<WorkPlayerProvider>
			<div
				className={`w-full ${width} mx-auto px-4 ${tight ? "pt-6 pb-16" : "py-8 pb-16"} space-y-6`}
			>
				{children}
			</div>
		</WorkPlayerProvider>
	);
}

interface WorkHeaderProps {
	work: WorkDetail;
	/** In place of the title, for a control standing in for it. */
	title?: ReactNode;
	/** Beside the title. */
	titleAside?: ReactNode;
	/** In place of the line of dates. */
	dates?: ReactNode;
	/** In place of the rating line. */
	rating?: ReactNode;
}

/** The kind, the creator, the title, the dates and the rating, in that order. */
export function WorkHeader({ work, title, titleAside, dates, rating }: WorkHeaderProps) {
	const creatorName = work.creator?.displayName || work.creator?.handle || "this creator";
	return (
		<header className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<ContentTypeBadge contentType={work.type} />
				{work.creator && (
					<Link
						to={profileUrl(work.creator.handle)}
						className="flex items-center gap-2 text-sm hover:underline"
					>
						{work.creator.avatar ? (
							<img
								src={work.creator.avatar}
								alt={work.creator.handle}
								className="w-6 h-6 rounded-full object-cover"
							/>
						) : (
							<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
								{work.creator.handle.charAt(0).toUpperCase()}
							</div>
						)}
						{creatorName}
					</Link>
				)}
			</div>

			<div className="flex flex-wrap items-start justify-between gap-3">
				{title ?? (
					<h1
						className={workTitleTypography(work.type).className}
						style={workTitleTypography(work.type).style}
					>
						{work.title || "Untitled"}
					</h1>
				)}
				{titleAside}
			</div>

			{dates ?? <WorkDates work={work} />}

			{/* The rating and its notes sit above the deliverable, not below it: a warning
			    that only appears once you already have the thing is not a warning. Nothing
			    renders for a General Work, which is nearly all of them. */}
			{rating ?? <WorkRating work={work} />}
		</header>
	);
}

/** First released anywhere, then released here — never the upload date, which is bookkeeping. */
export function WorkDates({ work }: { work: WorkDetail }) {
	const originally = formatOriginallyReleased(work.originallyReleased);
	const released = work.releasedAt
		? new Date(work.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;
	return (
		<div className="flex flex-wrap items-center gap-4 text-sm text-base-content/60">
			{originally && (
				<span className="flex items-center gap-1">
					<CalendarIcon className="w-4 h-4" />
					First released {originally}
				</span>
			)}
			{released && <span>Released {released}</span>}
			{work.type === "text" && work.estimatedReadMinutes && (
				<span className="flex items-center gap-1">
					<ClockIcon className="w-4 h-4" />
					{work.estimatedReadMinutes} min read
				</span>
			)}
		</div>
	);
}

/**
 * The rating and its content notes, for a Mature or Adult Work. Nothing for a General Work,
 * which is nearly all of them. An Adult Work reaches only users who opted in and verified, and
 * it is labeled for them all the same, because its notes are as much a warning there as anywhere.
 */
export function WorkRating({ work }: { work: WorkDetail }) {
	if (work.maturity !== "mature" && work.maturity !== "adult") return null;
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span
				className={`badge badge-sm ${work.maturity === "adult" ? "badge-error" : "badge-warning"}`}
			>
				{work.maturity === "adult" ? "Adult" : "Mature"}
			</span>
			{(work.maturityNotes ?? []).length > 0 && (
				<span className="text-base-content/60">
					{(work.maturityNotes ?? []).map(contentNoteLabel).join(" · ")}
				</span>
			)}
		</div>
	);
}

/**
 * The access chip, for the byline strip: what opening this Work costs, in one badge.
 *
 * A user page passes the resolver's own verdict — `isFree` says Public Access, a
 * purchasable Work its price, a badge-gated one Members — because the *user's* chip
 * must be the truth they stand in, not the setting behind it (`presentsAsLocked`'s
 * lesson: a signed-out visitor is refused free bytes too, and calling that "Gated"
 * would rename the commons). The creator's page passes no verdict and the chip reads
 * the table's setting instead — their own draft, gated or public by choice.
 */
export function WorkAccessChip({
	publicAccess,
	access,
}: {
	publicAccess?: boolean;
	access?: AccessResult | null;
}) {
	if (access) {
		if (access.isFree) {
			return <span className="badge badge-sm badge-outline badge-success">Public Access</span>;
		}
		if (access.requiresPurchase && access.price) {
			return <span className="badge badge-sm badge-outline badge-secondary">${access.price}</span>;
		}
		if (!access.canAccess) {
			return <span className="badge badge-sm badge-outline">Members</span>;
		}
		return <span className="badge badge-sm badge-outline">Yours</span>;
	}
	return publicAccess ? (
		<span className="badge badge-sm badge-outline badge-success">Public Access</span>
	) : (
		<span className="badge badge-sm badge-outline">Gated</span>
	);
}

export interface WorkBylineProps {
	work: WorkDetail;
	/** In place of the title, for a control standing in for it. */
	title?: ReactNode;
	/** To the title's right, at the page's edge — a signed-in reader's Share and Save. */
	actions?: ReactNode;
	/** After the creator, the kind and any chip the page's mode knows first-hand. */
	chips?: ReactNode;
}

/**
 * The byline strip, under the deliverable (Parker, 2026-10-13): the title on the first
 * line and the person who made it on the second — avatar, name, a rule, the kind — with
 * the access chip after it. It replaces the header block above the deliverable, whose
 * position a player owns: what a Work is and who made it now stands *between* the thing
 * itself and its record, and Share and Save go with it, to the right, above the side
 * tabs. The rating is deliberately absent — it is the Rating tab's fact.
 *
 * Under the strip, the Anthers release date rides again (Parker, 2026-10-16): a second
 * copy of the line the Details tab carries, so the facts around the title answer where
 * a viewer looks first. A draft, with no release date, renders nothing.
 */
export function WorkByline({ work, title, actions, chips }: WorkBylineProps) {
	const creatorName = work.creator?.displayName || work.creator?.handle || "this creator";
	const releasedDate = work.releasedAt
		? new Date(work.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;
	const creatorEl = work.creator && (
		<Link to={profileUrl(work.creator.handle)} className="flex items-center gap-2 hover:underline">
			{work.creator.avatar ? (
				<img
					src={work.creator.avatar}
					alt={work.creator.handle}
					className="size-6 rounded-full object-cover"
				/>
			) : (
				<div className="flex size-6 items-center justify-center rounded-full bg-base-300 text-xs font-bold">
					{work.creator.handle.charAt(0).toUpperCase()}
				</div>
			)}
			{creatorName}
		</Link>
	);
	return (
		// Centered, fanning out symmetrically (Parker's fourth pass, 2026-10-13): the
		// maker's name is always the page's center, a rule on either side of it, the
		// chips right-aligned to the left one and the actions left-aligned to the right.
		<header className="space-y-2.5">
			<div className="text-center">
				{title ?? (
					<h1
						className={`${workTitleTypography(work.type).className} text-center`}
						style={workTitleTypography(work.type).style}
					>
						{work.title || "Untitled"}
					</h1>
				)}
			</div>
			<div className="grid grid-cols-1 items-center gap-y-2 sm:grid-cols-[1fr_auto_1fr]">
				<div className="flex flex-wrap items-center justify-center gap-2 sm:justify-end sm:pr-2.5">
					<ContentTypeBadge contentType={work.type} />
					{chips}
					<span aria-hidden className="h-4 w-px bg-base-300 max-sm:hidden" />
				</div>
				{creatorEl}
				<div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start sm:pl-2.5">
					<span aria-hidden className="h-4 w-px bg-base-300 max-sm:hidden" />
					{actions}
				</div>
			</div>
			{releasedDate && (
				<p className="text-center text-sm text-base-content/60">Released {releasedDate}</p>
			)}
		</header>
	);
}
/**
 * The Work itself, for somebody who may open it: the player, the user, the image, the
 * embedded build or the gated prose, whichever the kind has.
 *
 * ⭐ The deliverable mounts inside `WorkMediaFrame` (the media-frame task, 2026-10-16,
 * Parker; the standard 16:9 profile, 2026-10-19): the video work page's layout is
 * canonical, every kind derives from it, and one media card — a single 16:9 stage — is
 * what makes the page hold still while kinds flip. The frame's fill mode is decided per
 * branch: **video, a hosted build and a picture contain themselves in the stage**; every
 * other branch is a composition inside it (the listened kinds' stage, the readers, the
 * writing column, the store panel, a placeholder, a gate), whose taller content scrolls
 * inside the stage rather than growing the card. The embed page is the one caller that
 * opts out (`framed` false): a bare window on one medium has no page to hold still, and
 * the meter footer it needs still renders beside it there.
 */
export function WorkDeliverable({
	work,
	shareToken = null,
	lyrics,
	lead,
	onFrameActivity,
	startSeconds = null,
	persistentMiniPlayer = false,
	framed = true,
}: {
	work: WorkDetail;
	shareToken?: string | null;
	/** In place of a music Work's lyrics, for a control standing in for them. */
	lyrics?: ReactNode;
	/**
	 * A standfirst above the deliverable, for a piece of writing: the page passes the
	 * Work's description here so it rides inside the media frame, above the article,
	 * rather than above the frame as its own block outside the page's shape.
	 */
	lead?: ReactNode;
	/**
	 * Fed the hosted frame's presence heartbeats, for the page's idle detector — the
	 * in-frame input signal that otherwise never leaves the frame. See
	 * `HostedEmbed`'s `onActivity` and `attention.ts`'s `reportExternalActivity`.
	 */
	onFrameActivity?: () => void;
	/**
	 * Where to open playback — the `?t` a clicked timestamp put in the bar. Overrides
	 * a spoken Work's remembered resume: a link that names a moment means that moment.
	 */
	startSeconds?: number | null;
	/**
	 * Audio playback rides the persistent footer bar instead of the page — the
	 * account's Use Persistent Miniplayer setting, decided by the routes: the user's
	 * Work page passes it, the embed and the Studio preview do not, because an
	 * embedded frame has no bar and a preview should not take over the creator's
	 * bar as they type.
	 */
	persistentMiniPlayer?: boolean;
	/**
	 * The media card the page's shape is held by (see the docblock above): true on
	 * every page surface; the embed route passes false, being a bare window on one
	 * medium with no page shape to hold.
	 */
	framed?: boolean;
}) {
	/** The chapters the description carries — one parse, shared by every player branch. */
	const chapters = useMemo(() => workChapters(work.description ?? ""), [work.description]);
	/** The Work's own track, for the bar-driven modes of the audio players — see them. */
	const track = persistentMiniPlayer ? trackFromWork(work) : undefined;
	/**
	 * The meter the page holds, for the kinds that are neither video nor listened
	 * (their players render their own) — it rides inside the branch's frame so a
	 * medium's allowance never renders outside the media area it belongs to.
	 */
	const holdsMeter = pageHoldsTheMeter(work.type);
	/**
	 * The branch's mount, through the page's one media card when the caller wants it:
	 * a fill branch (video, a hosted build, a picture) hands `fill` because its medium
	 * draws its own box; everything else is a composition inside the stage. The page's
	 * meter, where this kind owns one, rides the frame's footer slot so a fill medium
	 * never clips it and a composition reads it after the content.
	 */
	const frame = (node: ReactNode, fill = false) => {
		const meter = holdsMeter ? <PublicAccessFooter /> : undefined;
		return framed ? (
			<WorkMediaFrame fill={fill} footer={meter}>
				{node}
			</WorkMediaFrame>
		) : (
			<>
				{node}
				{meter}
			</>
		);
	};
	return (
		<>
			{/*
			 * A video's ladder is the offered experience, and the original is the
			 * baseline underneath it (70.06): an existing manifest keeps today's
			 * behavior unchanged, and a video before its ladder — or whose ladder
			 * never completed — plays its original through the native-file mode.
			 * The same access rules, meter and attention wiring apply in both;
			 * `VideoPlayer` switches on the shape of the address.
			 */}
			{work.type === "video" &&
				work.transcoding?.hlsManifestUrl &&
				frame(
					<VideoPlayer
						fillsFrame={framed}
						src={work.transcoding.hlsManifestUrl}
						// Original Media, in the quality menu as the opted-into alternative to the
						// ladder's rungs (the Jellyfin-shaped offer): the route is the same
						// access-checked one the pre-ladder baseline plays from, so the gate, the
						// meter and the household limit already hold.
						originalUrl={work.originalUrl}
						poster={work.thumbnail ?? undefined}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						captions={work.captions}
						chapters={chapters}
						startSeconds={startSeconds}
						// The Podcast-This row: only a video whose audio rendition really shipped
						// gets one — serialization nulls the URL when `audio.m3u8` is absent.
						podcast={
							work.transcoding.audioManifestUrl
								? {
										audioManifestUrl: work.transcoding.audioManifestUrl,
										track: trackFromWork(work),
									}
								: undefined
						}
					/>,
					true,
				)}
			{work.type === "video" &&
				!work.transcoding?.hlsManifestUrl &&
				work.originalUrl &&
				frame(
					<VideoPlayer
						fillsFrame={framed}
						src={work.originalUrl}
						poster={work.thumbnail ?? undefined}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						captions={work.captions}
						chapters={chapters}
						startSeconds={startSeconds}
					/>,
					true,
				)}
			{/*
			 * A track's processed MP3 is the offered experience, and the original is the
			 * baseline underneath it — the same shape the video's two branches take above:
			 * the processed deliverable keeps today's behavior once it exists, and a
			 * track before its MP3 — or whose processing failed — plays its original
			 * through this fallback (2026-10-16; wiki 70.06, widened to the listened
			 * kinds). The same access rules, meter and attention wiring apply in both,
			 * because what differs is only the address.
			 *
			 * No waveform (the MP3 carries the peaks; it does not exist yet, so the
			 * player's own default fills), and not bar-driven — `trackFromWork`'s
			 * `src` is the processed endpoint and is null until processing completes, so
			 * the bar would be handed a track that cannot play.
			 */}
			{work.type === "music" &&
				!work.transcoding?.outputFileUrl &&
				work.originalUrl &&
				frame(
					// The stage fill (the listened kinds' media area — see the stage task,
					// 2026-10-17): the waveform is the page's reading surface inside the
					// frame's one profile. The fallback plays its original with the same
					// stage the processed track gets, for the same reason the fallback
					// once shared the strip: what differs is only the address.
					<AudioPlayer
						stage={framed}
						src={work.originalUrl}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						chapters={chapters}
						startSeconds={startSeconds}
					/>,
				)}
			{work.type === "music" &&
				work.transcoding?.outputFileUrl &&
				frame(
					<AudioPlayer
						stage={framed}
						src={work.transcoding.outputFileUrl}
						waveform={work.transcoding.waveformData ?? undefined}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						chapters={chapters}
						startSeconds={startSeconds}
						persistent={track}
						// The stage's aside column, the song's words: the creator's field
						// when there is one (it starts open — the composer works where the
						// listener reads); the words when the gate let them through, closed
						// until the transport's toggle asks for them. Gated with the audio:
						// the API blanks them for a user without access, so reaching this
						// branch at all means the user may read them.
						aside={
							lyrics ??
							(work.lyrics?.trim() ? (
								<LyricsShelf>
									<LyricsBody lyrics={work.lyrics ?? ""} />
								</LyricsShelf>
							) : null)
						}
						asideOpen={lyrics != null}
					/>,
				)}
			{/* Spoken word takes its own player — listening to talk wants fixed-step skips,
			    a rate control and a remembered position, none of which a song does. Its
			    original plays the same fallback the song branch does above, for the same
			    reasons: no waveform, and not bar-driven while the processed deliverable
			    does not exist. */}
			{work.type === "audio" &&
				!work.transcoding?.outputFileUrl &&
				work.originalUrl &&
				frame(
					<SpokenPlayer
						stage={framed}
						src={work.originalUrl}
						workId={work.id}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						chapters={chapters}
						startSeconds={startSeconds}
					/>,
				)}
			{work.type === "audio" &&
				work.transcoding?.outputFileUrl &&
				frame(
					<SpokenPlayer
						stage={framed}
						src={work.transcoding.outputFileUrl}
						workId={work.id}
						waveform={work.transcoding.waveformData ?? undefined}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						chapters={chapters}
						startSeconds={startSeconds}
						persistent={track}
					/>,
				)}
			{isPaged(work.type) &&
				// The ingest's own shape signal: sections exist → the reflow reader on the
				// vendored foliate-js engine, reading only through the section/asset
				// ladder; none → the page reader, comic and PDF-shaped ebook alike.
				(work.type === "ebook" && (work.sectionCount ?? 0) > 0
					? frame(
							// `h-full w-full` is load-bearing on these readers: they take the
							// stage's whole height, and their own transport rows sit at its foot
							// rather than under a viewport-sized reading box. A reader with no
							// width of its own would also shrink-to-fit here and crush its seek
							// bar to a zero-width input (the CI ebook failure's finding).
							<div className="h-full w-full">
								<EbookReader
									workId={work.id}
									apiBase={apiBaseUrl()}
									title={work.title ?? "Untitled"}
									shareToken={shareToken}
								/>
							</div>,
						)
					: frame(
							<div className="h-full w-full">
								<ComicReader
									workId={work.id}
									pageCount={work.pageCount ?? 0}
									apiBase={apiBaseUrl()}
									title={work.title ?? "Untitled"}
									shareToken={shareToken}
								/>
							</div>,
						))}
			{work.type === "image" &&
				work.sourceKey &&
				// A set of more than one picture renders as the gallery, in the order the
				// creator arranged it (`work.gallery`, gated exactly beside this Work's
				// `sourceKey`); a one-picture Work renders the plain image it always has.
				// The creator's alt text when there is one; the Work's title is the fallback
				// this render always fell back to, and `""` keeps it (empty alt on a content
				// image would read as deliberately decorative, which the picture never is).
				// The picture is contained by the 16:9 stage: a portrait or 4:3 picture
				// pillarboxes inside it, a 21:9 one letterboxes, and a 16:9 one fills it
				// edge to edge. A set stays a scrolling stack inside the same stage rather
				// than growing the card.
				frame(
					(work.gallery?.length ?? 0) > 1 ? (
						<div className="h-full w-full overflow-y-auto">
							<GalleryView images={work.gallery ?? []} alt={work.imageAlt || work.title || ""} />
						</div>
					) : (
						<img
							src={work.sourceKey}
							alt={work.imageAlt || work.title || ""}
							className="h-full w-full rounded-lg object-contain"
						/>
					),
					true,
				)}
			{/* A hosted build outranks an external embed address: the build Anthers serves is
			    the thing the creator uploaded here, and the embed address is creator-hosted
			    off-platform. A Work carrying both plays hosted; removing the build falls back
			    to the address.
			    🚨 The ancestor rule decides the shape: an isolation build (threaded export,
			    SharedArrayBuffer) is cross-origin isolated only when EVERY ancestor is, and
			    this SPA carries no per-Work response headers — so it plays on the
			    server-rendered /play page, which mints the token itself and carries
			    COOP/COEP. An ordinary build frames inline as before. */}
			{work.type === "game" || work.type === "software"
				? work.webPlayable && work.webPlayPath === "inline"
					? // A hosted build fills the card the way a video does: its play area is
						// the video profile (the iframes draw `aspect-video` now), so the card
						// hugs it rather than letterboxing it.
						frame(
							<HostedEmbed
								workId={work.id}
								title={work.title ?? "Play"}
								onActivity={onFrameActivity}
							/>,
							true,
						)
					: work.webPlayable && work.webPlayPath === "page"
						? frame(
								<div className="flex h-full w-full items-center justify-center">
									<a href={`/api/play/${work.id}`} className="btn btn-primary btn-lg gap-2">
										<PlayIcon className="w-6 h-6" />
										Play in Browser
									</a>
								</div>,
							)
						: work.embedUrl &&
							frame(<ProjectEmbed embedUrl={work.embedUrl} title={work.title ?? "Play"} />, true)
				: null}
			{work.bodyHtml &&
				(isWriting(work.type)
					? // A piece of writing reads at its measure inside the card, the
						// standfirst above it when the page passed one — the reading column is
						// the article's own, centered in the stage, and a long piece scrolls
						// inside the fixed 16:9 area rather than growing the card.
						frame(
							<div className="mx-auto w-full max-w-2xl">
								{lead}
								<WorkArticle html={work.bodyHtml} workId={work.id} />
							</div>,
						)
					: frame(
							// Same `w-full` as the readers: the prose column takes the stage's
							// width rather than sitting in a shrink-to-fit box.
							<div className="w-full">
								<article className="prose max-w-none">
									<SanitizedHtml html={work.bodyHtml} />
								</article>
							</div>,
						))}
			{/*
			 * Reading, playing and looking draw the allowance exactly as watching does,
			 * and until now said nothing about it — the countdown and the wall were
			 * wired into the two players and nowhere else, so a user nine hours in
			 * got no signal at all and then met a wall at a video.
			 *
			 * 🚨 Held inside the branch's media frame by the `frame` helper above, for
			 * the same reason it was rendered here rather than inside each medium's
			 * block: there is no component to hang it on — text is an <article>, a game
			 * is an <iframe>, an image is an <img>. The players own their own footer;
			 * everything else has this one.
			 */}
		</>
	);
}

/**
 * The public blurb — visible whether or not the user can open the Work, because a locked
 * Work still has to say what it is. The gated prose renders inside the deliverable. For a piece
 * of writing it is the standfirst, which the page sets under the headline rather than here.
 *
 * A description past a reasonable length truncates behind a Read More toggle
 * (Parker, 2026-10-16): the cut sits on a word boundary inside {@link DESCRIPTION_THRESHOLD},
 * the collapsed tail carries an ellipsis, and the same toggle collapses again. Short
 * descriptions — nearly all of them — render exactly as before.
 */
export const DESCRIPTION_THRESHOLD = 480;

/** Cut a description at its last word boundary inside the threshold, ellipsis on. */
function clampedDescription(text: string, threshold: number): string {
	return `${text.slice(0, text.lastIndexOf(" ", threshold)).trimEnd()}…`;
}

/**
 * The description body's read-more toggle, shared by both renderers of a description —
 * the user's (`WorkDescription`, in its own typography) and the creator's inline read
 * (which renders the plain paragraph the editor typed into). The collapsed state is the
 * only state the toggle changes; the button carries its own margin, inside the prose
 * flow and out of it.
 */
export function DescriptionToggle({
	truncated,
	expanded,
	onToggle,
}: {
	truncated: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	if (!truncated) return null;
	return (
		<button
			type="button"
			aria-expanded={expanded}
			className="mt-2 text-sm text-base-content/50 hover:text-base-content/80 underline decoration-base-content/20 underline-offset-2"
			onClick={onToggle}
		>
			{expanded ? "Read Less" : "Read More…"}
		</button>
	);
}

export function WorkDescription({ work }: { work: WorkDetail }) {
	const seek = useSeekPlayer();
	const truncated = (work.description?.length ?? 0) > DESCRIPTION_THRESHOLD;
	const [expanded, setExpanded] = useState(false);
	if (!work.description) return null;
	const shown =
		truncated && !expanded
			? clampedDescription(work.description, DESCRIPTION_THRESHOLD)
			: work.description;
	const toggle = (
		<DescriptionToggle
			truncated={truncated}
			expanded={expanded}
			onToggle={() => setExpanded((e) => !e)}
		/>
	);
	if (isWriting(work.type)) {
		return (
			<div>
				<p className={WRITING_STANDFIRST_CLASS} style={WRITING_BODY_STYLE}>
					{shown}
				</p>
				{toggle}
			</div>
		);
	}
	return (
		<section className={WORK_DESCRIPTION_CLASS}>
			<TimestampedText
				text={shown}
				// Only a Work a player navigates makes its timestamps links — and only
				// when a player is actually mounted; a locked video's description has
				// no player to seek, so its timestamps stay text until it is opened.
				onSeek={work.type === "video" || isListened(work.type) ? seek : null}
				className="whitespace-pre-line"
			/>
			{toggle}
		</section>
	);
}

/**
 * The description's body for the editor's inline read — the same truncation
 * `WorkDescription` carries, in the plain paragraph the edit textarea wrote: the
 * creator's copy is the user's Details tab rendering, and no read of the page should
 * promise a length the user's page does not keep.
 */
export function DescriptionBody({ description }: { description: string | null }) {
	const truncated = (description?.length ?? 0) > DESCRIPTION_THRESHOLD;
	const [expanded, setExpanded] = useState(false);
	if (!description) {
		return (
			<section className={WORK_DESCRIPTION_CLASS}>
				<p className="text-sm text-base-content/40">Nothing written yet.</p>
			</section>
		);
	}
	const shown =
		truncated && !expanded ? clampedDescription(description, DESCRIPTION_THRESHOLD) : description;
	return (
		<section className={WORK_DESCRIPTION_CLASS}>
			<p className="whitespace-pre-line">{shown}</p>
			<DescriptionToggle
				truncated={truncated}
				expanded={expanded}
				onToggle={() => setExpanded((e) => !e)}
			/>
		</section>
	);
}

/**
 * A text Work's scroll position: how deep into the article the reader has gotten, as the
 * reading-positions module's third currency (pages, CFIs, and now depth-scrolled).
 *
 * **Depth-scrolled is the whole position** — a scroll has no pages to have stopped on, so
 * the fraction is defined once here and everything else (the rail's membership, the
 * spine's ribbon, the resume) reads it the same way it reads a page fraction. The
 * measure is the article element against the surface that scrolls it — the media area's
 * own scroll box when the piece is framed (the standard-profile task, 2026-10-19), the
 * window on the bare embed route: when that surface's bottom edge has passed that depth
 * of the piece, the reader has seen that much of it. (An article that fits on one screen
 * is read as soon as it has been seen at all, which the clamp to 1 states honestly.)
 *
 * **Never written on mount.** The same contract the paged readers keep: opening a piece
 * records nothing; scrolling it does. A resume lands at the recorded depth with the
 * read point set a fifth of a viewport below the top edge, so what comes next is ahead
 * of where the eye expects it rather than a line half-hidden at the ceiling.
 *
 * A nudge of scroll (below `SCROLL_OPEN_FLOOR`) still records locally — depth is depth —
 * but is never pushed, so an accidental jiggle never puts a Work on the rail.
 */
function useArticleScrollProgress(
	workId: number | undefined,
	ref: RefObject<HTMLElement | null>,
): void {
	useEffect(() => {
		if (!workId || !ref.current) return;
		void refreshReadingPositions();
		const el = ref.current;
		/**
		 * The surface that scrolls this piece: the media frame's own scroll box when it
		 * holds the article, the window when the page is a bare embed. The frame marks
		 * its scrolling stage rather than this function guessing from overflow styles.
		 */
		const scroller = el.closest<HTMLElement>("[data-media-scroll]");
		const scrollSurface: HTMLElement | Window = scroller ?? window;

		let restored = false;
		const resumeAt = (fraction: number) => {
			if (scroller) {
				const top =
					el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
				const target = top + fraction * el.offsetHeight - scroller.clientHeight * 0.8;
				scroller.scrollTo({ top: Math.max(0, target) });
				return;
			}
			const target = el.offsetTop + fraction * el.offsetHeight - window.innerHeight * 0.8;
			window.scrollTo(0, Math.max(0, target));
		};

		// Resume from the device's own depth, or — on a device that has never read this
		// piece — from the server row the refresh adopts. One resume per mount only.
		const restoredFraction = readScrollFraction(workId) ?? serverPositionOf(workId)?.progress;
		if (restoredFraction != null && restoredFraction >= SCROLL_OPEN_FLOOR) {
			restored = true;
			resumeAt(restoredFraction);
		} else {
			void refreshReadingPositions().then(() => {
				if (restored) return;
				const adoptedFraction = readScrollFraction(workId) ?? serverPositionOf(workId)?.progress;
				if (adoptedFraction != null && adoptedFraction >= SCROLL_OPEN_FLOOR) {
					restored = true;
					resumeAt(adoptedFraction);
				}
			});
		}

		let lastWrite = 0;
		const onScroll = () => {
			const now = Date.now();
			if (now - lastWrite < 1000) return;
			lastWrite = now;
			const height = el.offsetHeight;
			if (height <= 0) return;
			const depth = scroller
				? (scroller.getBoundingClientRect().bottom - el.getBoundingClientRect().top) / height
				: (window.scrollY + window.innerHeight - el.offsetTop) / height;
			writeScroll(workId, Math.min(1, Math.max(0, depth)));
		};
		scrollSurface.addEventListener("scroll", onScroll, { passive: true });
		return () => scrollSurface.removeEventListener("scroll", onScroll);
	}, [workId, ref]);
}

/** A piece of writing's body, set for reading. */
export function WorkArticle({ html, workId }: { html: string; workId?: number }) {
	const ref = useRef<HTMLElement>(null);
	useArticleScrollProgress(workId, ref);
	return (
		<article ref={ref} className={WRITING_ARTICLE_CLASS} style={WRITING_BODY_STYLE}>
			<SanitizedHtml html={html} />
		</article>
	);
}

/**
 * How a single credit's machine involvement is badged. A bare `generated` row is simply
 * **AI** — the readers' own word for a machine-made part (Parker, 2026-10-16: the badge is
 * reader copy, not the stored vocabulary) — with no contributor, since a generated credit
 * never names the model, because a machine makes nothing anyone owns; the type records that
 * the role was machine-made and no more. A `created+generated` blend is labeled
 * **Human + AI**, because the human it names is real and the machine's part is part of the
 * same credit.
 */
function creditBadges(types: string[]): { ai: boolean; blended: boolean } {
	const ai = types.includes("generated");
	const created = types.includes("created");
	return { ai, blended: ai && created };
}

/**
 * The Accept/Decline row the overlay hands the person a credit names.
 *
 * Renders ONLY from the `awaitingYourConfirmation` flag the server emits on the named
 * person's own serialization — no user logic lives here, and every other user never
 * receives the flag so never receives these controls. The credit ships with role and
 * types intact because those are what the person needs to act on.
 */
function CreditConfirmationControls({
	work,
	role,
	onDecided,
}: {
	work: WorkDetail;
	role: string;
	/**
	 * Re-read the Work after a decision lands, so the credits re-render from the server's
	 * own answer — accepted resolves the contributor to a name, declined removes the row.
	 */
	onDecided: () => void;
}) {
	const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const decide = async (verb: "accept" | "decline") => {
		setBusy(verb);
		setNotice(null);
		try {
			const res =
				verb === "accept"
					? await client.api.content.works[":id"].credits.accept.$post({
							param: { id: String(work.id) },
							json: { role },
						})
					: await client.api.content.works[":id"].credits.reject.$post({
							param: { id: String(work.id) },
							json: { role },
						});
			if (!res.ok) {
				// The server's own words — every refusal here is a decision the person can act
				// on (sign back in for the widened scope, the credit changed under them), and a
				// generic string turns all of them into "something went wrong".
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setNotice(body?.error ?? "Couldn't record that just now. Please try again.");
				return;
			}
			onDecided();
		} catch {
			setNotice("Couldn't record that just now. Please try again.");
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<span className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					className="btn btn-xs btn-primary"
					disabled={busy !== null}
					onClick={() => decide("accept")}
				>
					{busy === "accept" ? "Accepting…" : "Accept"}
				</button>
				<button
					type="button"
					className="btn btn-xs btn-ghost"
					disabled={busy !== null}
					onClick={() => decide("decline")}
				>
					{busy === "decline" ? "Declining…" : "Decline"}
				</button>
			</span>
			{notice && <p className="w-full text-xs text-base-content/60">{notice}</p>}
		</>
	);
}

/**
 * The Work's credits, rendered as liner notes — one line per credit, with AI involvement
 * badged rather than buried. Public: any user of a released Work sees these, gated or
 * not, as they see the description. A Work with no credits renders nothing.
 *
 * ⭐ **A DID credit names a person, not a protocol** (Parker, 2026-10-13): the account
 * presents as its avatar and display name, and clicking it goes to the person — their
 * Anthers profile page when their account resolves (`/@handle`), otherwise their Bluesky
 * profile by the DID, which is the one address a DID always has a way to name. The DID
 * itself stays on the record as the tooltip's hover text, never the line's face. A
 * plain-name contributor renders as text and is never a link — it is nobody's identity.
 *
 * A credit the user's own identity has not confirmed yet renders beside a
 * "You're credited — confirm?" ask with Accept and Decline, because the credit is a
 * public claim about them and their word is what publishes it.
 */
export function WorkCredits({
	work,
	onCreditDecided,
}: {
	work: WorkDetail;
	/** Re-read the Work after the named person accepts or declines a credit. */
	onCreditDecided?: () => void;
}) {
	const credits = work.credits ?? [];
	if (credits.length === 0) return null;
	return (
		<section className="flex flex-col gap-2">
			<h3 className={WORK_DETAILS_HEADING_CLASS}>Credits</h3>
			<ul className="flex flex-col gap-1.5 text-sm">
				{credits.map((credit, i) => {
					const badges = creditBadges(credit.types);
					const awaiting = credit.awaitingYourConfirmation === true;
					return (
						<li
							// biome-ignore lint/suspicious/noArrayIndexKey: a credit row has no id — the row is pure data rendered in table order.
							key={i}
							className={`flex flex-wrap items-baseline gap-x-2 ${awaiting ? "items-center rounded-lg border border-base-300 bg-base-200/60 px-3 py-2" : ""}`}
						>
							<span>
								{awaiting && <span className="mr-1 font-medium">You're credited — confirm?</span>}
								{credit.role}
								{credit.contributor && (
									<>
										{" "}
										<CreditIdentity credit={credit} />
									</>
								)}
							</span>
							{badges.blended && <span className="badge badge-xs badge-outline">Human + AI</span>}
							{badges.ai && !badges.blended && (
								<span className="badge badge-xs badge-outline">AI</span>
							)}
							{awaiting && (
								<CreditConfirmationControls
									work={work}
									role={credit.role}
									onDecided={() => onCreditDecided?.()}
								/>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * One credit's contributor, presented as the person it names. The profile card rides the
 * overlay when the DID resolves (both shapes attach it); below it, the DID's own Bluesky
 * profile is the fallback — the same person, at the address their DID is the key to.
 */
function CreditIdentity({ credit }: { credit: WorkCredit }) {
	const profile = credit.contributorProfile;
	const isDid = credit.contributor.startsWith("did:");
	const didAttr = isDid ? credit.contributor : undefined;
	if (profile?.handle) {
		return (
			<Link
				to={profileUrl(profile.handle)}
				title={didAttr}
				className="inline-flex items-baseline gap-1.5"
			>
				{profile.avatar ? (
					<img
						src={profile.avatar}
						alt=""
						className="inline h-5 w-5 self-center rounded-full object-cover"
					/>
				) : (
					<span className="inline-flex h-5 w-5 self-center items-center justify-center rounded-full bg-primary/20 text-xs font-bold">
						{(profile.displayName || profile.handle).charAt(0).toUpperCase()}
					</span>
				)}
				<span className="text-base-content/70 underline decoration-base-content/20 underline-offset-2 hover:decoration-base-content/60">
					{profile.displayName || profile.handle}
				</span>
			</Link>
		);
	}
	if (isDid) {
		return (
			<a
				href={`https://bsky.app/profile/${credit.contributor}`}
				title={didAttr}
				target="_blank"
				rel="noreferrer"
				className="text-base-content/70 underline decoration-base-content/20 underline-offset-2 hover:decoration-base-content/60"
			>
				{profile?.displayName || credit.contributor}
			</a>
		);
	}
	// No identity behind it on the network, and no Anthers account: a name as words.
	return <span className="text-base-content/70">{credit.contributor}</span>;
}
