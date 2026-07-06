// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect } from "react";
import { useParams } from "react-router-dom";
import { studioEditPostUrl, studioNewPostUrl } from "../../lib/studio";

/**
 * Post authoring moved to the Creator Studio (studio.anthers.org, a separate origin).
 * The old in-site routes (/dashboard/posts/new, /dashboard/posts/:slug/edit) are kept
 * as a safety net for bookmarks/stale links and hard-redirect to the Studio.
 */
export default function StudioRedirect({ mode }: { mode: "new" | "edit" }) {
	const { slug } = useParams<{ slug: string }>();

	useEffect(() => {
		window.location.href = mode === "edit" && slug ? studioEditPostUrl(slug) : studioNewPostUrl();
	}, [mode, slug]);

	return (
		<div className="flex justify-center items-center min-h-[60vh] text-base-content/60">
			Opening the Studio…
		</div>
	);
}
