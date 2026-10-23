// SPDX-License-Identifier: Apache-2.0
/**
 * New Work — the one page a Work is made on, and the one "New Work" opens.
 *
 * The flow asks for a name, a category, a type and a delivery, in that order. The Work is
 * created when the type is chosen (a Work cannot exist without one), so a draft is in the
 * Works list from that moment; the delivery step patches it and the creator lands on its
 * own page. Nothing uploads here: the file, the set, the build and the hosted build belong
 * to the Work's media area, where the Work is seen.
 *
 * `NewWorkFlow` carries the reasoning for the order and the create-on-type decision.
 */

import { useNavigate } from "react-router-dom";
import NewWorkFlow from "../components/content/NewWorkFlow";
import { workUrl } from "../lib/postUrl";
import { Link } from "../lib/router";
import { studioUrl } from "../lib/studio";
import type { Work } from "../lib/types";

export default function WorkUploadPage() {
	const navigate = useNavigate();
	return (
		<div className="mx-auto w-full max-w-4xl px-4 py-8">
			<h1 className="text-2xl font-bold">New Work</h1>
			<p className="mt-2 mb-6 max-w-2xl text-sm text-base-content/60">
				A Work is the thing itself — the file or the writing, its access and its price. Start with
				what it is; nothing is public until you release it.
			</p>

			<NewWorkFlow
				onCreated={(work: Work) =>
					// The flow has already made the draft; this lands on it, where its media and
					// the rest of its details are filled in.
					navigate(workUrl(work))
				}
			/>

			<div className="mt-6 border-t border-base-300 pt-4">
				<Link to={studioUrl("/works")} className="btn btn-ghost">
					Back to your Works
				</Link>
			</div>
		</div>
	);
}
