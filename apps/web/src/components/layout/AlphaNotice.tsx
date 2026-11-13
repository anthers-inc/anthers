// SPDX-License-Identifier: Apache-2.0
/**
 * The standing notice, on every signed-in page, that Anthers is in alpha and where to write
 * when something on it is rough.
 *
 * ⭐ **Parker, 2026-11-13**: a thin line across the top of the app rather than a page or a
 * modal, saying plainly what the service is and giving a person a real door to report trouble
 * through. The address is a `mailto:` because writing to it is the one thing the notice asks
 * for.
 *
 * ⚠️ **It goes away only when the reader closes it, and then it stays away on this browser**
 * (`lib/alpha-notice.ts` holds the answer). It has no timer and no scroll-away, since a notice
 * that disappears on its own is a notice somebody can miss having read.
 *
 * It is mounted in `LoggedInLayout`, so it belongs to the app chrome: the marketing pages a
 * signed-in reader consults, and every page signed out, carry their own chrome and not this.
 */
import { XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { dismissAlphaNotice, readAlphaNoticeDismissed } from "../../lib/alpha-notice";

export default function AlphaNotice() {
	const [dismissed, setDismissed] = useState(readAlphaNoticeDismissed);
	if (dismissed) return null;

	return (
		<div className="bg-base-200 border-b border-base-300/60 text-sm">
			<div className="max-w-7xl mx-auto px-4 py-1.5 flex items-center gap-3">
				<p className="min-w-0 flex-1 text-base-content/80">
					Anthers is in alpha, and might have some rough edges. Any trouble, email us at{" "}
					<a href="mailto:contact@anthers.org" className="link link-primary">
						contact@anthers.org
					</a>
				</p>
				<button
					type="button"
					aria-label="Dismiss the alpha notice"
					className="btn btn-ghost btn-sm btn-circle -mr-1 shrink-0 text-base-content/60 hover:text-base-content"
					onClick={() => {
						dismissAlphaNotice();
						setDismissed(true);
					}}
				>
					<XMarkIcon className="w-4 h-4" />
				</button>
			</div>
		</div>
	);
}
