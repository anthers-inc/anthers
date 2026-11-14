// SPDX-License-Identifier: Apache-2.0
/**
 * One dialog shell: the fixed overlay, the `modal-open` state and the arrival and departure.
 *
 * 🚨 **The wrapper is the whole point.** Every dialog in the app used to hand-write
 * `<div className="modal modal-open">` and render it conditionally, so the browser saw an
 * element that already existed at full opacity and then saw it deleted — no CSS transition
 * could reach either end of that. `<Modal>` keeps the overlay mounted through its exit and
 * hands the enter and leave to `<Appear>`, which is the one primitive that can.
 *
 * 🚨 **The overlay leaves the page tree for `document.body`, for the same reason the Lightbox
 * does.** A dialog is `position: fixed` and `z-999`, but the shell's page column is its own
 * stacking context (`relative isolate`, which scopes the meadow backdrop), and the header is a
 * sibling at `z-40` — so a dialog rendered where a page happens to mount it paints *under* the
 * header, and a tall one loses its close button behind it. Portal is what puts the dialog above
 * the chrome it covers. This was latent until the alpha notice grew the chrome above the top
 * bar (2026-11-13), which pushed the header down over the Work picker's close button.
 *
 * The box keeps whatever `modal-box` markup the dialog already had. The shared rise is a
 * CSS animation on `.modal-box` in `theme.css`, so a dialog that has not adopted this
 * wrapper still arrives the same way; only the exit needs the wrapper.
 */

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { MOTION } from "../../lib/motion";
import Appear from "./Appear";

export default function Modal({
	open,
	children,
	className = "",
	label,
}: {
	open: boolean;
	children: ReactNode;
	/** Extra classes on the overlay, for a dialog that needs its own position. */
	className?: string;
	/** Accessible name. Omit it when the dialog's own heading names it. */
	label?: string;
}) {
	const dialog = (
		<Appear
			show={open}
			className={`modal modal-open ${className}`}
			distance={0}
			duration={MOTION.base}
			exitDuration={MOTION.fast}
			role="dialog"
			aria-label={label}
		>
			{children}
		</Appear>
	);
	// A browser is the only place this app runs, so `document` is always here; the guard is
	// the same one the other portals in the shared layer carry.
	return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
