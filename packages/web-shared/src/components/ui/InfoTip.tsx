// SPDX-License-Identifier: Apache-2.0
/**
 * A hoverable (i) with a small overlay — the explainer beside a figure or heading a
 * reader could otherwise only wonder about (what the sales tax was derived from, what
 * a creator's "receives" figure lost to the card fee, what a visibility word means).
 * Lives in the shared package beside the other UI primitives so the Studio's sections
 * share it rather than copying it.
 *
 * Shared here after living on `/subscription`, which still renders its own ladder copy
 * through it: the basket's Payment and creator cards ask the same question — show me how
 * this number was built — so the control is one control. A button rather than a bare
 * span, so the tip opens on focus as well as on hover and reads as `aria-describedby`
 * rather than vanishing on a keyboard pass.
 *
 * `text` is the one-line case; `children` carries rich content (the Badge Maker's perk
 * types, where four explanations have to line up together) and `wide` gives that content
 * the room to do so.
 *
 * 🚨 In a surface that CLIPS — the signed-in sidebar hides its overflow around a
 * 16rem column, a `<dialog>` clips at its `modal-box` and establishes its own containing
 * block — the absolute overlay falls off the panel's edge and gets cut, from every anchor
 * a narrow column offers. Pass `unclipped` there: the overlay is then portalled to the
 * document body as a manual popover, measures the (i), and renders at viewport
 * coordinates. **The popover is what makes that work inside a dialog**: `position: fixed`
 * is still positioned against the dialog's containing block and clipped by it, and a
 * plain portal paints underneath a modal's top layer, while a popover joins that layer
 * above it.
 */
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

const TIP_WIDTH = 224; // w-56 — kept in sync with the overlay card below.
const WIDE_TIP_WIDTH = 288; // w-72

/** The absolutely-positioned anchors: centered on the (i), or hard right for an (i)
 *  on a card's right edge. */
const ALIGN_CLASS = {
	center: "left-1/2 -translate-x-1/2",
	right: "right-0",
} as const;

export default function InfoTip({
	text,
	children,
	align = "center",
	unclipped = false,
	wide = false,
	label = "More Information",
}: {
	/** Plain-text content. Ignored when `children` is given. */
	text?: string;
	/** Rich content — a list, a small table, a heading plus lines. */
	children?: ReactNode;
	/** Where the overlay sits relative to the (i): centered (default) or hard right — for an (i) on a card's right edge. */
	align?: "center" | "right";
	/** Portal the overlay as a top-layer popover at viewport coordinates, so an ancestor's clipping or containing block cannot cut it. */
	unclipped?: boolean;
	/** A wider card, for content that needs to line up rather than wrap every few words. */
	wide?: boolean;
	/** The accessible name, for a surface whose tips differ — a per-row (i) in a table needs more than "More Information". */
	label?: string;
}) {
	const [show, setShow] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const tipRef = useRef<HTMLSpanElement>(null);
	const tipId = useId();
	const width = wide ? WIDE_TIP_WIDTH : TIP_WIDTH;

	const open = () => {
		if (unclipped && triggerRef.current) {
			const r = triggerRef.current.getBoundingClientRect();
			// A tip on a field in the lower half of the window opens upward, so the card
			// does not run off the bottom of the screen or over the dialog's buttons. Its
			// own height is not known here, so the flip is a transform rather than math.
			const above = r.top > (window.innerHeight ?? 0) / 2;
			setPos({
				top: above ? r.top - 6 : r.bottom + 6,
				left: Math.max(8, Math.min(r.right - width, (window.innerWidth ?? 0) - width - 8)),
				above,
			});
		}
		setShow(true);
	};

	// The portalled card is a manual popover, so it joins the top layer a modal dialog
	// already occupies. A browser without the popover API falls back to the card in
	// place, which is clipped exactly as it was before — not a crash.
	useEffect(() => {
		if (!unclipped) return;
		const tip = tipRef.current;
		if (!tip) return;
		try {
			if (show) tip.showPopover();
			else tip.hidePopover();
		} catch {
			/* Closed already, or the API is absent: the class toggle still governs it. */
		}
	}, [show, unclipped]);

	const card = (
		<span
			ref={tipRef}
			id={tipId}
			role="tooltip"
			popover={unclipped ? "manual" : undefined}
			className={`pointer-events-none z-50 top-full ${show ? "block" : "hidden"} ${
				unclipped
					? "fixed m-0 overflow-visible border-0 bg-transparent p-0"
					: `absolute mt-1 ${align === "right" ? ALIGN_CLASS.right : ALIGN_CLASS.center}`
			}`}
			style={
				unclipped
					? {
							top: pos?.top,
							left: pos?.left,
							right: "auto",
							bottom: "auto",
							transform: pos?.above ? "translateY(-100%)" : undefined,
						}
					: undefined
			}
		>
			<span
				className={`block ${wide ? "w-72" : "w-56"} whitespace-normal rounded-lg border border-base-content/10 bg-base-300 px-3 py-2 text-left text-xs font-normal leading-relaxed normal-case tracking-normal text-base-content/70 shadow-lg`}
			>
				{children ?? text}
			</span>
		</span>
	);

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				aria-label={label}
				aria-describedby={tipId}
				className="relative ml-1 inline-flex cursor-help align-middle"
				onMouseEnter={open}
				onMouseLeave={() => setShow(false)}
				onFocus={open}
				onBlur={() => setShow(false)}
			>
				<span
					aria-hidden="true"
					className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-base-content/20 text-[9px] font-semibold leading-none text-base-content/40"
				>
					i
				</span>
				{!unclipped && card}
			</button>
			{unclipped && typeof document !== "undefined" ? createPortal(card, document.body) : null}
		</>
	);
}
