// SPDX-License-Identifier: Apache-2.0

import { isListened } from "@anthers/shared/content";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import {
	coverFor,
	MaturityVeil,
	useContentPreferences,
} from "@anthers/web-shared/content-preferences";
import {
	LockedCover,
	lockedByBadge,
	presentsAsLocked,
	unlockLabel,
} from "@anthers/web-shared/post/unlock";
import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { isAccessResult, type Work } from "@anthers/web-shared/types";
import { MicrophoneIcon, MusicalNoteIcon, PlayIcon } from "@heroicons/react/24/solid";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import PricingBadge from "../ui/PricingBadge";

/** Who the support would go to, for a card's unlock copy. */
function cardCreatorName(work: WorkCardItem): string {
	return work.creator?.displayName || work.creator?.handle || "this creator";
}

/** A Work as the Catalog lists it, plus the creator the listing joins on. */
type WorkCardItem = Work & {
	creator?: { handle: string; displayName?: string | null; avatar?: string | null };
	/**
	 * A goods release's store facts — the art its first merch variant carries and the
	 * cheapest variant's list price. Present on a physical Work when the store has either.
	 */
	merch?: { mockupUrl: string | null; fromPrice: string | null } | null;
};

/**
 * Renders the date the work first came out anywhere — the creator's asserted original
 * release date, or their release-here date when the work debuted on Anthers.
 *
 * We only ever claim a date the creator gave us, formatted as a date: a creator who knows
 * only the year picks one, and the card renders exactly that.
 */
function dateLabel(work: WorkCardItem): string {
	const iso = work.originallyReleased ?? work.releasedAt ?? work.createdAt;
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}

export default function WorkCard({ work: post }: { work: WorkCardItem }) {
	const date = dateLabel(post);

	// The user-facing serialization is the only shape a card renders; the owner's
	// (whose `access` is the editable rows) never reaches a card. `isAccessResult` is the
	// honest way to take the verdict out of the one-type union.
	const access = isAccessResult(post.access) ? post.access : null;

	// Locked to the user → the card is a gated preview (blurred cover, visible title).
	// Clicking still navigates into the post, where the unlock options live.
	//
	// ⚠️ Not `!canAccess`. A signed-out visitor is refused the bytes of free work too, and
	// rendering that as a padlock would label the whole commons "members only" for the one
	// person the public page is for — see `presentsAsLocked`.
	//
	// 🚨 The goods exception is the rule the resolver's goods branch states
	// (`services/access.ts`, Parker 2026-10-09): a physical Work is never *locked
	// presentation* while it is simply buyable — the purchase gates RECEIVING the
	// shirt, never SEEING it, so the lock chip never stands in for a store. The
	// type-poster band and the price badge carry what a lock would have; a
	// merch-configured Work's mockup is exactly what the store panel opens on.
	const isGoods = post.type === "physical" || post.type === "service";
	const locked = presentsAsLocked(access) && !(isGoods && access?.reason === "payment_required");
	/* The goods band's artwork: the creator's thumbnail, or the store's first mockup
	   (physical only — a service carries no merch rows). The mockup is public the same
	   way the store panel is, so the band shows what the variants route shows. */
	const goodsArtwork = post.type === "physical" ? (post.merch?.mockupUrl ?? null) : null;

	// What this user asked to meet at this rung, and for each kind of content in it. **A veil is
	// not a lock**: a veiled Work is listed, reachable and earning, and the user can uncover it
	// in one click. The two treatments never stack — a locked cover is already blurred, and
	// covering it twice would say the same thing twice while implying the rating is what shut
	// them out.
	const { prefs } = useContentPreferences();
	const cover = locked ? null : coverFor(prefs, post);

	const content = (
		<>
			{/* Thumbnail / cover area */}
			{locked ? (
				<LockedCover
					thumbnail={post.thumbnail || goodsArtwork}
					className="aspect-video"
					lockedBy={access ? lockedByBadge(access, cardCreatorName(post)) : null}
				/>
			) : cover ? (
				<MaturityVeil
					maturity={post.maturity}
					notes={(post.maturityNotes ?? []).map(contentNoteLabel)}
					because={cover.byRung ? undefined : cover.byNotes.map(contentNoteLabel)}
					className="aspect-video"
				>
					{post.thumbnail || goodsArtwork ? (
						<img
							src={(post.thumbnail || goodsArtwork)!}
							alt=""
							className="w-full h-full object-cover"
						/>
					) : (
						<div className="w-full h-full bg-gradient-to-br from-base-300 to-base-200" />
					)}
				</MaturityVeil>
			) : isGoods ? (
				/* A goods Work's band is its store face: the creator's thumbnail, or the
				   first merch mockup the variants route shows a visitor. With neither, a
				   quiet placeholder stands where a product photo would — a shirt with no
				   picture is a setup gap the Studio owns, not a lock to render. */
				goodsArtwork ? (
					<img src={goodsArtwork} alt="" className="w-full h-full object-cover aspect-video" />
				) : (
					<div className="aspect-video bg-gradient-to-br from-base-300 to-base-200" />
				)
			) : (
				<>
					{post.type === "video" && (
						<div className="relative aspect-video bg-base-300">
							{post.thumbnail ? (
								<img src={post.thumbnail} alt="" className="w-full h-full object-cover" />
							) : (
								<div className="w-full h-full flex items-center justify-center">
									<PlayIcon className="w-12 h-12 text-base-content/20" />
								</div>
							)}
							{/* Play icon overlay */}
							<div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/20">
								<div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
									<PlayIcon className="w-6 h-6 text-black ml-0.5" />
								</div>
							</div>
						</div>
					)}

					{isListened(post.type) && (
						<div className="relative h-24 bg-gradient-to-br from-secondary/20 to-primary/20">
							<div className="absolute inset-0 flex items-center justify-center">
								{post.type === "music" ? (
									<MusicalNoteIcon className="w-10 h-10 text-base-content/20" />
								) : (
									<MicrophoneIcon className="w-10 h-10 text-base-content/20" />
								)}
							</div>
						</div>
					)}

					{post.type === "text" && post.thumbnail && (
						<figure>
							<img src={post.thumbnail} alt="" className="w-full h-36 object-cover" />
						</figure>
					)}
				</>
			)}

			{/* Card body */}
			<div className="card-body p-4 gap-2">
				{/* Creator info */}
				<div className="flex items-center gap-2">
					{post.creator?.avatar ? (
						<img
							src={post.creator.avatar}
							alt={post.creator.handle}
							className="w-6 h-6 rounded-full object-cover"
						/>
					) : (
						<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
							{(post.creator?.handle ?? "?").charAt(0).toUpperCase()}
						</div>
					)}
					<span className="text-sm text-base-content/70">{post.creator?.handle}</span>
					<span className="text-xs text-base-content/40 ml-auto">{date}</span>
				</div>

				{/* Title */}
				{post.title && <h3 className="font-semibold line-clamp-2">{post.title}</h3>}

				{locked && access ? (
					<>
						<p className="text-xs text-base-content/40 italic line-clamp-2">
							Members-only work from this creator.
						</p>
						{/* Visual affordance only — the whole card opens the unlock modal. */}
						<span className="btn btn-sm btn-outline btn-block mt-1 pointer-events-none">
							{unlockLabel(access, cardCreatorName(post))}
						</span>
					</>
				) : (
					/* Badges row */
					<div className="flex items-center gap-2 mt-auto pt-1">
						<ContentTypeBadge contentType={post.type} />
						<PricingBadge access={access} />
						{/* The goods store's own ask, standing where a digital Work's price
						    badge stands: the purchase gates receiving the thing, not seeing
						    it, so the badge says buy rather than lock. The store's list prices
						    are the source; the tile shows only the cheapest, since no color
						    is picked here. */}
						{post.type === "physical" && post.merch?.fromPrice && (
							<span className="badge badge-sm badge-secondary">from ${post.merch.fromPrice}</span>
						)}
						{post.estimatedReadMinutes && post.type === "text" && (
							<span className="text-xs text-base-content/40">
								{post.estimatedReadMinutes} min read
							</span>
						)}
					</div>
				)}
			</div>
		</>
	);

	const cardClass =
		"card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden text-left";

	return (
		<Link to={workUrl(post)} className={cardClass}>
			{content}
		</Link>
	);
}
