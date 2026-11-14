// SPDX-License-Identifier: Apache-2.0
/**
 * The spoiler reveal, and the plain-text half of the `||…||` convention.
 *
 * ⭐ **The words are in the page and the reader withholds them**, which is the same trade
 * `MaturityVeil` makes for a cover: a courtesy convention rather than access control, so a
 * reader who opens the source or disables the script sees them. What the shape is for is the
 * ordinary reader meeting an ending above the fold: the text is blurred, it cannot be
 * selected or heard by a screen reader, and one deliberate click on the labeled control
 * opens it. Hovering never reveals it, and the openness is not remembered — the next spoiler
 * starts hidden, because opening one says nothing about the next.
 *
 * The button is the accessible door; the blurred words carry a click for a pointer, because
 * clicking the blur is what a reader tries first.
 */
import { splitSpoilers } from "@anthers/shared/spoiler";
import { Fragment, type ReactNode, useState } from "react";

export function Spoiler({ children }: { children: ReactNode }) {
	const [shown, setShown] = useState(false);
	const toggle = () => setShown((value) => !value);

	return (
		<>
			<button
				type="button"
				className="badge badge-neutral badge-sm mr-1 cursor-pointer align-baseline"
				onClick={(event) => {
					// A spoiler may sit inside (or, once revealed, contain) a link. Opening the
					// spoiler is not following that link, so the click stops at the control.
					event.preventDefault();
					event.stopPropagation();
					toggle();
				}}
				aria-expanded={shown}
				aria-label={shown ? "Hide spoiler" : "Show spoiler"}
			>
				{shown ? "Hide" : "Spoiler"}
			</button>
			<span
				className={shown ? undefined : "blur-[3px] cursor-pointer select-none"}
				onClick={
					shown
						? undefined
						: (event) => {
								event.preventDefault();
								event.stopPropagation();
								toggle();
							}
				}
				// Inert keeps the hidden words out of the tab order as well as the accessibility
				// tree — a link inside a spoiler is still a link, and it must not be reachable
				// before the reader has opened what it sits in.
				inert={!shown}
				aria-hidden={!shown}
				title={shown ? undefined : "Show spoiler"}
			>
				{children}
			</span>
		</>
	);
}

/**
 * A comment's plain text with its spoilers hidden.
 *
 * A comment is plain text rather than markdown, so this walks the convention directly. The
 * surrounding element keeps `whitespace-pre-line`, and the spans between the delimiters are
 * inline, so the returns a person typed survive exactly as they did before the marking
 * existed.
 */
export function SpoilerText({ text }: { text: string }) {
	// The offset is the stable identity of a run: a comment's segments are recomputed from the
	// text on every render, and two runs of the same text are the same two runs.
	let offset = 0;
	return (
		<>
			{splitSpoilers(text).map((segment) => {
				const key = `${segment.kind}-${offset}`;
				offset += segment.value.length;
				return segment.kind === "spoiler" ? (
					<Spoiler key={key}>{segment.value}</Spoiler>
				) : (
					<Fragment key={key}>{segment.value}</Fragment>
				);
			})}
		</>
	);
}
