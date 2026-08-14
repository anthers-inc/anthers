// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One transport control, so the three players press the same buttons.
 *
 * Every control in a player is icon-only, which makes `label` required rather than
 * optional: without it the whole transport reads to a screen reader as a row of unnamed
 * buttons. The label doubles as the hover tooltip, so the two can never disagree.
 *
 * The icon arrives as a *component*, not as rendered children, so this file decides its
 * size. Passing `<PlayIcon className="w-4 h-4" />` at every call site is how the video
 * transport and the music bar drift a pixel apart.
 */
import type { ComponentType, ReactNode } from "react";

type Tone = "primary" | "ghost";
type Size = "xs" | "sm" | "md" | "lg";

const SIZE_CLASS: Record<Size, string> = {
	xs: "btn-xs",
	sm: "btn-sm",
	md: "btn-sm sm:btn-md",
	lg: "btn-md sm:btn-lg",
};

/** Icon sizing per button size — exported so adjacent non-button glyphs match. */
export const TRANSPORT_ICON_CLASS: Record<Size, string> = {
	xs: "w-3.5 h-3.5",
	sm: "w-4 h-4",
	md: "w-4 h-4 sm:w-5 sm:h-5",
	lg: "w-5 h-5 sm:w-6 sm:h-6",
};

export default function TransportButton({
	label,
	icon: Icon,
	onClick,
	tone = "ghost",
	size = "sm",
	active = false,
	disabled = false,
	badge,
	className = "",
}: {
	/** Accessible name AND tooltip — one string so they cannot drift apart. */
	label: string;
	icon: ComponentType<{ className?: string }>;
	onClick: () => void;
	/** `primary` is the single play/pause button; everything else is `ghost`. */
	tone?: Tone;
	size?: Size;
	/**
	 * A latched control that is currently on (shuffle, repeat, captions).
	 *
	 * Renders as a colour change *and* `aria-pressed`, because colour alone is not a
	 * status signal — the accessibility rule and the honest one agree here.
	 */
	active?: boolean;
	disabled?: boolean;
	/** A tiny overlay glyph, e.g. the `1` on repeat-one. */
	badge?: ReactNode;
	className?: string;
}) {
	const toneClass = tone === "primary" ? "btn-primary" : "btn-ghost";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			aria-pressed={active || undefined}
			title={label}
			className={`btn btn-circle relative ${SIZE_CLASS[size]} ${toneClass} ${
				active && tone === "ghost" ? "text-primary" : ""
			} ${className}`}
		>
			<Icon className={TRANSPORT_ICON_CLASS[size]} />
			{badge}
		</button>
	);
}
