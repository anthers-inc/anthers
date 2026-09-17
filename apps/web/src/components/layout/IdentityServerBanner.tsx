// SPDX-License-Identifier: Apache-2.0

import { useAuth } from "@anthers/web-shared/auth";
import { usePublishingState } from "@anthers/web-shared/publishing";
import { InformationCircleIcon } from "@heroicons/react/24/outline";

/**
 * Tells somebody, on every signed-in page, that the server holding their identity is not
 * answering, what that costs them, and where to see what is known about it.
 *
 * ⭐ **Parker, 2026-09-12**: telling people quickly that their external server is having trouble,
 * and where to check the outage for themselves, "will buy us a lot of good will so we don't get
 * tagged with frustration that should be borne by another service." So it names the other
 * service's status page where there is one.
 *
 * 🚨 **A delay, never a problem to fix, and the copy has to say so.** Releasing, publishing and
 * commenting all go on working; only the records reaching the network wait for the server to
 * come back. Informational styling rather than a warning, and no button, because there is nothing
 * the person can do about somebody else's server. The state it reads is shared with the permission
 * banner above it, so the two make one request between them.
 */
export default function IdentityServerBanner() {
	const { user } = useAuth();
	const state = usePublishingState({ enabled: user != null, poll: true });
	if (!user || state?.server?.reachable !== false) return null;

	const where = state.handle ? `, @${state.handle},` : "";
	const records =
		user.isCreator === true
			? "what you release, publish, comment on, review, vote on and follow"
			: "what you comment on, review, vote on and follow";

	return (
		<div className="bg-info/10 border-b border-info/30 text-sm" role="status">
			<div className="max-w-7xl mx-auto px-4 py-2 flex items-center gap-3 flex-wrap">
				<InformationCircleIcon className="w-4 h-4 text-info shrink-0" />
				<span className="min-w-0 flex-1 text-base-content/80">
					The server holding your identity{where} isn't answering right now, so the records of{" "}
					{records} reach the network late. Everything on Anthers keeps working, and they go out as
					soon as it's back.
				</span>
				{state.server.statusUrl && (
					<a
						href={state.server.statusUrl}
						target="_blank"
						rel="noreferrer"
						className="link link-info ml-auto whitespace-nowrap"
					>
						Check Its Status
					</a>
				)}
			</div>
		</div>
	);
}
