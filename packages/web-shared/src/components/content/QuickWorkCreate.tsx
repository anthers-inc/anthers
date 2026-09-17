// SPDX-License-Identifier: Apache-2.0
/**
 * Make a Work without leaving the post or Project you are in the middle of — the same upload
 * step as the Upload page, in a dialog.
 *
 * 🚨 **This is deliberately the lesser path and must stay that way** (Parker, 2026-09-11).
 * The dedicated flow at `/studio/works/new` is the better one, so this is the quiet second
 * action inside `WorkPicker` rather than a prominent button, and it exists only so that
 * realizing mid-post that the Work does not exist yet is not a reason to abandon the post.
 *
 * ⭐ **It is the Upload page's own form, not a copy of it.** Picking the file makes the Work
 * and the upload carries on in the background while the creator goes back to their post, and
 * the Work comes back already attached. The rest of the Work — access, rating, release — is on
 * its own page, which the picker links to.
 */

import type { Work } from "../../lib/types";
import WorkUploadForm from "./WorkUploadForm";

interface QuickWorkCreateProps {
	/** Called with the created Work, which the caller links or shelves. */
	onCreated: (work: Work) => void;
	onClose: () => void;
}

export default function QuickWorkCreate({ onCreated, onClose }: QuickWorkCreateProps) {
	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box max-w-lg flex flex-col gap-4">
				<div className="flex items-center justify-between">
					<h2 className="text-lg font-bold">New Work</h2>
					<button
						type="button"
						className="btn btn-sm btn-circle btn-ghost"
						onClick={onClose}
						aria-label="Close"
					>
						✕
					</button>
				</div>

				<p className="text-sm text-base-content/60">
					Enough to make it and attach it here. The file keeps uploading while you carry on, and the
					Work stays private until you set its access and release it on its own page.
				</p>

				<WorkUploadForm onCreated={onCreated} next="stay" />

				<div className="modal-action mt-0">
					<button type="button" className="btn btn-ghost" onClick={onClose}>
						Cancel
					</button>
				</div>
			</div>
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}
