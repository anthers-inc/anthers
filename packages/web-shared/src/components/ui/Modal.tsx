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
 * The box keeps whatever `modal-box` markup the dialog already had. The shared rise is a
 * CSS animation on `.modal-box` in `theme.css`, so a dialog that has not adopted this
 * wrapper still arrives the same way; only the exit needs the wrapper.
 */

import type { ReactNode } from "react";
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
	return (
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
}
