// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Locked-post presentation. When a post is gated to the viewer, the WHOLE post locks
 * (body + media are withheld server-side) — the viewer sees the title, a blurred
 * cover, and a reason-aware "unlock" call to action, mirroring the Patreon lock UX.
 */
import { ANTHERS_BADGES, type BadgeKey, badgeLabel } from "@anthers/shared/constants";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { useEffect } from "react";
import { useAuth } from "../../lib/auth";
import { postUrl } from "../../lib/postUrl";
import { Link } from "../../lib/router";
import type { AccessResult, PostListItem, UnlockRoute } from "../../lib/types";

/**
 * The cheapest route into a gated post, and who the Seeds would go to.
 *
 * "Cheapest" is the fewest Seeds the viewer still has to add, which is what they asked
 * for; a tie goes to the creator, since Seeds given to a creator reach them in full.
 * Returns null when the post isn't gate-openable (purchase-only, or logged out).
 */
export function cheapestRoute(
	access: AccessResult,
	creatorName: string,
): { route: UnlockRoute; target: string } | null {
	const anthers = access.unlock?.anthers;
	const creator = access.unlock?.creator;
	if (anthers && creator) {
		return creator.moreNeeded <= anthers.moreNeeded
			? { route: creator, target: creatorName }
			: { route: anthers, target: "Anthers" };
	}
	if (creator) return { route: creator, target: creatorName };
	if (anthers) return { route: anthers, target: "Anthers" };
	return null;
}

/** "$6.00 more" — always the MARGINAL ask, never the threshold. */
function seedsToGo(moreNeeded: number): string {
	// ⚠️ A MONEY amount, since 2026-08-16 — it was a Seed count. Rendering it as a count
	// would be wrong in two directions at once now: there is no unit to count, and a
	// marginal ask of $2.50 has no whole-number form to round to that isn't a lie.
	return `$${moreNeeded.toFixed(2)} more`;
}

/**
 * The imperative: what to do, in the fewest words, about the gap the viewer is actually
 * facing. One Seed, named by where it goes — there is no second kind (see the Copy Style
 * Guide: "Seeds are just Seeds; it's a matter of who you give them to").
 */
export function unlockLabel(access: AccessResult, creatorName = "this creator"): string {
	if (access.reason === "login_required") return "Log in to unlock";
	if (access.reason === "payment_required" && access.price) return `Unlock for $${access.price}`;
	const cheapest = cheapestRoute(access, creatorName);
	if (!cheapest) return "Join to unlock";
	return `Unlock with ${seedsToGo(cheapest.route.moreNeeded)} to ${cheapest.target}`;
}

/**
 * What the post is locked BY, for the lock chip — the Badge sitting at the gate, when
 * one does. Null when the gate falls between Badges, which is legal and must not be
 * papered over by naming the nearest one.
 */
export function lockedByBadge(access: AccessResult, creatorName = "this creator"): string | null {
	const badge = cheapestRoute(access, creatorName)?.route.badge;
	if (!badge) return null;
	// `badgeLabel` only knows Anthers' own four. A creator names their Badges whatever
	// they like, so anything outside that set is already its display name — passing it
	// through the lookup would silently blank it.
	return ANTHERS_BADGE_KEYS.has(badge) ? badgeLabel(badge as BadgeKey) : badge;
}

const ANTHERS_BADGE_KEYS = new Set<string>(ANTHERS_BADGES.map((b) => b.name));

/**
 * Blurred cover with a Locked badge — the visual "this is gated" cue.
 *
 * The chip carries the *identity* of the gate (the Badge, when the gate sits on one);
 * the imperative — what to do about it — belongs to the copy underneath, so the two
 * don't compete. Falls back to a bare "Locked" when no Badge sits at the threshold.
 */
export function LockedCover({
	thumbnail,
	className = "",
	lockedBy,
}: {
	thumbnail?: string | null;
	className?: string;
	/** Badge label the gate sits on, if any — e.g. "Petal". */
	lockedBy?: string | null;
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
					<LockClosedIcon className="w-3.5 h-3.5" />
					{lockedBy ? `Locked · ${lockedBy}` : "Locked"}
				</span>
			</div>
		</div>
	);
}

/**
 * Reason-aware unlock panel for the post page (login / join-or-give-Seeds). The
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
	const cheapest = cheapestRoute(access, creatorName);
	// No message when there's a route — the CTA below already names the ask and its
	// destination, and repeating it in a sentence above makes the reader read it twice.
	// Kept only for the states nothing else explains.
	const message = isLogin
		? `Log in to check your access to this post from ${creatorName}.`
		: cheapest
			? null
			: `Give Seeds to ${creatorName} to unlock this post and their other members-only work.`;
	// Land on the tiers tab, where the ladder and the Give Seeds control actually are —
	// the profile's default tab drops the intent the viewer arrived with.
	const to = isLogin ? "/login" : creatorUsername ? `/${creatorUsername}?tab=badges` : "/subscribe";
	return (
		<div className="card bg-base-200 border border-base-300">
			<div className="card-body items-center text-center gap-3">
				<div className="w-12 h-12 rounded-full bg-base-300 flex items-center justify-center">
					<LockClosedIcon className="w-6 h-6 text-base-content/70" />
				</div>
				<h3 className="font-bold text-lg">
					{lockedByBadge(access, creatorName)
						? `Locked · ${lockedByBadge(access, creatorName)}`
						: "Unlock this post"}
				</h3>
				{message ? <p className="text-sm text-base-content/60 max-w-sm">{message}</p> : null}
				<Link to={to} className="btn btn-primary btn-wide">
					{unlockLabel(access, creatorName)}
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
		const cheapest = cheapestRoute(access, creatorName);
		body = (
			<>
				{cheapest ? null : (
					<p className="text-sm text-base-content/60">
						Give Seeds to {creatorName} to unlock this and their members-only work.
					</p>
				)}
				<Link
					to={post.creator?.username ? `/${post.creator.username}?tab=badges` : "/subscribe"}
					className="btn btn-primary btn-block"
				>
					{unlockLabel(access, creatorName)}
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
