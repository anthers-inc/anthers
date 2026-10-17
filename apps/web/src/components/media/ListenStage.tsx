// SPDX-License-Identifier: Apache-2.0
/**
 * The listened Work's stage — the pieces the two players' stage layouts share, beyond
 * what `SeekBar` and the transport already give them.
 *
 * The stage is the media frame's fill: its composition is the letterbox box's flex
 * child, so the media area is the video's own profile and the space is used — the
 * waveform as the page's reading surface (see `WaveformDisplay`'s fill mode), the
 * transport at the stage's foot, and — for a song that carries words — a lyrics
 * column beside the waveform, opened by the transport's toggle and never pushed on
 * the listener by default (Parker, 2026-10-16, kept by the stage).
 *
 * The stage mode itself is the players' `stage` prop, set by `WorkDeliverable` when
 * the media frame is present; the embed route (a bare window on one medium) keeps
 * the strip.
 */
import { ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import type { ReactNode } from "react";

/**
 * The toggle that opens the aside column — the transport's own control, so the
 * panel it opens carries no toggle of its own. Rendered only when the Work has
 * something to open: absent, the transport row is shorter by exactly that control.
 */
export function AsideToggle({
	label,
	open,
	onToggle,
}: {
	/** What the column holds — the word the toggle carries. */
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
 * The aside column beside the waveform, whatever the player handed as `aside` —
 * full width on a phone (under the transport's strip), a set-width column on a
 * wide screen. Only mounted open.
 */
export function AsideColumn({ children }: { children: ReactNode }) {
	return <div className="flex min-h-0 w-full sm:w-72 sm:shrink-0 xl:w-96">{children}</div>;
}
