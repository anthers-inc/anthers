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
 * A video wears the feed's own treatment (a clear cover with the card over it); every other
 * kind is the two-up the locked composition uses. It is not `LockedWorkComposition` because
 * nothing here is locked — the page is public, and the Work simply is not out yet.
 */
import type { AccessResult } from "@anthers/web-shared/types";
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

	const card = (
		<div className="w-full max-w-md rounded-lg border border-base-300 bg-base-100 p-5 shadow-lg">
			<p className="text-sm text-base-content/60">{creatorName}</p>
			<h2 className="text-lg font-semibold">{work.title || "Untitled"}</h2>
			<p className="mt-2 text-sm font-medium">{notice}</p>
			{price && <p className="mt-1 text-sm text-base-content/60">{price}.</p>}
		</div>
	);

	if (work.type === "video") {
		return (
			<div className="relative w-full overflow-hidden rounded-lg">
				{work.thumbnail ? (
					<img src={work.thumbnail} alt="" className="aspect-video w-full object-cover" />
				) : (
					<div className="aspect-video w-full bg-gradient-to-br from-base-300 to-base-200" />
				)}
				<div className="absolute inset-0 flex items-center justify-center bg-black/30 p-6">
					{card}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col justify-start gap-4 sm:flex-row sm:items-center">
			{work.thumbnail ? (
				<img
					src={work.thumbnail}
					alt=""
					className="aspect-video w-full rounded-lg object-cover sm:w-1/2"
				/>
			) : (
				<div className="aspect-video w-full rounded-lg bg-gradient-to-br from-base-300 to-base-200 sm:w-1/2" />
			)}
			{card}
		</div>
	);
}
