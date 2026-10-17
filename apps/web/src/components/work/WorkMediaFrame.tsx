// SPDX-License-Identifier: Apache-2.0
/**
 * The Work page's media area — one card, one profile, for every kind (Parker,
 * 2026-10-16): the video page's layout is canonical, and every other work type derives
 * from it. Whatever the medium is — a player, a picture, a reader, a store panel — it
 * lives inside this card, so flipping between kinds keeps every page element where it
 * was and only the thing inside the card changes. The color is the physical Works'
 * store panel's (`ProjectPricing`'s own `bg-base-200` + `base-300` border, the
 * treatment Parker held up as the reference for what the media card should read as).
 *
 * Two fill shapes, decided by the medium rather than passed on by callers:
 *
 * - **`fill`** — the medium already draws the video profile itself (a video's 16:9
 *   picture; a hosted game, whose play area is the same profile as of this task), so
 *   the card hugs it with no letterbox of its own.
 * - **Centered (default)** — the medium takes the frame's 16:9 area, centered in it:
 *   a short player letterboxes into the same rectangle a video fills, and a medium
 *   with more of its own height — a long piece of writing, a portrait picture, a
 *   reader's own scrolling height — grows the card downward rather than leaving the
 *   shape. (`aspect-ratio` is the *minimum* height of the box while height stays
 *   auto, so growth is what the browser does, not a case coded here.)
 *
 * The embed page deliberately never mounts this card: that route is a bare window on
 * one medium, sized to fill whatever surface opens it.
 */
import type { ReactNode } from "react";

export default function WorkMediaFrame({
	children,
	fill = false,
	className = "",
}: {
	children: ReactNode;
	/** The medium draws the video profile itself; the card hugs it, letterboxed by nothing. */
	fill?: boolean;
	className?: string;
}) {
	if (fill) {
		return <div className={`border border-base-300 bg-base-200 p-3 ${className}`}>{children}</div>;
	}
	return (
		<div className={`border border-base-300 bg-base-200 ${className}`}>
			<div className="flex aspect-video flex-col items-center justify-center gap-4 px-6 py-5">
				{children}
			</div>
		</div>
	);
}
