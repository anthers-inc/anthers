// SPDX-License-Identifier: Apache-2.0
/**
 * A full-bleed cover with one card centered over it — the Work page's media composition
 * for every state that stands in a deliverable's place (Parker, 2026-11-07).
 *
 * The video gate drew this shape from the start; the locked, pre-release and download
 * compositions now wear it for every kind rather than the Vimeo On Demand two-up that
 * predated them. The cover is the stage's ground and never carries meaning alone: the
 * caller decides whether it is blurred (a gate hides its content) or clear under a scrim
 * (the Work is on sale, coming soon, or already owned).
 *
 * ⚠️ **The card area scrolls, because a 16:9 stage is shorter than a price card on a
 * phone** — at a 390px viewport the stage is about 200px tall and the card is taller than
 * that. So the card is centered by a `min-h-full` flex box inside the scroll area rather
 * than by an absolute overlay or `h-full`: a card taller than the stage then grows the
 * box and scrolls into view, instead of being clipped at both ends where a `justify-center`
 * overlay would put the top half out of reach.
 */
import type { ReactNode } from "react";

export default function CoverCardStage({
	cover,
	scrim = false,
	className = "",
	children,
}: {
	/** The stage's ground — an image, `LockedCover`, or the fallback fill. */
	cover: ReactNode;
	/** Darken a clear cover so the card reads against it. A blurred cover carries its own. */
	scrim?: boolean;
	className?: string;
	/** The card, sized by its own `max-w-*` and centered by this stage. */
	children: ReactNode;
}) {
	return (
		<div className={`relative h-full w-full overflow-hidden rounded-lg ${className}`}>
			{cover}
			{scrim && <div className="absolute inset-0 bg-black/30" aria-hidden="true" />}
			<div className="absolute inset-0 z-10 overflow-y-auto">
				<div className="flex min-h-full items-center justify-center p-6">
					<div className="w-full">{children}</div>
				</div>
			</div>
		</div>
	);
}

/** The cover's fallback when a Work carries no thumbnail, shared by every state. */
export function CoverFallback() {
	return <div className="absolute inset-0 bg-gradient-to-br from-base-300 to-base-200" />;
}
