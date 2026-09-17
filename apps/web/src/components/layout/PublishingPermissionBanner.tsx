// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "@anthers/web-shared/auth";
import {
	interactionPermissionMissing,
	publishingPermissionMissing,
	usePublishingState,
} from "@anthers/web-shared/publishing";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useLocation } from "react-router-dom";

/**
 * Warns anybody signed in, on every page, that Anthers cannot write the records they create
 * until they give it permission over their repository again.
 *
 * ⭐ **Here rather than at the button that fails, and that is Parker's point** (2026-09-12):
 * somebody told only when a release or a comment is refused has already done the work and is
 * frustrated by the time they read it. So this shows as soon as they arrive, whether they
 * declined the permission, took it back at their own server, or it stopped working, and it asks
 * again every quarter hour while a tab stays open.
 *
 * It says which of two things is broken, because they are different permissions: a creator's
 * Works, posts and projects, and anybody's comments, reviews, votes and follows. Giving it again
 * asks for everything the account needs in one round trip.
 *
 * ⚠️ **A creator's missing publishing permission is not repeated on Studio settings**, whose card
 * says it with more room. Two warnings on one page read as two problems.
 */
export default function PublishingPermissionBanner() {
	const { user, grantPublishing } = useAuth();
	const { pathname, search } = useLocation();
	const state = usePublishingState({ enabled: user != null, poll: true });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const isCreator = user?.isCreator === true;
	const publishing = isCreator && publishingPermissionMissing(state) === true;
	const interactions = interactionPermissionMissing(state) === true;
	if (!user || (!publishing && !interactions)) return null;
	if (publishing && pathname.startsWith("/studio/settings")) return null;

	const handleGrant = async () => {
		setBusy(true);
		setError(null);
		try {
			// A creator restoring publishing lands on Studio settings, which says what happened. A
			// reader comes back to the page they were on.
			await grantPublishing(publishing ? undefined : `${pathname}${search}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't ask for the permission.");
			setBusy(false);
		}
	};

	const where = state?.handle ? `your repository at @${state.handle}` : "your repository";
	const blocked = publishing
		? interactions
			? "release Works, publish posts and projects, or comment, review, vote and follow"
			: "release Works or publish posts and projects"
		: "comment, review, vote or follow";

	return (
		<div className="bg-warning/15 border-b border-warning/30 text-sm" role="alert">
			<div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">
				<ExclamationTriangleIcon className="w-4 h-4 text-warning shrink-0" />
				<span className="text-base-content/80">
					Anthers doesn't have your permission to write to {where}, so you can't {blocked} until you
					give it.
				</span>
				{error && <span className="text-error">{error}</span>}
				<button
					type="button"
					className="btn btn-warning btn-xs ml-auto"
					onClick={handleGrant}
					disabled={busy}
				>
					{busy ? "Starting…" : "Give Permission"}
				</button>
			</div>
		</div>
	);
}
