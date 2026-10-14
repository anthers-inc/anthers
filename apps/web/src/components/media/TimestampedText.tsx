// SPDX-License-Identifier: Apache-2.0
/**
 * A plain-text body whose timestamps want to be links — the YouTube model a Work's
 * description and a review body share (Parker, 2026-10-13): the creator writes the
 * text, and a timestamp in it renders as a link that seeks the player to that moment.
 *
 * The parse is {@link splitOnTimestamps}, the one scan every surface agrees on; this
 * component is only its rendering. With no seek bound to the page (a locked Work with
 * no player, a body rendered off the Work page) timestamps stay text — the promise was
 * never made in that context, and nothing here makes it. Copy still renders exactly as
 * written either way: the escape mark `\` is markup, never shown as the copy's own.
 */

import { splitOnTimestamps } from "@anthers/shared/chapters";
import { useMemo } from "react";

export default function TimestampedText({
	text,
	onSeek,
	className = "",
}: {
	text: string;
	/** Seek the player to a clicked timestamp's seconds. Omitted to render plain text. */
	onSeek?: ((seconds: number) => void) | null;
	className?: string;
}) {
	const segments = useMemo(() => splitOnTimestamps(text), [text]);
	return (
		<p className={className}>
			{segments.map((segment, index) => {
				if (segment.seconds === undefined || !onSeek) {
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: a segment's identity is its position in the parse of one constant text; the list never reorders.
						<span key={index}>{segment.text}</span>
					);
				}
				return (
					// biome-ignore lint/suspicious/noArrayIndexKey: see above.
					<span key={index}>
						{/*
						 * A real anchor with a real href — a timestamp is a place in the
						 * media, and middle-click or copy-link stays honest — while the
						 * click itself prefers an in-page seek over the reload a URL
						 * navigation would be. The `?t` the URL carries is this same
						 * moment, kept in the bar so a copied address lands where the
						 * viewer was; every other query parameter rides along.
						 */}
						<a
							href={`?t=${segment.seconds}`}
							className="text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
							onClick={(e) => {
								e.preventDefault();
								onSeek(segment.seconds as number);
								const params = new URLSearchParams(window.location.search);
								params.set("t", String(segment.seconds));
								window.history.replaceState(
									null,
									"",
									`${window.location.pathname}?${params.toString()}${window.location.hash}`,
								);
							}}
						>
							{segment.text}
						</a>
					</span>
				);
			})}
		</p>
	);
}
