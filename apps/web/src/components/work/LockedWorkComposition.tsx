// SPDX-License-Identifier: Apache-2.0
/**
 * The locked Work's composition — the cover and the price or unlock card — as one
 * component, so the no-preview page and the carousel's first slide cannot drift (Parker,
 * 2026-10-19).
 *
 * ⭐ **Every kind wears the video gate's treatment** (Parker, 2026-11-07): the cover fills
 * the 16:9 stage and the card sits centered over it. The two-up that preceded it — blurred
 * cover left, price card right, stacking below `sm` — made a game's locked page read unlike
 * a video's for no reason a viewer could see. `CoverCardStage` owns the shape; this
 * component owns what goes in it.
 *
 * 🚨 **The blur is a lock signal and only a lock uses it.** A Public Access Work is free to
 * everyone and merely needs an account for the time to be attributed, so its cover stays
 * clear under a scrim here — see `presentsAsLocked`. The same rule the old two-up's comment
 * carried survives the reshape.
 *
 * The carousel adds nothing here: its thumbnail strip sits below the stage, not over it,
 * so the first slide is the composition exactly as the no-preview page draws it.
 */

import { LockedCover, lockedByBadge, presentsAsLocked } from "@anthers/web-shared/post/unlock";
import type { AccessResult } from "@anthers/web-shared/types";
import InlineUnlock from "../post/InlineUnlock";
import ProjectPricing from "../project/ProjectPricing";
import CoverCardStage, { CoverFallback } from "./CoverCardStage";
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
	const locked = presentsAsLocked(access);
	return (
		<CoverCardStage
			scrim={!locked}
			cover={
				locked ? (
					<div className="absolute inset-0">
						<LockedCover
							thumbnail={work.thumbnail}
							className="h-full w-full"
							lockedBy={access ? lockedByBadge(access, creatorName) : null}
						/>
					</div>
				) : work.thumbnail ? (
					<img
						src={work.thumbnail}
						alt=""
						className="absolute inset-0 h-full w-full object-cover"
					/>
				) : (
					<CoverFallback />
				)
			}
		>
			{/*
			 * ⚠️ A user-shape Work always carries an access verdict, which is the only shape
			 * that reaches this branch — an owner without one reads canAccess true above and
			 * never gets here. So the card here is whichever the verdict asks for.
			 */}
			<div className="mx-auto flex w-full max-w-md flex-col gap-4">
				{/* ⚠️ A piece of writing's standfirst stays readable on its locked page: it is
				    the sample the Work offers, and it rode above the card before the cover
				    became the ground — now on its own panel, because prose over a blurred
				    cover loses its contrast. */}
				{isWriting(work.type) && work.description && (
					<div className="rounded-lg border border-base-300 bg-base-100 p-4 shadow-lg">
						<WorkDescription work={work} />
					</div>
				)}
				{access && (
					<div className="rounded-lg shadow-lg">
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
		</CoverCardStage>
	);
}
