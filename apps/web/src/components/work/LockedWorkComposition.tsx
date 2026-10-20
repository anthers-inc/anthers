// SPDX-License-Identifier: Apache-2.0
/**
 * The locked Work's composition — the blurred cover and the price or unlock card — as one
 * component, so the no-preview page and the carousel's first slide cannot drift (Parker,
 * 2026-10-19).
 *
 * A video is the feed's treatment at page scale: the thumbnail blurred beneath, the card
 * overlaid on it. Every other kind is the Vimeo On Demand two-up: cover left, card right,
 * stacking below `sm`. Both ride inside `WorkMediaFrame`'s one 16:9 stage, and the caller
 * owns which mount shape that frame takes.
 *
 * The carousel adds nothing here: its thumbnail strip sits below the stage, not over it,
 * so the first slide is the composition exactly as the no-preview page draws it.
 */

import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import type { AccessResult } from "@anthers/web-shared/types";
import InlineUnlock from "../post/InlineUnlock";
import ProjectPricing from "../project/ProjectPricing";
import { isWriting, WorkDescription, type WorkDetail } from "./WorkLayout";

export default function LockedWorkComposition({
	work,
	access,
	creatorName,
}: {
	work: WorkDetail;
	access: AccessResult | null;
	creatorName: string;
}) {
	if (work.type === "video") {
		return (
			<div className="relative w-full overflow-hidden rounded-lg">
				{presentsAsLocked(access) ? (
					<LockedCover thumbnail={work.thumbnail} className="aspect-video w-full" lockedBy={null} />
				) : work.thumbnail ? (
					<img
						src={work.thumbnail}
						alt=""
						className="aspect-video w-full object-cover blur-xl scale-110"
					/>
				) : (
					// ⚠️ The base layer is this box's ONLY height (the overlay rides
					// `absolute inset-0`), so a thumbnail-free Work renders the gradient
					// fill `LockedCover` itself falls back to — unblurred and
					// un-padlocked, because this arm is exactly the not-a-lock state —
					// or the frame collapses to zero height and `overflow-hidden`
					// clips the account card invisible, rendering as absence.
					<div className="aspect-video w-full bg-gradient-to-br from-base-300 to-base-200" />
				)}
				<div className="absolute inset-0 z-10 flex items-center justify-center p-6">
					{/*
					 * ⚠️ A user-shape Work always carries an access verdict, which is
					 * the only shape that reaches this branch — an owner without one
					 * reads canAccess true above and never gets here. So the card
					 * here is whichever the verdict asks for.
					 */}
					{access && (
						<div className="w-full max-w-md rounded-lg shadow-lg">
							{access.requiresPurchase ? (
								<ProjectPricing
									workId={work.id}
									slug={work.slug ?? ""}
									access={access}
									title={work.title ?? "Untitled"}
									creatorHandle={work.creator?.handle ?? ""}
									thumbnail={work.thumbnail}
									creatorHasStripe={work.creatorHasStripe ?? false}
									workType={work.type}
								/>
							) : (
								<InlineUnlock post={work} access={access} />
							)}
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col justify-start gap-4 sm:justify-center">
			{isWriting(work.type) && <WorkDescription work={work} />}
			{/* ⚠️ A signed-out visitor is refused the bytes of free work too, and
			    that is not a lock — the Work is free to everyone and stays free;
			    what is missing is an account for the time to be attributed to. So
			    the cover stays unblurred and un-padlocked here, and the card
			    underneath asks for the account instead. See `presentsAsLocked`. */}
			{/* The locked preview and the purchase decision are one composition: a
			    two-up, equal-height pairing — the blurred cover left, the price card
			    right, both cards' edges aligned. They stack below `sm` with the cover
			    first. Everything else on the page stays full-width; only this
			    pairing is two-up. */}
			{/* ⚠️ `w-full` is load-bearing on both children: a grid item stretched to
			    the row's height lets `aspect-video` derive its WIDTH from that
			    height (254 × 16/9 ≈ 452px), overflowing its 424px track — the
			    aspect ratio silently outranks the track. An explicit width breaks
			    the derive-back and the cover sizes to its column. Found by
			    measuring, invisible in the DOM string. */}
			<div className="w-full sm:grid sm:grid-cols-2 sm:gap-4 sm:items-stretch">
				{presentsAsLocked(access) ? (
					<LockedCover
						thumbnail={work.thumbnail}
						className="aspect-video w-full rounded-lg"
						lockedBy={access ? lockedByBadge(access, creatorName) : null}
					/>
				) : work.thumbnail ? (
					<img
						src={work.thumbnail}
						alt=""
						className="aspect-video w-full rounded-lg object-cover"
					/>
				) : (
					// Same fill as the video arm above: the two-up's cover is its own
					// height and the composition's first column — dropping it for a
					// thumbnail-free Work leaves the pairing one-sided.
					<div className="aspect-video w-full rounded-lg bg-gradient-to-br from-base-300 to-base-200" />
				)}
				{access &&
					(access.requiresPurchase ? (
						/* Every purchase goes through the basket: the pricing card offers
						   the two doors into it and nothing about a card lives on this page. */
						<ProjectPricing
							workId={work.id}
							slug={work.slug ?? ""}
							access={access}
							title={work.title ?? "Untitled"}
							creatorHandle={work.creator?.handle ?? ""}
							thumbnail={work.thumbnail}
							creatorHasStripe={work.creatorHasStripe ?? false}
							workType={work.type}
						/>
					) : (
						<InlineUnlock post={work} access={access} />
					))}
			</div>
		</div>
	);
}
