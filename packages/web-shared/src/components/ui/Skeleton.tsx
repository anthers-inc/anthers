// SPDX-License-Identifier: Apache-2.0
/**
 * A shaped placeholder for content that has not arrived — the block a card's cover will
 * occupy, the width a title will take.
 *
 * The point is the shape, not the shimmer: a skeleton that does not match the layout it
 * replaces moves the page twice, once when it appears and once when the real content
 * lands. Compose these to the real layout, and prefer them to a centered spinner wherever
 * the page already knows what it is about to draw.
 *
 * The pulse is Tailwind's, and the global reduced-motion contract pauses it without
 * removing the block, so a reduced-motion reader still sees the reserved space.
 */

export default function Skeleton({ className = "" }: { className?: string }) {
	return (
		<div aria-hidden="true" className={`animate-pulse rounded-md bg-base-300/70 ${className}`} />
	);
}

/** A paragraph-shaped stack, with the last line shortened the way a real one is. */
export function SkeletonText({
	lines = 3,
	className = "",
}: {
	lines?: number;
	className?: string;
}) {
	return (
		<div className={`flex flex-col gap-2 ${className}`}>
			{Array.from({ length: lines }, (_, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: the list is a static count of identical placeholder lines, never reordered
					key={index}
					aria-hidden="true"
					className={`h-3 animate-pulse rounded bg-base-300/70 ${index === lines - 1 ? "w-2/3" : "w-full"}`}
				/>
			))}
		</div>
	);
}
