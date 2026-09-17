// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "@anthers/web-shared/auth";
import { publishingPermissionMissing, usePublishingState } from "@anthers/web-shared/publishing";
import { ExclamationTriangleIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { useLocation } from "react-router-dom";

/**
 * Warns a creator, on every signed-in page, that Anthers cannot publish for them until they give
 * it permission over their repository again.
 *
 * ⭐ **Here rather than at the publish button, and that is Parker's point** (2026-09-12): a
 * creator told only when a release is refused has already done the work and is frustrated by the
 * time they read it. So this shows as soon as they arrive, whether they declined the permission,
 * took it back at their own server, or it stopped working, and it asks again every quarter hour
 * while a tab stays open.
 *
 * ⚠️ **Not on Studio settings**, whose publishing card says the same thing with more room to say
 * it. Two warnings on one page read as two problems.
 */
export default function PublishingPermissionBanner() {
	const { user, grantPublishing } = useAuth();
	const { pathname } = useLocation();
	const isCreator = user?.isCreator === true;
	const state = usePublishingState({ enabled: isCreator, poll: true });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!isCreator || publishingPermissionMissing(state) !== true) return null;
	if (pathname.startsWith("/studio/settings")) return null;

	const handleGrant = async () => {
		setBusy(true);
		setError(null);
		try {
			await grantPublishing();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't ask for the permission.");
			setBusy(false);
		}
	};

	const where = state?.handle ? `your repository at @${state.handle}` : "your repository";

	return (
		<div className="bg-warning/15 border-b border-warning/30 text-sm" role="alert">
			<div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">
				<ExclamationTriangleIcon className="w-4 h-4 text-warning shrink-0" />
				<span className="text-base-content/80">
					Anthers doesn't have your permission to publish to {where}, so you can't release Works or
					publish posts and projects until you give it.
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
