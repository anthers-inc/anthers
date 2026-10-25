// SPDX-License-Identifier: Apache-2.0
/**
 * What a Sticker leaves behind: an outline that counts levels and never shows an amount.
 *
 * ⭐ **The decoration scales with how many distinct levels a thing has received, not with how
 * many Stickers or how much money** (Parker, 2026-09-13). One Sticker at each level and fifty
 * spread across every level look identical, so a reader can tell the least that was given and
 * never the actual amount. That is why this draws concentric stripes rather than a count, a
 * badge or a chip: there is no number in it to read.
 *
 * ⭐ **One color per level, cheapest first.** The outer stroke is the lowest denomination the
 * thing has received and each further level adds a stripe inside it, so the mark reads as one
 * line that got richer rather than as three unrelated colors. Reddit's award outline on a
 * comment is the reference Parker gave.
 *
 * ⚠️ **Nothing renders without a level**, so a page with no Stickers is unchanged rather than
 * carrying an empty badge — and a Sticker its giver removed, or one a takedown voided, is not
 * in the list it is handed.
 */
import { badgeColor } from "@anthers/shared/badge-art";
import type { StickerLevel } from "@anthers/shared/stickers";

/**
 * The three insets, cheapest outermost.
 *
 * ⚠️ **Fixed geometry rather than a computed stack**: the shape only has to read as nested
 * lines, and arithmetic that derived each inset from the last is the kind of thing that
 * silently draws two stripes on top of each other when a fourth level is ever added.
 */
const RINGS = [
	{ x: 1, y: 1, width: 32, height: 14, rx: 7 },
	{ x: 4, y: 4, width: 26, height: 8, rx: 4 },
	{ x: 7, y: 7, width: 20, height: 2, rx: 1 },
];

export default function StickerDecoration({
	levels,
	label,
}: {
	/** The levels present, cheapest first — the order the stripes are drawn in. */
	levels: readonly StickerLevel[];
	/** What the outline sits on, for the screen reader — "this post", "Ana's comment". */
	label: string;
}) {
	if (levels.length === 0) return null;

	return (
		<span
			className="inline-flex shrink-0 items-center"
			role="img"
			aria-label={`Stickers on ${label}: ${levels.length} ${levels.length === 1 ? "level" : "levels"}`}
			data-sticker-decoration={levels.length}
		>
			<svg
				viewBox="0 0 34 16"
				width={34}
				height={16}
				aria-hidden="true"
				className="overflow-visible"
			>
				{levels.slice(0, RINGS.length).map((level, index) => {
					const ring = RINGS[index]!;
					return (
						<rect
							key={level.id}
							x={ring.x}
							y={ring.y}
							width={ring.width}
							height={ring.height}
							rx={ring.rx}
							fill="none"
							stroke={badgeColor(level.color).fill}
							strokeWidth={1.6}
						/>
					);
				})}
			</svg>
		</span>
	);
}
