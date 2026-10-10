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
import type { ReactNode } from "react";
import { contentTypeMeta } from "../ui/ContentTypeBadge";
import PricingBadge from "../ui/PricingBadge";

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
function ListenPosterBand({ type }: { type: string }) {
	const { Icon, label } = contentTypeMeta(type);
	return (
		<div className="aspect-video relative flex flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br from-secondary/25 to-primary/15">
			<Icon className="w-14 h-14 text-base-content/15" />
			<span className="text-[11px] font-semibold uppercase tracking-[0.2em] text-base-content/40">
				{label}
			</span>
			<div className="absolute inset-x-4 bottom-3 flex items-end gap-[3px] h-8 opacity-35">
				{DECORATIVE_WAVEFORM.map((h, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: the waveform is a static decorative list, never reordered
						key={i}
						className="flex-1 rounded-full bg-base-content/40"
						style={{ height: `${h}%` }}
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
function CoverBand({ work, src }: { work: FeedWork; src: string }) {
	const duration = work.type === "video" ? durationLabel(work.durationSeconds) : "";
	return (
		<div className="relative aspect-video bg-base-300">
			<img src={src} alt="" className="w-full h-full object-cover" />
			<div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
			{duration && (
				<span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
					{duration}
				</span>
			)}
			<div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
				<div className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
					<PlayIcon className="w-5 h-5 text-black ml-0.5" />
				</div>
			</div>
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

function ReleaseBand({ work }: { work: FeedWork }) {
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
		return (
			<MaturityVeil
				maturity={work.maturity}
				notes={(work.maturityNotes ?? []).map(contentNoteLabel)}
				because={veil.byRung ? undefined : veil.byNotes.map(contentNoteLabel)}
				className="aspect-video"
			>
				{artwork ? (
					<CoverBand work={work} src={artwork} />
				) : (
					<DecorativeArtworkFallback work={work} type={work.type} />
				)}
			</MaturityVeil>
		);
	}
	if (artwork) return <CoverBand work={work} src={artwork} />;
	// No artwork: the band is the type's poster instead.
	if (isListened(work.type)) return <ListenPosterBand type={work.type} />;
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
		return (
			<div className="relative aspect-video bg-base-300">
				<img src={post.thumbnail} alt="" className="w-full h-full object-cover" />
				<div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
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
	return <div className="card-body p-3 gap-1.5 flex-1">{children}</div>;
}

/**
 * Whose tile: display name when the creator has one, handle otherwise — the
 * same choice the WorkCard body makes. Handles here are long domain suffixes;
 * a display name is worth the space.
 */
function creatorLabel(creator: { handle: string; displayName?: string | null }): string {
	return creator.displayName || creator.handle || "?";
}

export default function FeedTile({ entry }: { entry: FeedEntry }) {
	if (entry.kind === "release") {
		const work = entry as unknown as FeedWork;
		const { Icon, label } = contentTypeMeta(work.type);
		// A text Work with no artist-chosen thumbnail shows its title in the band,
		// so the body does not repeat it — same rule the post tile keeps.
		const bandIsTypographic = work.type === "text" && !work.thumbnail;
		return (
			<Link
				to={workUrl(work)}
				className="group card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden text-left h-full flex flex-col"
			>
				<ReleaseBand work={work} />
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

	const post = entry as unknown as FeedPost;
	// The typographic band is the title (a post with a thumbnail or body content
	// has one of those as its art instead); repeating it beneath itself reads as
	// a defect rather than as emphasis.
	const bandIsTitle = !post.thumbnail && !post.excerpt;
	return (
		<Link
			to={postUrl(post)}
			className="group card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden text-left h-full flex flex-col"
		>
			<PostBand post={post} />
			<TileBody>
				<MetaRow
					avatar={post.creator?.avatar}
					name={creatorLabel(post.creator ?? { handle: "?" })}
					date={compactDate(post.publishedAt ?? post.createdAt)}
				/>
				{!bandIsTitle && post.title && (
					<h3 className="font-semibold text-sm leading-snug line-clamp-2">{post.title}</h3>
				)}
				{post.excerpt && (
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
