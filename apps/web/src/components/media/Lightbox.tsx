// SPDX-License-Identifier: Apache-2.0
/**
 * The image lightbox, shared by the galleries that open it: the Work's image set and
 * a project's screenshots. It owns the overlay only — the caller owns the layout the
 * pictures show in and the index their clicks set — so both galleries lay their
 * pictures out the way their surfaces want and close, step and count the same way.
 *
 * ⚠️ It portals to `document.body`, and that is load-bearing: the app shells wrap page
 * content in `relative isolate` (the Meadow backdrop's scoping, `LoggedInLayout`), which
 * makes every z-index inside the page a layer *of the page*, painted below the sticky
 * header's z-40 — a `fixed inset-0` overlay mounted in the page tree would slide
 * underneath the navbar it means to cover, and its controls would be dead there.
 *
 * ⚠️ The images arrive as display URLs on their payloads, gated by the serializer's
 * deliverable verdict, so this component fetches nothing and re-resolves nothing: it is
 * a viewer, not a delivery path.
 */

import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";

export default function Lightbox({
	images,
	index,
	onIndex,
	alt = "Gallery",
	alts,
}: {
	images: string[];
	/** The open image's position, or null while closed. */
	index: number | null;
	/** Set a new index to step, or null to close. The arrows wrap around the set. */
	onIndex: (index: number | null) => void;
	/** The pictures' alt text, as their payload gates it. */
	alt?: string;
	/** Per-image alt text where each picture carries its own (the preview carousel). */
	alts?: string[];
}) {
	const close = useCallback(() => onIndex(null), [onIndex]);
	const prev = useCallback(
		() => onIndex(index !== null ? (index - 1 + images.length) % images.length : null),
		[index, images.length, onIndex],
	);
	const next = useCallback(
		() => onIndex(index !== null ? (index + 1) % images.length : null),
		[index, images.length, onIndex],
	);

	useEffect(() => {
		if (index === null) return;
		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
			if (e.key === "ArrowLeft") prev();
			if (e.key === "ArrowRight") next();
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
	}, [index, close, prev, next]);

	if (index === null) return null;

	// The overlay leaves the page tree: the shell's isolate wrapper (see the header) is
	// where a fixed overlay would die, and `document.body` is a root-context child.
	return createPortal(
		// biome-ignore lint/a11y/useKeyWithClickEvents: a click on the backdrop is the pointer's shortcut for Close; the keyboard has Escape and the Close button.
		// biome-ignore lint/a11y/noStaticElementInteractions: see above.
		<div
			className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center"
			// Only a click on the backdrop itself closes — not one on the image or a button.
			onClick={(e) => {
				if (e.target === e.currentTarget) close();
			}}
		>
			<button
				type="button"
				className="absolute top-4 right-4 btn btn-circle btn-ghost text-white"
				onClick={close}
				aria-label="Close"
			>
				<XMarkIcon className="w-6 h-6" />
			</button>

			{images.length > 1 && (
				<>
					<button
						type="button"
						className="absolute left-4 btn btn-circle btn-ghost text-white"
						onClick={prev}
						aria-label="Previous"
					>
						<ChevronLeftIcon className="w-6 h-6" />
					</button>
					<button
						type="button"
						className="absolute right-4 btn btn-circle btn-ghost text-white"
						onClick={next}
						aria-label="Next"
					>
						<ChevronRightIcon className="w-6 h-6" />
					</button>
				</>
			)}

			<div className="max-w-5xl max-h-[85vh] p-4">
				<img
					src={images[index]}
					alt={alts?.[index] ?? alt}
					className="max-w-full max-h-[80vh] object-contain mx-auto"
				/>
				<p className="text-center text-white/40 text-xs mt-1">
					{index + 1} / {images.length}
				</p>
			</div>
		</div>,
		document.body,
	);
}
