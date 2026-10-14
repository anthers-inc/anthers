// SPDX-License-Identifier: Apache-2.0
/**
 * Upload a Work — the first of the two pages a Work is made on, and the one "New Work" opens.
 *
 * It asks for a type, a title, and — optionally — the file. Picking the file creates the Work
 * and moves the creator to its Edit page while the upload carries on, which is the Vimeo-shaped
 * flow Parker chose over one long form (2026-09-13, and the create-on-pick half 2026-09-16).
 * Since 2026-10-10 the file can also be skipped: a Work is drafted from a type and a name and
 * the file is added on its own page, so an upload that failed costs nothing typed here.
 * `WorkUploadForm` carries the reasoning, including why the Work is born private and unrated and
 * what access it proposes.
 */

import { acceptedVideoFormatsSentence } from "@anthers/shared/accepted-formats";
import { useNavigate } from "react-router-dom";
import WorkUploadForm from "../components/content/WorkUploadForm";
import { workUrl } from "../lib/postUrl";
import { Link } from "../lib/router";
import { studioEditWorkUrl, studioUrl } from "../lib/studio";
import type { Work } from "../lib/types";

/**
 * The accepted formats, stated where the file is picked rather than discovered by failure —
 * the second ruling of the wiki's *Originals and the Ladder*. The video pair sentence reads
 * from `@anthers/shared/accepted-formats`, the same dataset the transcode job's refusal
 * states, so what the page promises and what the pipeline delivers are one set. The last
 * line is the expansion posture: additions to the list are deliberate decisions this page
 * states as they land, never a widening that happens without saying so.
 */
const FORMATS_INTRO = `Video — ${acceptedVideoFormatsSentence()}, in any container: MP4, MOV, MKV and WebM all work, and a file a browser can't stream as it stands is remuxed as it arrives, with no re-encode, before processing starts. A video with no audio track is fine too.`;
const FORMATS_AUDIO =
	"Audio — any common audio format, whatever a music player opens. It's converted to MP3 for streaming as it is processed.";
const FORMATS_PAGED =
	"Comics and books — JPG or PNG page images, or a PDF; a book may also be an EPUB.";
const FORMATS_IMAGE = "Images — any format a browser displays.";
const FORMATS_EXPANSION =
	"The list is short on purpose, and it widens only in daylight: a format joins it when Anthers decides to deliver it, and this page states each addition as it lands. If the file you have isn't in the list, re-export it with one from above.";

export default function WorkUploadPage() {
	const navigate = useNavigate();
	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Upload a Work</h1>
			<p className="text-sm text-base-content/60 mb-6">
				A Work is the thing itself — the file or the writing, its access and its price. Pick the
				file if you have it, or name the draft and skip the file for now; you'll add it on the
				Work's own page. Nothing is public until you release it.
			</p>

			<div className="mb-6 rounded-lg bg-base-200/50 p-4 text-sm">
				<p className="mb-2 font-medium">What Anthers accepts</p>
				<ul className="list-disc space-y-1 pl-5 text-base-content/70">
					<li>{FORMATS_INTRO}</li>
					<li>{FORMATS_AUDIO}</li>
					<li>{FORMATS_PAGED}</li>
					<li>{FORMATS_IMAGE}</li>
				</ul>
				<p className="mt-2 text-xs text-base-content/50">{FORMATS_EXPANSION}</p>
			</div>

			<WorkUploadForm
				onCreated={(work: Work) =>
					// A video's editing surface is the Work's OWN page now (the unified
					// creator/user layout, 2026-10-13) — land there; every other kind
					// still meets the Studio's editor.
					navigate(
						work.type === "video" ? workUrl(work) : studioEditWorkUrl(work.publicId ?? work.id),
					)
				}
			/>

			<div className="mt-6 border-t border-base-300 pt-4">
				<Link to={studioUrl("/works")} className="btn btn-ghost">
					Cancel
				</Link>
			</div>
		</div>
	);
}
