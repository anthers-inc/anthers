// SPDX-License-Identifier: Apache-2.0
/**
 * The listened Work's stage — the pieces the two players' stage layouts share, beyond
 * what `SeekBar` and the transport already give them.
 *
 * The stage is the media frame's fill: its composition is the letterbox box's flex
 * child, so the media area is the video's own profile and the space is used — the
 * waveform as the page's reading surface (see `WaveformDisplay`'s fill mode), the
 * transport at the stage's foot, and — for a song that carries words — a lyrics drawer
 * over the waveform's right side, opened by the transport's toggle and never pushed on
 * the listener by default (Parker, 2026-10-16, kept by the stage).
 *
 * ⭐ **The drawer is out of flow, and that is the point** (Parker, 2026-10-19). It used
 * to be a column in the stage's flex row, so the words' length decided the media area's
 * height: a long song grew the whole card downward and the player's dimensions became a
 * function of how many lines the lyrics filled. An overlay takes its height from the
 * waveform's own area instead, scrolls what does not fit, and leaves the card the same
 * size whatever the words do.
 *
 * The stage mode itself is the players' `stage` prop, set by `WorkDeliverable` when
 * the media frame is present; the embed route (a bare window on one medium) keeps
 * the strip.
 */
import { ChevronDownIcon, ChevronUpIcon, XMarkIcon } from "@heroicons/react/24/solid";
import type { ReactNode } from "react";
import { WORK_LYRICS_HEADING_CLASS } from "../work/LyricsPanel";

/**
 * The toggle that opens the aside drawer — the transport's own control, so the panel
 * it opens carries no toggle of its own. Rendered only when the Work has something to
 * open: absent, the transport row is shorter by exactly that control.
 */
export function AsideToggle({
	label,
	open,
	onToggle,
}: {
	/** What the drawer holds — the word the toggle carries. */
	label: string;
	open: boolean;
	onToggle: () => void;
}) {
	const Icon = open ? ChevronUpIcon : ChevronDownIcon;
	return (
		<button
			type="button"
			aria-expanded={open}
			onClick={onToggle}
			title={open ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
			className="btn btn-ghost btn-sm gap-1 text-xs font-semibold text-base-content/60"
		>
			{label}
			<Icon aria-hidden className="size-3.5 shrink-0" />
		</button>
	);
}

/**
 * The aside drawer itself: a right-hand overlay anchored to the area it is rendered
 * in (the stage's waveform row), so its height is that area's rather than its content's.
 * Mounted whenever the Work has anything to open — the closed state is a transform,
 * which is what lets it slide — and inert while closed so a hidden panel never takes a
 * tab stop. Its header keeps the label and the one close affordance; the content
 * scrolls beneath it.
 */
export function AsideDrawer({
	label,
	open,
	onClose,
	children,
}: {
	label: string;
	open: boolean;
	onClose: () => void;
	children: ReactNode;
}) {
	return (
		<aside
			aria-label={label}
			aria-hidden={!open}
			inert={!open}
			data-testid="stage-aside"
			className={`absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-base-300/70 bg-base-100/95 shadow-2xl backdrop-blur-sm transition-transform duration-200 motion-reduce:transition-none sm:w-80 xl:w-96 ${
				open ? "translate-x-0" : "pointer-events-none translate-x-full"
			}`}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-base-300/70 px-4 py-2">
				<h2 className={WORK_LYRICS_HEADING_CLASS}>{label}</h2>
				<button
					type="button"
					onClick={onClose}
					aria-label={`Close ${label.toLowerCase()}`}
					className="btn btn-ghost btn-xs btn-circle -mr-1"
				>
					<XMarkIcon aria-hidden className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
		</aside>
	);
}
