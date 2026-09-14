// SPDX-License-Identifier: Apache-2.0
/**
 * What somebody who followed a share link sees under the thing they came to watch: who sent
 * them, and the way to an account of their own.
 *
 * 🚨 **It links to the one signup door rather than signing anybody up in place** (Parker,
 * 2026-09-13). Every account is an ATProto identity, so an account needs a handle chosen or a
 * Bluesky identity proved before it can exist, and a second copy of that ceremony under a video
 * would be a second place that mints accounts. `/subscribe` asks for nothing more than that —
 * the support ladder on it is an offer, not a step — and `next` brings the person straight back
 * to this Work once they have finished, signed in and watching on their own allowance.
 *
 * ⚠️ **It sits below the deliverable, not above it**, because somebody watching something they
 * like should not be interrupted by an invitation. The share link keeps working while they
 * decide.
 */
import { withNextPath } from "@anthers/shared/next-path";
import { Link, useLocation } from "@anthers/web-shared/router";

export default function SharedWorkBanner({
	sharedBy,
}: {
	/** Display name of whoever sent the link, when we know it. */
	sharedBy?: string | null;
}) {
	const location = useLocation();

	return (
		<div className="mt-4 rounded-lg border border-base-300 bg-base-200/60 px-4 py-4 text-sm">
			<p className="text-base-content/80">
				{sharedBy ? <strong>{sharedBy}</strong> : "Someone"} shared this with you, so you can watch
				it without an account — and the creator is paid for your time either way.
			</p>
			<p className="mt-1 text-base-content/60">
				Want your own? Pick a handle, confirm your email, and you'll be brought back here. No
				payment, no plan to pick.
			</p>
			{/* The share token stays out of `next`: a signed-in reader watches on their own
			    allowance, which is the point of making the account. */}
			<Link
				to={withNextPath("/subscribe", location.pathname)}
				className="btn btn-primary btn-sm mt-3"
			>
				Create a Free Account
			</Link>
		</div>
	);
}
