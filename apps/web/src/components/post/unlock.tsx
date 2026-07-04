// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Locked-post presentation. When a post is gated to the viewer, the WHOLE post locks
 * (body + media are withheld server-side) — the viewer sees the title, a blurred
 * cover, and a reason-aware "unlock" call to action, mirroring the Patreon lock UX.
 */
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { Link } from "react-router-dom";
import type { AccessResult } from "../../lib/types";

/** Short call-to-action label for a locked post, by access reason. */
export function unlockLabel(access: AccessResult): string {
	if (access.reason === "login_required") return "Log in to unlock";
	if (access.reason === "payment_required" && access.price) return `Unlock for $${access.price}`;
	return "Join to unlock";
}

/** Blurred cover with a Locked badge — the visual "this is gated" cue. */
export function LockedCover({
	thumbnail,
	className = "",
}: {
	thumbnail?: string | null;
	className?: string;
}) {
	return (
		<div className={`relative overflow-hidden bg-base-300 ${className}`}>
			{thumbnail ? (
				// Blur + scale so the blurred edges don't reveal the frame border.
				<img src={thumbnail} alt="" className="w-full h-full object-cover blur-xl scale-110" />
			) : (
				<div className="w-full h-full bg-gradient-to-br from-base-300 to-base-200" />
			)}
			<div className="absolute inset-0 bg-black/40 flex items-center justify-center">
				<span className="badge badge-neutral gap-1 font-medium">
					<LockClosedIcon className="w-3.5 h-3.5" /> Locked
				</span>
			</div>
		</div>
	);
}

/**
 * Reason-aware unlock panel for the post page (login / join-or-boost). The
 * one-time-purchase case is handled by ProjectPricing, which has the checkout flow.
 */
export function UnlockPanel({
	access,
	creatorName,
	creatorUsername,
}: {
	access: AccessResult;
	creatorName: string;
	creatorUsername?: string;
}) {
	const isLogin = access.reason === "login_required";
	const message = isLogin
		? `Log in to check your access to this post from ${creatorName}.`
		: `Join or boost ${creatorName} to unlock this post and their other members-only work.`;
	const to = isLogin ? "/login" : creatorUsername ? `/${creatorUsername}` : "/subscribe";
	return (
		<div className="card bg-base-200 border border-base-300">
			<div className="card-body items-center text-center gap-3">
				<div className="w-12 h-12 rounded-full bg-base-300 flex items-center justify-center">
					<LockClosedIcon className="w-6 h-6 text-base-content/70" />
				</div>
				<h3 className="font-bold text-lg">Unlock this post</h3>
				<p className="text-sm text-base-content/60 max-w-sm">{message}</p>
				<Link to={to} className="btn btn-primary btn-wide">
					{unlockLabel(access)}
				</Link>
			</div>
		</div>
	);
}
