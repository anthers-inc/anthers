// SPDX-License-Identifier: Apache-2.0
/**
 * Upload a Work — the first of the two pages a Work is made on, and the one "New Work" opens.
 *
 * It asks for a type, a title and the file, and nothing else. Picking the file creates the Work
 * and moves the creator to its Edit page while the upload carries on, which is the Vimeo-shaped
 * flow Parker chose over one long form (2026-09-13, and the create-on-pick half 2026-09-16).
 * `WorkUploadForm` carries the reasoning, including why the Work is born private and unrated and
 * what access it proposes.
 */

import { useNavigate } from "react-router-dom";
import WorkUploadForm from "../components/content/WorkUploadForm";
import { Link } from "../lib/router";
import { studioEditWorkUrl, studioUrl } from "../lib/studio";

export default function WorkUploadPage() {
	const navigate = useNavigate();
	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Upload a Work</h1>
			<p className="text-sm text-base-content/60 mb-6">
				A Work is the thing itself — the file, its access and its price. Start with the file, and
				you'll add everything else on the Work's own page while it uploads. Nothing is public until
				you release it.
			</p>

			<WorkUploadForm onCreated={(work) => navigate(studioEditWorkUrl(work.publicId ?? work.id))} />

			<div className="mt-6 border-t border-base-300 pt-4">
				<Link to={studioUrl("/catalog")} className="btn btn-ghost">
					Cancel
				</Link>
			</div>
		</div>
	);
}
