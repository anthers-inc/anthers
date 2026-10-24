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
 * ⭐ **Theater mode replaces the 16:9 profile with the content column's own box.** It is
 * the page-level state `useWorkTheater` carries, and the card reads it directly: the
 * frame grows to the scroll container's measured width and height, gives up its matte
 * border and padding, and the stage becomes `h-full` rather than `aspect-video`. The page
 * stays in flow, so the title, byline and tabs below remain a scroll away — which is what
 * separates this from full screen.
 *
 * Audio, text, the goods panel and the placeholder silhouettes have no native aspect
 * of their own; they take the area the same way every other medium does, and how each
 * one composes inside it is its own subject rather than the frame's.
 *
 * The embed page deliberately never mounts this card: that route is a bare window on
 * one medium, sized to fill whatever surface opens it.
 */
import { type ReactNode, useRef } from "react";
import { useContentStage, useWorkTheater } from "@/lib/work-theater";

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
	const theater = useWorkTheater();
	const active = theater?.theater ?? false;
	const frameRef = useRef<HTMLDivElement>(null);
	/**
	 * The content column's own box while theater mode is on. It is the scroll container's
	 * size rather than a `vw`/`vh` sum, so the sidebar's rail, the banners above the body
	 * and the window's own resize all land in the same number.
	 */
	const stage = useContentStage(frameRef, active);
	const grown = active && stage !== null;
	return (
		<div
			ref={frameRef}
			// The grown card gives up its matte border and padding: at this size it is the
			// screen's own surface rather than a card sitting on the page, and the medium
			// should reach the content area's edges.
			className={`${grown ? "border-0 bg-base-300 p-0" : "border border-base-300 bg-base-200 p-2"} ${className}`}
			style={
				grown
					? {
							width: stage.width,
							height: stage.height,
							// The section sits inside the page's centered reading column, so its
							// own center is the content area's center; this lets it break out to
							// both edges without a second layout tree.
							marginLeft: `calc(50% - ${stage.width / 2}px)`,
						}
					: undefined
			}
		>
			<div
				className={`group relative ${grown ? "h-full w-full" : "aspect-video w-full"} overflow-hidden rounded-sm bg-base-300`}
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
