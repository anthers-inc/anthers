// SPDX-License-Identifier: Apache-2.0
/**
 * The Work page's media area — one card, one profile, for every kind (Parker,
 * 2026-10-16; the standard 16:9 profile, 2026-10-19): the video page's layout is
 * canonical, and every other work type derives from it. The card holds a single
 * **16:9 stage** at every width, so flipping between kinds keeps every page element
 * where it was and only the thing inside the stage changes.
 *
 * The card's own padding is the small soft border a 16:9 medium sits inside: the
 * stage is inset from the `bg-base-200` card, and the `bg-base-300` stage is the
 * matte that a wider or taller medium leaves visible — 21:9 letterboxes, 4:3 and a
 * portrait picture pillarbox. The card never grows with its content; a medium
 * larger than the stage is contained by it, and a composition taller than the stage
 * scrolls inside the stage rather than moving the page below.
 *
 * Two mount shapes, decided by what is being mounted rather than by callers' taste:
 *
 * - **`fill`** — the medium draws its own box and is contained by the stage: a
 *   video's player, a hosted build's frame, a picture (`object-contain`). A medium
 *   narrower or taller than 16:9 shows the matte on the sides or above and below
 *   rather than stretching. A page-held meter footer, when it has anything to say,
 *   takes the stage's foot and the medium gives up that height.
 * - **Default** — a composition that lays itself out inside the stage and needs
 *   breathing room: the listened kinds' stage, a comic or ebook reader, a piece of
 *   writing, the goods store panel, a placeholder or a gate. It gets the stage's
 *   padding and scrolls when taller than the stage.
 *
 * Audio, text, the goods panel and the placeholder silhouettes have no native aspect
 * of their own; they take the area the same way every other medium does, and how each
 * one composes inside it is its own subject rather than the frame's.
 *
 * The embed page deliberately never mounts this card: that route is a bare window on
 * one medium, sized to fill whatever surface opens it.
 */
import type { ReactNode } from "react";

export default function WorkMediaFrame({
	children,
	footer,
	overlay,
	fill = false,
	className = "",
}: {
	children: ReactNode;
	/**
	 * The page-held Public Access countdown, when the kind's meter belongs to the page
	 * rather than a player. It is a sibling of the medium, not part of it: a fill medium
	 * gives up its foot to the footer so the warning is never clipped out of the stage,
	 * and a composition lets the footer scroll after it.
	 */
	footer?: ReactNode;
	/** The medium draws its own box; the 16:9 stage contains it. */
	fill?: boolean;
	/**
	 * Something that stands over the stage rather than inside its composition — today the
	 * shared-with affordance, which belongs on the media rather than below the player.
	 *
	 * It rides the stage itself, not the medium's slot, so a scrolling composition (the
	 * readers, a piece of writing) scrolls under it instead of carrying it away, and the
	 * stage's `overflow-hidden` keeps a popover from escaping the media card. The stage also
	 * carries `group` and `data-media-stage` for it: an embed reveals the affordance on hover
	 * through those two, with no pointer tracking in JavaScript.
	 */
	overlay?: ReactNode;
	className?: string;
}) {
	return (
		<div className={`border border-base-300 bg-base-200 p-2 ${className}`}>
			<div
				className="group relative aspect-video w-full overflow-hidden rounded-sm bg-base-300"
				data-media-stage
			>
				{fill ? (
					<div className="absolute inset-0 flex flex-col">
						<div className="min-h-0 flex-1">{children}</div>
						{footer && <div className="shrink-0">{footer}</div>}
					</div>
				) : (
					<div data-media-scroll className="absolute inset-0 overflow-y-auto p-4 sm:p-6">
						{children}
						{footer}
					</div>
				)}
				{overlay}
			</div>
		</div>
	);
}
