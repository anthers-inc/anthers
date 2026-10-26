// SPDX-License-Identifier: Apache-2.0
//
// The feed's uniform widget — one tile shape for every kind of entry the
// chronological feed carries, laid out in a grid. Same size for every type:
// a fixed aspect-video band on top, a compact meta body underneath, in the
// YouTube home-grid shape but carrying posts and eleven Work types rather
// than video alone.
//
// The band is where the types differ, deliberately: an entry with artwork
// (a Work's thumbnail, or a physical Work's store mockup) shows it; a text
// post renders its content's opening in the slot; a Work with no thumbnail
// shows its kind's own poster (`WorkPoster` — the icon, the kind's name and a
// foot drawn for the medium), so the band never reads as a missing picture.
// The body carries the title for every entry, because the band is the poster
// and the title is what the card is.
//
// A goods Work (physical) is never locked presentation while buyable — the
// purchase gates receiving it, never seeing it — so its tile shows the art
// and a "from $x" badge where a digital Work would blur behind a lock chip.
// The rule is the resolver's (`services/access.ts`'s goods branch); this tile
// is its feed-shaped consequence.
//
// This is the widget every listing surface renders: the feed, Discovery, the
// creator page's timeline and type tabs (2026-10-17), and — since 2026-10-24 —
// the Library, which replaced its private card so the three tabs and a
// creator's page show one shape for the same item. A Project renders here too
// as its own entry kind, because a creator page and the Library both mix
// Projects in with Works and posts; the old column ProjectCard had no reader
// left once that landed and is gone. WorkCard and PostCard stay the column
// cards the project and post pages render. The tile stays where it is while
// every consumer is in this app; if a different package wants this shape, move
// it to @anthers/web-shared then, not now.

import { isListened } from "@anthers/shared/content";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import { isDiscoveryReason } from "@anthers/shared/discovery";
import WorkPoster from "@anthers/web-shared/content/work-poster";
import {
	coverFor,
	MaturityVeil,
	useContentPreferences,
} from "@anthers/web-shared/content-preferences";
import { FONTS } from "@anthers/web-shared/fonts";
import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { creatorProjectUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import {
	isAccessResult,
	type PostListItem,
	type Project,
	type Work,
} from "@anthers/web-shared/types";
import {
	DocumentTextIcon,
	LinkIcon,
	PlayIcon,
	RectangleStackIcon,
	UserIcon,
} from "@heroicons/react/24/solid";
import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useMeteredBudget } from "../../lib/public-access";
import {
	activeTilePreview,
	PREVIEW_HOVER_DELAY_MS,
	requestTilePreview,
	subscribeTilePreview,
	tilePreviewPlayable,
} from "../../lib/tile-preview";
import { usePreviewsEnabled } from "../../lib/tile-preview-settings";
import { contentTypeMeta } from "../ui/ContentTypeBadge";
import PricingBadge from "../ui/PricingBadge";
import CreatorLink from "./CreatorLink";
import TileHoverPreview from "./TileHoverPreview";

/** One entry of a listing: a release of a Work, a post, or a Project. */
export type FeedEntry = { kind: "post" | "release" | "project"; id: number } & Record<
	string,
	unknown
>;

/** A feed Work as the API sends it: the Work plus the creator the listing joins on. */
type FeedWork = Work & {
	creator?: { handle: string; displayName?: string | null; avatar?: string | null };
};

/**
 * A Project as a listing sends it. The public and creator-page listings join `creator`
 * as an object; the Library flattens the handle and name beside the row instead
 * (its query already joins users), so both shapes resolve through {@link projectCreator}.
 */
type FeedProject = Project & {
	creatorHandle?: string | null;
	creatorDisplayName?: string | null;
	trackCount?: number;
};

/** A feed post as the API sends it — the timeline shape plus the plain-text body excerpt. */
type FeedPost = PostListItem & { excerpt?: string | null };

/**
 * What a surface adds to a shared tile without changing what the tile is — the Library's
 * purchased and hidden chips, its withdrawn and back-in-drafts notices, and the
 * Hide/Remove controls that belong to the Library rather than to the thing in it.
 */
export interface FeedTileExtras {
	/** Extra chips for the badge row, after the tile's own. */
	badges?: ReactNode;
	/** A line under the badge row — a state the surface states in words rather than a chip. */
	note?: ReactNode;
	/** Surface controls, rendered in a raised row under the body, above the tile's overlay. */
	actions?: ReactNode;
	/** Extra classes on the tile root — the Library dims a hidden entry with `opacity-60`. */
	className?: string;
}

/** Who the unlock copy speaks about, matching WorkCard's rule. */
function creatorName(work: FeedWork): string {
	return work.creator?.displayName || work.creator?.handle || "this creator";
}

function compactDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** A video duration rendered the way a video platform shows it: 25:02. */
function durationLabel(seconds: number | null | undefined): string {
	if (!seconds || seconds <= 0) return "";
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A post with no artwork: its title set in the display face is the tile's
 * poster. A coverless widget that showed only an icon would read as a broken
 * thumbnail; a tile whose art is typography reads as deliberate. A Work never
 * needs this — every kind has its own poster (Parker, 2026-10-24).
 */
function TypographicBand({ label, title }: { label: string; title: string | null }) {
	return (
		<div className="aspect-video relative flex flex-col justify-center gap-2 overflow-hidden bg-base-100 px-5">
			<span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary/70">
				{label}
			</span>
			{title ? (
				<p
					style={{ fontFamily: FONTS.fraunces }}
					className="text-lg leading-snug text-base-content/85 line-clamp-3"
				>
					{title}
				</p>
			) : (
				<DocumentTextIcon className="w-12 h-12 text-base-content/15" />
			)}
		</div>
	);
}

/** A thumbnail as the band, with a video platform's duration chip and hover play. */
function CoverBand({
	work,
	src,
	previewing = false,
	onDone,
}: {
	work: FeedWork;
	src: string;
	/** The tile's hover preview is playing — the in-band player replaces this band's picture. */
	previewing?: boolean;
	/** The preview's finished-for-good callback (fatal failure, or the video ended). */
	onDone: () => void;
}) {
	const duration = work.type === "video" ? durationLabel(work.durationSeconds) : "";
	// The play affordance belongs to what actually plays: a covered video or a
	// listened (audio-family) Work. Everything else a thumbnail can stand for — a
	// shirt, a book, a comic — gets NO hover overlay of its own: the purchase gates
	// receiving, never seeing, and the tile's own highlight is the whole hover story
	// (Parker, the feed's quiet hover).
	const playable = work.type === "video" || isListened(work.type);
	return (
		<div className="relative aspect-video bg-base-300">
			<img src={src} alt="" className="w-full h-full object-cover" />
			{previewing && (
				<TileHoverPreview
					work={{ id: work.id, type: work.type, creatorId: work.creatorId ?? null }}
					onDone={onDone}
				/>
			)}
			{playable && (
				<div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
			)}
			{duration && (
				<span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
					{duration}
				</span>
			)}
			{playable && !previewing && (
				<div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
					<div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
						<PlayIcon className="w-5 h-5 text-black ml-0.5" />
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * A text post's content as the band — the artwork slot IS the opening of the body,
 * clamped to what fits. Reads at body-text size rather than the display face: the
 * writing-Work band's typography is a poster, where here the words themselves are
 * the preview.
 */
function ContentBand({ text }: { text: string }) {
	return (
		<div className="aspect-video relative flex flex-col justify-center overflow-hidden bg-base-100 px-5">
			<p className="text-sm leading-relaxed text-base-content/75 line-clamp-4">{text}</p>
		</div>
	);
}

function ReleaseBand({
	work,
	previewing = false,
	onDone,
}: {
	work: FeedWork;
	/** The tile's hover preview is playing — the band hosts the in-place player. */
	previewing?: boolean;
	/** The preview's finished-for-good callback, passed only where the band is actually visible. */
	onDone: () => void;
}) {
	const { prefs } = useContentPreferences();
	// Locked-to-the-user and veiled handling match WorkCard's, including the
	// signed-out visitor rule (`presentsAsLocked`) and the
	// two-treatments-never-stack rule — a locked cover is already blurred, so a
	// veiled Work reaches here only when not locked.
	//
	// 🚨 The goods exception is the rule the resolver's goods branch states
	// (`services/access.ts`, Parker 2026-10-09): a physical Work is never *locked
	// presentation* while it is simply buyable — the purchase gates RECEIVING the
	// shirt, never SEEING it, so the lock chip never stands in for a store. Only a
	// still-standing gate presents as locked (which `presentsAsLocked` already
	// answers everywhere but `payment_required`), exactly like a digital Work's.
	const access = isAccessResult(work.access) ? work.access : null;
	const isGoods = work.type === "physical";
	const artwork = work.thumbnail;
	const locked = presentsAsLocked(access) && !(isGoods && access?.reason === "payment_required");

	if (locked) {
		return (
			<LockedCover
				thumbnail={artwork}
				className="aspect-video"
				lockedBy={access ? lockedByBadge(access, creatorName(work)) : null}
			/>
		);
	}
	const veil = coverFor(prefs, work);
	if (veil) {
		// No preview under a veil: the band is blurred behind an opaque reveal
		// overlay, so anything mounted inside would stream bytes and register
		// attention for content the user cannot see. The preview exists only where
		// the band is actually shown; revealing (the veil's own click) returns the
		// pointer to a tile whose next enter previews normally.
		return (
			<MaturityVeil
				maturity={work.maturity}
				notes={(work.maturityNotes ?? []).map(contentNoteLabel)}
				because={veil.byRung ? undefined : veil.byNotes.map(contentNoteLabel)}
				// Above the tile's stretched overlay (z-10), so the band's click is the
				// reveal rather than the card's navigation — the veil case of the
				// overlay rule at the release tile.
				className="z-10 aspect-video"
			>
				{artwork ? (
					<CoverBand work={work} src={artwork} onDone={onDone} />
				) : (
					<WorkPoster type={work.type} />
				)}
			</MaturityVeil>
		);
	}
	if (artwork)
		return <CoverBand work={work} src={artwork} previewing={previewing} onDone={onDone} />;
	// No artwork: the band is the kind's own poster — and a preview rides it as an
	// invisible muted element, with the poster's listened foot stepping to the play
	// state rather than the platform taking a picture (Parker, 2026-10-24).
	return (
		<div className="relative">
			<WorkPoster type={work.type} playing={previewing} />
			{/* A coverless video keeps the duration chip its covered sibling shows: the
			    runtime is the Work's own fact, not the picture's. */}
			{work.type === "video" && durationLabel(work.durationSeconds) && (
				<span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
					{durationLabel(work.durationSeconds)}
				</span>
			)}
			{previewing && (
				<TileHoverPreview
					work={{ id: work.id, type: work.type, creatorId: work.creatorId ?? null }}
					onDone={onDone}
				/>
			)}
		</div>
	);
}

function PostBand({ post }: { post: FeedPost }) {
	// A post's thumbnail is its first linked Work's, if any — thumbnails are
	// public by design, so the announcement can show what it announces.
	if (post.thumbnail) {
		// The announcement's artwork, at the same band shape everything keeps. Nothing
		// special happens on hover here — a post does not play — the tile's own
		// highlight is the whole hover story.
		return (
			<div className="relative aspect-video bg-base-300">
				<img src={post.thumbnail} alt="" className="w-full h-full object-cover" />
			</div>
		);
	}
	if (post.excerpt) return <ContentBand text={post.excerpt} />;
	return <TypographicBand label="Post" title={post.displayTitle ?? post.title} />;
}

/**
 * A Project's thumbnail, or the stack poster when it has none. A Project groups
 * Works rather than being a Work itself, so its poster is the stack rather than a type
 * icon: the same band shape every tile keeps, saying what kind of thing it is.
 */
function ProjectBand({ project }: { project: FeedProject }) {
	if (project.thumbnail) {
		return (
			<div className="relative aspect-video bg-base-300">
				<img src={project.thumbnail} alt="" className="w-full h-full object-cover" />
			</div>
		);
	}
	return (
		<div className="aspect-video relative flex flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-base-300/60 to-base-100">
			<RectangleStackIcon className="w-14 h-14 text-base-content/10" />
			<span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-base-content/40">
				Project
			</span>
		</div>
	);
}

function MetaRow({
	avatar,
	handle,
	name,
	date,
	own,
}: {
	avatar: string | null | undefined;
	handle: string | null | undefined;
	name: string;
	date: string;
	/** The viewer made this tile's entry — the feed's own-content source. */
	own?: boolean;
}) {
	return (
		<div className="flex items-center gap-2 min-w-0">
			{avatar ? (
				<img src={avatar} alt={name} className="w-6 h-6 rounded-full object-cover shrink-0" />
			) : handle ? (
				<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold shrink-0">
					{name.charAt(0).toUpperCase()}
				</div>
			) : (
				// A tombstoned creator or a row whose account went away: a neutral face
				// rather than a bubble holding a "?" — the missing-identity fallback the
				// tile family used to print wherever a join was absent.
				<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center shrink-0">
					<UserIcon className="w-3.5 h-3.5 text-base-content/40" />
				</div>
			)}
			{/* The name is the creator's way out of the tile: it rises past the tile's
			    stretched overlay (CreatorLink), so the date stays the tile's. An own
			    entry reads "You": the tile says why it is there (the viewer made it)
			    while the link still leads to the viewer's own page. */}
			<CreatorLink
				handle={handle}
				name={own ? "You" : name}
				className="text-xs text-base-content/70 truncate hover:underline"
			/>
			{date && <span className="text-[11px] text-base-content/40 ml-auto shrink-0">{date}</span>}
		</div>
	);
}

function TileBody({ children }: { children: ReactNode }) {
	// The body's grid row stretches to the row's height, and the badge row
	// pins to its bottom: bodies of different line counts still read as even.
	// The tile's own padding frames the body, so this is the card area's spacing.
	return <div className="p-2.5 gap-1.5 flex-1 flex flex-col">{children}</div>;
}

/**
 * Whose tile: display name when the creator has one, handle otherwise — the
 * same choice the WorkCard body makes. Handles here are long domain suffixes;
 * a display name is worth the space.
 */
function creatorLabel(creator: { handle?: string | null; displayName?: string | null }): string {
	return creator.displayName || creator.handle || "Unknown creator";
}

/** A Project's creator from either listing shape — the joined object, or the flat pair. */
function projectCreator(
	project: FeedProject,
): { handle: string; displayName: string | null } | null {
	if (project.creator?.handle) {
		return { handle: project.creator.handle, displayName: project.creator.displayName };
	}
	if (project.creatorHandle) {
		return { handle: project.creatorHandle, displayName: project.creatorDisplayName ?? null };
	}
	return null;
}

/**
 * Why the entry is here, from the `source` the API states per entry (24.00 Your
 * Feed's every-item-explains-itself): "own" is the viewer's own content, anything
 * else is the follow its creator carries.
 */
function entryIsOwn(entry: FeedEntry): boolean {
	return entry.source === "own";
}

/**
 * The release tile: the grid entry for a released Work, carrying the hover
 * preview's wiring because a release is the one entry kind that plays.
 *
 * Preview hover rules (Parker, 2026-10-12): a deliberate cursor hover only —
 * a 500 ms hold ships the same bytes the tile poster fronts, a glance in
 * transit never does — one tile playing at a time, and full teardown on
 * leave. Never autoplay at any scroll position, mobile or desktop: that would
 * be the engagement mechanic this platform is built to not have.
 */
function ReleaseTile({ entry, extras }: { entry: FeedEntry; extras: FeedTileExtras }) {
	const work = entry as unknown as FeedWork;
	// Why this card is here, from the reason the API states. The whole Ticker shares one
	// candidate reason, so the tile announces it rather than repeating it beneath every
	// card; a stream whose reasons differ (the network feed's follows, supports and
	// saves) can render them visibly instead.
	const reason = isDiscoveryReason(entry.reason) ? entry.reason.label : null;
	const { Icon, label } = contentTypeMeta(work.type);

	// ── The hover preview's state ───────────────────────────────────────────────
	//
	// The gate reads this render's access verdict and the meter store; the store
	// read is what keeps the one-at-a-time rule without any tile knowing another
	// exists — each tile only ever compares its key to the singleton's.
	const budget = useMeteredBudget();
	const previewsEnabled = usePreviewsEnabled();
	const previewKey = `release-${work.id}`;
	const previewable = useMemo(
		() =>
			tilePreviewPlayable({
				previewsEnabled,
				type: work.type,
				access: isAccessResult(work.access) ? work.access : null,
				budget,
			}),
		[previewsEnabled, work.type, work.access, budget],
	);
	// Hover preview is a cursor affordance: a deliberate pointer hover, which
	// touch never produces (a tap enters and immediately navigates anyway).
	const [hoverCapable] = useState(
		() =>
			typeof matchMedia !== "undefined" && matchMedia("(hover: hover) and (pointer: fine)").matches,
	);
	const activePreviewKey = useSyncExternalStore(subscribeTilePreview, activeTilePreview);
	const previewing = previewable && hoverCapable && activePreviewKey === previewKey;

	// The leave/unmount teardown, guarded by an active check so a tile whose
	// preview the store already took never clears the tile that took its place.
	const endPreview = useCallback(() => {
		if (activeTilePreview() === previewKey) requestTilePreview(null);
	}, [previewKey]);
	const timerRef = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (timerRef.current != null) window.clearTimeout(timerRef.current);
			if (activeTilePreview() === previewKey) requestTilePreview(null);
		},
		[previewKey],
	);

	// A deliberate cursor hover: pointer events rather than mouseenter, so the
	// tap that touch produces never schedules a stream. Mouse and pen both count
	// — they are both cursors; touch is not.
	const onPointerEnter = (e: ReactPointerEvent) => {
		if (!previewable || e.pointerType === "touch") return;
		if (timerRef.current != null) window.clearTimeout(timerRef.current);
		timerRef.current = window.setTimeout(() => {
			timerRef.current = null;
			// One tile at a time: asking the store replaces whatever played.
			requestTilePreview(previewKey);
		}, PREVIEW_HOVER_DELAY_MS);
	};
	const onPointerLeave = () => {
		if (timerRef.current != null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		endPreview();
	};

	const tileClass = `group relative flex flex-col text-left h-full rounded-2xl p-2 bg-base-200 ring-1 ring-transparent hover:ring-base-300/80 hover:bg-base-300/30 transition-all duration-150 overflow-hidden${extras.className ? ` ${extras.className}` : ""}`;
	return (
		<div
			className={tileClass}
			data-testid="feed-tile"
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
		>
			<div className="rounded-lg overflow-hidden">
				<ReleaseBand work={work} previewing={previewing} onDone={endPreview} />
			</div>
			<TileBody>
				<MetaRow
					avatar={work.creator?.avatar}
					handle={work.creator?.handle}
					name={creatorLabel(work.creator ?? {})}
					own={entryIsOwn(entry)}
					date={compactDate(work.originallyReleased ?? work.releasedAt)}
				/>
				{work.title && (
					<h3 className="font-semibold text-sm leading-snug line-clamp-2">{work.title}</h3>
				)}
				<div className="flex items-center gap-1.5 mt-auto pt-1 flex-wrap">
					<span className="badge badge-sm gap-1">
						<Icon className="w-3 h-3" />
						{label}
					</span>
					<PricingBadge access={isAccessResult(work.access) ? work.access : null} />
					{/* The goods store's own ask, standing where a digital Work's price badge
					    stands: the purchase gates receiving the thing, not seeing it, so the
					    badge says buy rather than lock. The store's list prices are the source;
					    the tile shows only the cheapest, since no color is picked here. */}
					{work.type === "text" && work.estimatedReadMinutes ? (
						<span className="text-xs text-base-content/40">
							{work.estimatedReadMinutes} min read
						</span>
					) : null}
					{extras.badges}
				</div>
				{extras.note}
			</TileBody>
			{extras.actions && (
				<div className="relative z-10 flex items-center justify-end gap-1 px-1.5 pb-1">
					{extras.actions}
				</div>
			)}
			{/* The tile's own target, stretched over it: painted last (an absolute layer
			    above every z-auto sibling), it takes a click anywhere on the tile, while
			    the parts that are links or controls of their own — CreatorLink, an
			    unrevealed veil — rise past it on a positive z-index and keep their clicks.
			    The veil case is the one that must NOT pass through: its band's click is the
			    reveal, exactly as it was when the tile itself was the link. */}
			<Link
				to={workUrl(work)}
				className="absolute inset-0"
				aria-label={`${work.title || label}${reason ? `. Why this card: ${reason}` : ""}`}
			/>
		</div>
	);
}

function PostTile({ entry, extras }: { entry: FeedEntry; extras: FeedTileExtras }) {
	const post = entry as unknown as FeedPost;
	// See ReleaseTile: the reason is the card's accessible name where the stream shares
	// one candidate reason, not a line repeated under every tile.
	const reason = isDiscoveryReason(entry.reason) ? entry.reason.label : null;
	// The typographic band is the title (a post with a thumbnail or body content
	// has one of those as its art instead); repeating it beneath itself reads as
	// a defect rather than as emphasis.
	const bandIsTitle = !post.thumbnail && !post.excerpt;
	// One excerpt per tile (Parker): when the band IS the body's opening — the
	// post's ContentBand — the card adds nothing; when the band is a thumbnail, the
	// card's excerpt is the tile's only text.
	const bandCarriesContent = Boolean(post.thumbnail) === false && Boolean(post.excerpt);
	// The hover highlight (Parker, against YouTube's own row): the tile gains a soft
	// background tint and a hairline outline — nothing more; no type plays a hover
	// overlay that its content cannot answer. The band sits inset from the tile's
	// rounded edge by the tile's own padding, so the tint reads AROUND the preview
	// the way YouTube's tinted frame reads around a thumbnail.
	const tileClass = `group relative flex flex-col text-left h-full rounded-2xl p-2 bg-base-200 ring-1 ring-transparent hover:ring-base-300/80 hover:bg-base-300/30 transition-all duration-150 overflow-hidden${extras.className ? ` ${extras.className}` : ""}`;
	return (
		<div className={tileClass} data-testid="feed-tile">
			<div className="rounded-lg overflow-hidden">
				<PostBand post={post} />
			</div>
			<TileBody>
				<MetaRow
					avatar={post.creator?.avatar}
					handle={post.creator?.handle}
					name={creatorLabel(post.creator ?? {})}
					own={entryIsOwn(entry)}
					date={compactDate(post.publishedAt ?? post.createdAt)}
				/>
				{!bandIsTitle && post.title && (
					<h3 className="font-semibold text-sm leading-snug line-clamp-2">
						{post.displayTitle ?? post.title}
					</h3>
				)}
				{!bandCarriesContent && post.excerpt && (
					<p className="text-xs leading-relaxed text-base-content/60 line-clamp-2">
						{post.excerpt}
					</p>
				)}
				<div className="flex items-center gap-1.5 mt-auto pt-1 flex-wrap">
					{/* The kind chip every other tile carries. A post's band is its words or
					    its linked Work's art, so without this a post reads as a Work with an
					    odd thumbnail — on the feed where it sits beside releases and in the
					    Library where it sits beside everything kept. */}
					<span className="badge badge-sm gap-1">
						<DocumentTextIcon className="w-3 h-3" />
						Post
					</span>
					{post.linkedWorkCount > 0 && (
						<span className="badge badge-sm badge-ghost gap-1">
							<LinkIcon className="w-3 h-3" />
							{post.linkedWorkCount} {post.linkedWorkCount === 1 ? "work" : "works"}
						</span>
					)}
					{extras.badges}
				</div>
				{extras.note}
			</TileBody>
			{extras.actions && (
				<div className="relative z-10 flex items-center justify-end gap-1 px-1.5 pb-1">
					{extras.actions}
				</div>
			)}
			{/* The tile's own target, stretched over it — see the release tile's overlay. */}
			<Link
				to={postUrl(post)}
				className="absolute inset-0"
				aria-label={`${post.displayTitle || post.title || "A post"}${reason ? `. Why this card: ${reason}` : ""}`}
			/>
		</div>
	);
}

/**
 * The Project tile: a creator's collection of Works, at the same shape as everything else.
 * A creator's page and the Library both list Projects beside Works and posts,
 * so a Project renders as this tile rather than as a second card family.
 */
function ProjectTile({ entry, extras }: { entry: FeedEntry; extras: FeedTileExtras }) {
	const project = entry as unknown as FeedProject;
	const creator = projectCreator(project);
	const trackCount = project.trackCount ?? 0;
	const tileClass = `group relative flex flex-col text-left h-full rounded-2xl p-2 bg-base-200 ring-1 ring-transparent hover:ring-base-300/80 hover:bg-base-300/30 transition-all duration-150 overflow-hidden${extras.className ? ` ${extras.className}` : ""}`;
	return (
		<div className={tileClass} data-testid="feed-tile">
			<div className="rounded-lg overflow-hidden">
				<ProjectBand project={project} />
			</div>
			<TileBody>
				<MetaRow
					avatar={project.creator?.avatar}
					handle={creator?.handle}
					name={creatorLabel(creator ?? {})}
					date={compactDate(project.createdAt)}
				/>
				<h3 className="font-semibold text-sm leading-snug line-clamp-2">{project.title}</h3>
				<div className="flex items-center gap-1.5 mt-auto pt-1 flex-wrap">
					<span className="badge badge-sm gap-1">
						<RectangleStackIcon className="w-3 h-3" />
						Project
					</span>
					{trackCount > 0 && (
						<span className="text-xs text-base-content/40">
							{trackCount} {trackCount === 1 ? "track" : "tracks"}
						</span>
					)}
					{extras.badges}
				</div>
				{extras.note}
			</TileBody>
			{extras.actions && (
				<div className="relative z-10 flex items-center justify-end gap-1 px-1.5 pb-1">
					{extras.actions}
				</div>
			)}
			{/* The tile's own target, stretched over it — see the release tile's overlay.
			    A Project whose creator row is gone keeps the link shape the profile page
			    has always used; the server resolves the slug. */}
			<Link
				to={creatorProjectUrl(creator?.handle ?? "unknown", project.slug)}
				className="absolute inset-0"
				aria-label={project.title || "A Project"}
			/>
		</div>
	);
}

export default function FeedTile({ entry, ...extras }: { entry: FeedEntry } & FeedTileExtras) {
	if (entry.kind === "release") return <ReleaseTile entry={entry} extras={extras} />;
	if (entry.kind === "project") return <ProjectTile entry={entry} extras={extras} />;
	return <PostTile entry={entry} extras={extras} />;
}
