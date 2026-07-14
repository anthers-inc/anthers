// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Locked-post presentation. When a post is gated to the viewer, the WHOLE post locks
 * (body + media are withheld server-side) — the viewer sees the title, a blurred
 * cover, and a reason-aware "unlock" call to action, mirroring the Patreon lock UX.
 */
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { postUrl } from "../../lib/postUrl";
import type { AccessResult, PostListItem } from "../../lib/types";

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
 * Reason-aware unlock panel for the post page (login / join-or-sow-Seeds). The
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
		: `Join or sow Seeds for ${creatorName} to unlock this post and their other members-only work.`;
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

/**
 * Quick-unlock modal, opened from a locked timeline card. Adapts to the viewer:
 * anonymous → log in / sign up (returning to the post after auth); logged-in but
 * gated → join the creator; priced → go to the post's purchase flow.
 */
export function UnlockModal({
	post,
	access,
	onClose,
}: {
	post: PostListItem;
	access: AccessResult;
	onClose: () => void;
}) {
	const { isAuthenticated } = useAuth();

	// Close on Escape.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const path = postUrl(post);
	const creatorName = post.creator?.displayName || post.creator?.username || "this creator";
	const avatar = post.creator?.avatar;
	// Log in / sign up return to the post so it unlocks in place after auth.
	const returnState = { from: { pathname: path } };

	let body: React.ReactNode;
	if (!isAuthenticated) {
		body = (
			<>
				<p className="text-sm text-base-content/60">Log in or sign up for access.</p>
				<Link to="/login" state={returnState} className="btn btn-primary btn-block">
					Log in
				</Link>
				<Link to="/signup" state={returnState} className="btn btn-ghost btn-block">
					Create an account
				</Link>
			</>
		);
	} else if (access.reason === "payment_required") {
		body = (
			<>
				<p className="text-sm text-base-content/60">
					One purchase unlocks everything in this post.
				</p>
				<Link to={path} className="btn btn-primary btn-block">
					{unlockLabel(access)}
				</Link>
			</>
		);
	} else {
		body = (
			<>
				<p className="text-sm text-base-content/60">
					Join or sow Seeds for {creatorName} to unlock this and their members-only work.
				</p>
				<Link
					to={post.creator?.username ? `/${post.creator.username}` : "/subscribe"}
					className="btn btn-primary btn-block"
				>
					Join to unlock
				</Link>
			</>
		);
	}

	return (
		<div className="modal modal-open" role="dialog">
			<div className="modal-box max-w-sm text-center flex flex-col items-center gap-3">
				<button
					type="button"
					className="btn btn-sm btn-circle btn-ghost absolute right-3 top-3"
					onClick={onClose}
					aria-label="Close"
				>
					✕
				</button>
				{avatar ? (
					<img src={avatar} alt="" className="w-14 h-14 rounded-full object-cover" />
				) : (
					<div className="w-14 h-14 rounded-full bg-base-300 flex items-center justify-center">
						<LockClosedIcon className="w-6 h-6 text-base-content/70" />
					</div>
				)}
				<h3 className="font-bold text-lg leading-tight">Unlock this post from {creatorName}</h3>
				<div className="flex flex-col gap-2 w-full mt-1">{body}</div>
			</div>
			{/* Backdrop click closes. */}
			<button type="button" className="modal-backdrop" onClick={onClose} aria-label="Close">
				close
			</button>
		</div>
	);
}
