// SPDX-License-Identifier: Apache-2.0
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

/**
 * Spinner sizing per button size, matched to the icon it stands in for. The ring is
 * drawn rather than delegated to daisyUI's `.loading-spinner`: that mask animates its
 * arc in from zero over the first several hundred milliseconds, which is exactly the
 * window a short buffer occupies — the user would see a dot at the moment the spinner
 * exists to say the click landed.
 */
const TRANSPORT_SPINNER_CLASS: Record<Size, string> = {
	xs: "size-3.5 border-2",
	sm: "size-4 border-2",
	md: "size-4 border-2 sm:size-5",
	lg: "size-5 border-2 sm:size-6",
};

export default function TransportButton({
	label,
	icon: Icon,
	onClick,
	tone = "ghost",
	size = "sm",
	active = false,
	disabled = false,
	busy = false,
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
	 * Renders as a color change *and* `aria-pressed`, because color alone is not a
	 * status signal — the accessibility rule and the honest one agree here.
	 */
	active?: boolean;
	disabled?: boolean;
	/**
	 * The control accepted the press and is waiting on something before its effect
	 * shows — the video player's play button while the element buffers.
	 *
	 * The spinner stands in for the icon rather than sitting beside it, because the
	 * icon is a claim about the present that is not yet true. The button stays
	 * enabled and keeps its action label: a slow load is still something a person
	 * can cancel.
	 */
	busy?: boolean;
	/** A tiny overlay glyph, e.g. the `1` on repeat-one. */
	badge?: ReactNode;
	className?: string;
}) {
	const toneClass = tone === "primary" ? "btn-primary" : "btn-ghost";
	// The play/pause button is a rounded rectangle; the surrounding skip, volume and
	// captions controls stay circular, so the primary act reads as the one different shape.
	const shapeClass = tone === "primary" ? "rounded-xl" : "btn-circle";
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			aria-pressed={active || undefined}
			aria-busy={busy || undefined}
			title={label}
			className={`btn ${shapeClass} relative ${SIZE_CLASS[size]} ${toneClass} ${
				active && tone === "ghost" ? "text-primary" : ""
			} transition-[transform,color,background-color,border-color,box-shadow] duration-fast ease-settle active:scale-95 ${className}`}
		>
			{busy ? (
				<span
					data-testid="transport-spinner"
					className={`inline-block rounded-full border-current border-t-transparent motion-safe:animate-spin ${TRANSPORT_SPINNER_CLASS[size]}`}
					aria-hidden
				/>
			) : (
				<Icon className={TRANSPORT_ICON_CLASS[size]} />
			)}
			{badge}
		</button>
	);
}
