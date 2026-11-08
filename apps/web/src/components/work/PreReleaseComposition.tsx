// SPDX-License-Identifier: Apache-2.0
/**
 * The coming-soon composition — the page a pre-release Work opens.
 *
 * ⭐ **It is the purchase card's place without the purchase** (Parker, 2026-11-07): the
 * cover, the title, the creator and the price the Work will ask are all readable, and the
 * one thing missing is a way to buy, download or play. The release date is the only date
 * on the page; the pre-release date is when the page itself opened and is not a reader's
 * business.
 *
 * Every kind wears the video treatment — the clear cover fills the stage and the card sits
 * centered over it (Parker, 2026-11-07). It is not `LockedWorkComposition` because nothing
 * here is locked — the page is public, the Work simply is not out yet, and the cover is
 * therefore never blurred.
 */
import type { AccessResult } from "@anthers/web-shared/types";
import CoverCardStage, { CoverFallback } from "./CoverCardStage";
import type { WorkDetail } from "./WorkLayout";

function releaseDateText(iso: string | null | undefined): string | null {
	if (!iso) return null;
	return new Date(iso).toLocaleDateString("en-US", {
		month: "long",
		day: "numeric",
		year: "numeric",
	});
}

export default function PreReleaseComposition({
	work,
	access,
	creatorName,
}: {
	work: WorkDetail;
	access: AccessResult | null;
	creatorName: string;
}) {
	const date = releaseDateText(work.scheduledReleaseAt);
	const notice = date ? `Coming soon, available on ${date}` : "Coming soon";
	// What the Work will ask, stated without a door. A viewer's own price is the one they
	// would be charged at release, so a supporter sees their rung's price rather than the
	// list price.
	const price =
		access?.requiresPurchase && access.price
			? `$${access.price} when it opens`
			: access?.isFree
				? "Free when it opens"
				: null;

	return (
		<CoverCardStage
			scrim
			cover={
				work.thumbnail ? (
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
			<div className="mx-auto w-full max-w-md rounded-lg border border-base-300 bg-base-100 p-5 shadow-lg">
				<p className="text-sm text-base-content/60">{creatorName}</p>
				<h2 className="text-lg font-semibold">{work.title || "Untitled"}</h2>
				<p className="mt-2 text-sm font-medium">{notice}</p>
				{price && <p className="mt-1 text-sm text-base-content/60">{price}.</p>}
			</div>
		</CoverCardStage>
	);
}
