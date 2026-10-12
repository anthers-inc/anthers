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
// post renders its content's opening in the slot; a writing Work has no
// artwork, so its title set in the Fraunces display face IS the artwork;
// music and audio get a waveform poster; the remaining types get a type-icon
// poster. The body does not repeat a title the band already set — the band is
// the poster, and the body is the who-and-when plus the title when the band
// carries something else.
//
// A goods Work (physical) is never locked presentation while buyable — the
// purchase gates receiving it, never seeing it — so its tile shows the art
// and a "from $x" badge where a digital Work would blur behind a lock chip.
// The rule is the resolver's (`services/access.ts`'s goods branch); this tile
// is its feed-shaped consequence.
//
// This is a feed widget, not a general card: WorkCard stays the column card
// the profile, project and post pages render. If another surface wants this
// shape, move it to @anthers/web-shared then, not now.

import { isListened } from "@anthers/shared/content";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import {
	coverFor,
	MaturityVeil,
	useContentPreferences,
} from "@anthers/web-shared/content-preferences";
import { FONTS } from "@anthers/web-shared/fonts";
import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { isAccessResult, type PostListItem, type Work } from "@anthers/web-shared/types";
import { DocumentTextIcon, LinkIcon, PlayIcon } from "@heroicons/react/24/solid";
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
import { contentTypeMeta } from "../ui/ContentTypeBadge";
import PricingBadge from "../ui/PricingBadge";
import TileHoverPreview from "./TileHoverPreview";

/** One entry of the feed: a release of a Work, or a post. */
type FeedEntry = { kind: "post" | "release"; id: number } & Record<string, unknown>;

/** A feed Work as the API sends it: the Work plus the creator the listing joins on. */
type FeedWork = Work & {
	creator?: { handle: string; displayName?: string | null; avatar?: string | null };
	/**
	 * A goods release's store facts — the artwork its first merch variant carries and the
	 * cheapest variant's list price. Present on a physical Work when the store has either.
	 */
	merch?: { mockupUrl: string | null; fromPrice: string | null } | null;
};

/** A feed post as the API sends it — the timeline shape plus the plain-text body excerpt. */
type FeedPost = PostListItem & { excerpt?: string | null };

/**
 * Fallback heights for the decorative waveform, hand-picked to read as an
 * audio waveform rather than a spreadsheet. Purely decorative — the data a
 * real waveform is drawn from is creator content, and the feed serializes no
 * payload.
 */
const DECORATIVE_WAVEFORM = [
	38, 62, 45, 80, 55, 30, 70, 50, 88, 40, 60, 75, 35, 55, 68, 48, 30, 80, 58, 42, 66, 36, 74, 52,
];

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

/** The band a coverless tile shows when its type has no better treatment. */
function IconPosterBand({ type }: { type: string }) {
	const { Icon, label } = contentTypeMeta(type);
	return (
		<div className="aspect-video relative flex flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-base-300/60 to-base-100">
			<Icon className="w-14 h-14 text-base-content/10" />
			<span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-base-content/40">
				{label}
			</span>
		</div>
	);
}

/** Music and audio: a soft gradient, the type's icon, and a decorative waveform. */
function ListenPosterBand({ type, playing = false }: { type: string; playing?: boolean }) {
	const { Icon, label } = contentTypeMeta(type);
	return (
		<div className="aspect-video relative flex flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-secondary/25 to-primary/15">
			<Icon className="w-14 h-14 text-base-content/15" />
			<span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-base-content/40">
				{label}
			</span>
			<div className="absolute inset-x-4 bottom-3 flex items-end gap-[3px] h-8">
				{DECORATIVE_WAVEFORM.map((h, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: the waveform is a static decorative list, never reordered
						key={i}
						// The waveform lights up from the preview's play state — the
						// decorative bars step with the shared equalizer motion while the
						// tile's audio plays beneath, and stand still when nothing plays.
						className={`flex-1 rounded-full bg-base-content/40 origin-bottom ${
							playing ? "opacity-80 motion-safe:animate-eq-bar" : "opacity-35"
						}`}
						style={{
							height: `${h}%`,
							...(playing ? { animationDelay: `${i * 40}ms` } : null),
						}}
					/>
				))}
			</div>
		</div>
	);
}

/**
 * Writing and posts with no artwork: their title set in the display face is
 * the tile's poster. A coverless widget that showed only an icon would read
 * as a broken thumbnail; a tile whose art is typography reads as deliberate.
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
	// A goods release's artwork: the creator's thumbnail, or the store's first mockup.
	// The mockup is public the same way the store panel is — a visitor may look at a shirt.
	const artwork = work.thumbnail || (isGoods ? (work.merch?.mockupUrl ?? null) : null);
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
				className="aspect-video"
			>
				{artwork ? (
					<CoverBand work={work} src={artwork} onDone={onDone} />
				) : (
					<DecorativeArtworkFallback work={work} type={work.type} />
				)}
			</MaturityVeil>
		);
	}
	if (artwork)
		return <CoverBand work={work} src={artwork} previewing={previewing} onDone={onDone} />;
	// No artwork: the band is the type's poster instead.
	if (isListened(work.type)) return <ListenPosterBand type={work.type} playing={previewing} />;
	if (work.type === "text") {
		return <TypographicBand label={contentTypeMeta(work.type).label} title={work.title} />;
	}
	return <IconPosterBand type={work.type} />;
}

/**
 * The poster band a covered Work shows inside the veil — by the same choice the
 * uncovered path makes below it, so revealing the veil changes shape as little as
 * a thumbnail would.
 */
function DecorativeArtworkFallback({ work, type }: { work: FeedWork; type: string }) {
	if (isListened(type)) return <ListenPosterBand type={type} />;
	if (type === "text") {
		return <TypographicBand label={contentTypeMeta(type).label} title={work.title} />;
	}
	return <IconPosterBand type={type} />;
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
	return <TypographicBand label="Post" title={post.title} />;
}

function MetaRow({
	avatar,
	name,
	date,
}: {
	avatar: string | null | undefined;
	name: string;
	date: string;
}) {
	return (
		<div className="flex items-center gap-2 min-w-0">
			{avatar ? (
				<img src={avatar} alt={name} className="w-6 h-6 rounded-full object-cover shrink-0" />
			) : (
				<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold shrink-0">
					{name.charAt(0).toUpperCase()}
				</div>
			)}
			<span className="text-xs text-base-content/70 truncate">{name}</span>
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
function creatorLabel(creator: { handle: string; displayName?: string | null }): string {
	return creator.displayName || creator.handle || "?";
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
function ReleaseTile({ entry }: { entry: FeedEntry }) {
	const work = entry as unknown as FeedWork;
	const { Icon, label } = contentTypeMeta(work.type);
	// A text Work with no artist-chosen thumbnail shows its title in the band,
	// so the body does not repeat it — same rule the post tile keeps.
	const bandIsTypographic = work.type === "text" && !work.thumbnail;

	// ── The hover preview's state ───────────────────────────────────────────────
	//
	// The gate reads this render's access verdict and the meter store; the store
	// read is what keeps the one-at-a-time rule without any tile knowing another
	// exists — each tile only ever compares its key to the singleton's.
	const budget = useMeteredBudget();
	const previewKey = `release-${work.id}`;
	const previewable = useMemo(
		() =>
			tilePreviewPlayable({
				type: work.type,
				access: isAccessResult(work.access) ? work.access : null,
				budget,
			}),
		[work.type, work.access, budget],
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

	const tileClass =
		"group flex flex-col text-left h-full rounded-2xl p-2 bg-base-200 ring-1 ring-transparent hover:ring-base-300/80 hover:bg-base-300/30 transition-all duration-150 overflow-hidden";
	return (
		<Link
			to={workUrl(work)}
			className={tileClass}
			onPointerEnter={onPointerEnter}
			onPointerLeave={onPointerLeave}
		>
			<div className="rounded-lg overflow-hidden">
				<ReleaseBand work={work} previewing={previewing} onDone={endPreview} />
			</div>
			<TileBody>
				<MetaRow
					avatar={work.creator?.avatar}
					name={creatorLabel(work.creator ?? { handle: "?" })}
					date={compactDate(work.originallyReleased ?? work.releasedAt)}
				/>
				{!bandIsTypographic && work.title && (
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
					{work.type === "physical" && work.merch?.fromPrice && (
						<span className="badge badge-sm badge-secondary">from ${work.merch.fromPrice}</span>
					)}
					{work.type === "text" && work.estimatedReadMinutes ? (
						<span className="text-xs text-base-content/40">
							{work.estimatedReadMinutes} min read
						</span>
					) : null}
				</div>
			</TileBody>
		</Link>
	);
}

function PostTile({ entry }: { entry: FeedEntry }) {
	const post = entry as unknown as FeedPost;
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
	const tileClass =
		"group flex flex-col text-left h-full rounded-2xl p-2 bg-base-200 ring-1 ring-transparent hover:ring-base-300/80 hover:bg-base-300/30 transition-all duration-150 overflow-hidden";
	return (
		<Link to={postUrl(post)} className={tileClass}>
			<div className="rounded-lg overflow-hidden">
				<PostBand post={post} />
			</div>
			<TileBody>
				<MetaRow
					avatar={post.creator?.avatar}
					name={creatorLabel(post.creator ?? { handle: "?" })}
					date={compactDate(post.publishedAt ?? post.createdAt)}
				/>
				{!bandIsTitle && post.title && (
					<h3 className="font-semibold text-sm leading-snug line-clamp-2">{post.title}</h3>
				)}
				{!bandCarriesContent && post.excerpt && (
					<p className="text-xs leading-relaxed text-base-content/60 line-clamp-2">
						{post.excerpt}
					</p>
				)}
				<div className="flex items-center gap-1.5 mt-auto pt-1 flex-wrap">
					{post.linkedWorkCount > 0 && (
						<span className="badge badge-sm badge-ghost gap-1">
							<LinkIcon className="w-3 h-3" />
							{post.linkedWorkCount} {post.linkedWorkCount === 1 ? "work" : "works"}
						</span>
					)}
				</div>
			</TileBody>
		</Link>
	);
}

export default function FeedTile({ entry }: { entry: FeedEntry }) {
	if (entry.kind === "release") return <ReleaseTile entry={entry} />;
	return <PostTile entry={entry} />;
}
