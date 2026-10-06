// SPDX-License-Identifier: Apache-2.0
/**
 * A hoverable (i) with a small overlay — the explainer beside a figure a buyer could
 * otherwise only wonder about (what the sales tax was derived from, what a creator's
 * "receives" figure lost to the card fee).
 *
 * Shared here after living on `/subscription`, which still renders its own ladder copy
 * through it: the basket's Payment and creator cards ask the same question — show me how
 * this number was built — so the control is one control. A button rather than a bare
 * span, so the tip opens on focus as well as on hover and reads as `aria-describedby`
 * rather than vanishing on a keyboard pass.
 */
import { useId, useState } from "react";

export default function InfoTip({
	text,
	align = "center",
}: {
	text: string;
	/** Where the overlay sits relative to the (i): centered (default) or hard right — for an (i) on a card's right edge. */
	align?: "center" | "right";
}) {
	const [show, setShow] = useState(false);
	const tipId = useId();
	return (
		<button
			type="button"
			aria-label="More Information"
			aria-describedby={tipId}
			className="relative ml-1 inline-flex cursor-help align-middle"
			onMouseEnter={() => setShow(true)}
			onMouseLeave={() => setShow(false)}
			onFocus={() => setShow(true)}
			onBlur={() => setShow(false)}
		>
			<span
				aria-hidden="true"
				className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-base-content/20 text-[9px] font-semibold leading-none text-base-content/40"
			>
				i
			</span>
			<span
				id={tipId}
				role="tooltip"
				className={`pointer-events-none absolute z-50 mt-1 top-full ${show ? "block" : "hidden"} ${
					align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
				}`}
			>
				<span className="block w-56 rounded-lg border border-base-content/10 bg-base-300 px-3 py-2 text-left text-xs font-normal leading-relaxed normal-case tracking-normal text-base-content/70 shadow-lg">
					{text}
				</span>
			</span>
		</button>
	);
}
