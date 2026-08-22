// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inline unlock for a gated **Work**. Instead of bouncing the viewer to the creator's
 * Badges page, this offers the *exact minimum upgrade* that unlocks it — the lowest
 * allowed Anthers threshold (subscribe inline, with the confirmation modal) and/or the
 * lowest Badge rung — right where the viewer hit the gate.
 */
import { amountLabel, type BadgeKey, badgeLabel } from "@anthers/shared/constants";
import { withNextPath } from "@anthers/shared/next-path";
import { Link, useLocation } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult } from "@anthers/web-shared/types";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../subscribe/SubscriptionPaymentModal";

/** The MARGINAL ask — what the viewer still has to add, not what the gate requires. */
function seedsToGo(moreNeeded: number): string {
	// ⚠️ A MONEY amount, since 2026-08-16 — it was a Seed count. Rendering it as a count
	// would be wrong in two directions at once now: there is no unit to count, and a
	// marginal ask of $2.50 has no whole-number form to round to that isn't a lie.
	return `$${moreNeeded.toFixed(2)} more`;
}

/** Only the creator identity is needed — this works for any gated thing. */
interface UnlockSubject {
	creator?: { username: string; displayName?: string | null } | null;
}

export default function InlineUnlock({
	post,
	access,
	onUnlocked,
}: {
	post: UnlockSubject;
	access: AccessResult;
	onUnlocked: () => void;
}) {
	const [pending, setPending] = useState<{
		anthersSupport: number;
		badgeName: string;
		preview: SubscriptionPreview;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const location = useLocation();

	const creatorName = post.creator?.displayName || post.creator?.username || "this creator";
	const creatorUsername = post.creator?.username;

	/*
	 * Not logged in → both doors, and both of them come back here.
	 *
	 * 🚨 This offered **only "Log in"**, and it did not return anyone anywhere: no `?next=`,
	 * no router state. So a visitor with no account had nothing to click at all, and one
	 * with an account was signed in and dropped on their feed, having lost the Work they
	 * were looking at. The comment above this block said "return to the post" and had said
	 * so since it was written — the behaviour was never there.
	 *
	 * ⚠️ It is easy to think this was collateral from deleting the Create Account card on
	 * 2026-08-17. It wasn't. The component that carried a return was `UnlockModal` in
	 * `web-shared/post/unlock.tsx` — which **nothing rendered**, and which was deleted the
	 * same day for that reason. This is the live gated-Work surface (`WorkPage`), and it
	 * never had one. The transferable half: reading a file tells you what a component would
	 * do, not whether anything renders it.
	 *
	 * `?next=` rather than router state, because it has to survive the whole signup detour
	 * — `/subscribe` → an emailed code → a possible payment modal → `/welcome` — and a
	 * reload in the middle of it, which is a normal thing to do while checking your email.
	 * Sanitized at every read; see `shared/next-path.ts`.
	 */
	if (access.reason === "login_required") {
		const back = `${location.pathname}${location.search}`;
		return (
			<UnlockCard blurb={`Log in to check your access to this Work from ${creatorName}.`}>
				<Link to={withNextPath("/login", back)} className="btn btn-primary btn-wide">
					Log in to unlock
				</Link>
				<Link to={withNextPath("/subscribe", back)} className="btn btn-ghost btn-sm">
					Create an account
				</Link>
			</UnlockCard>
		);
	}

	// The unlock routes come from the RESOLVER, which owns the thresholds — the client no
	// longer derives them. It used to, and got the label wrong: it named the highest Badge
	// at-or-below the gate, which by definition does not clear a gate sitting above it, and
	// silently dropped the price whenever the gate fell between Badges. `badge` here is the
	// Badge sitting EXACTLY at the threshold, or null when none does.
	const anthersRoute = access.unlock?.anthers ?? null;
	const creatorRoute = access.unlock?.creator ?? null;
	const minAnthersAmount = anthersRoute?.threshold;

	const unlockWithBadge = async () => {
		if (minAnthersAmount == null) return;
		setLoading(true);
		setError(null);
		try {
			// The gate's own threshold, not the Badge's — buying up to the named Badge could
			// overshoot, and buying the Badge below would not clear the gate at all.
			const res = await client.api.subscriptions.preview[":amount"].$get({
				param: { amount: String(minAnthersAmount) },
			});
			if (!res.ok) {
				setError("Couldn't load the details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({
				anthersSupport: minAnthersAmount,
				// Name the Badge only when the gate actually sits on one; otherwise the
				// level itself is the honest label for what's being bought.
				badgeName: anthersRoute?.badge
					? badgeLabel(anthersRoute.badge as BadgeKey)
					: `${amountLabel(minAnthersAmount)} a month`,
				preview,
			});
		} catch {
			setError("Couldn't load the details. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	// Whichever side asks for less is the primary action; a tie goes to the creator, since
	// Anthers takes no cut of what a viewer gives a creator.
	const anthersFirst =
		!!anthersRoute && (!creatorRoute || anthersRoute.moreNeeded < creatorRoute.moreNeeded);
	const lockedBy = anthersFirst && anthersRoute?.badge ? badgeLabel(anthersRoute.badge) : null;

	return (
		<UnlockCard
			lockedBy={lockedBy}
			// No blurb when there's a route: the button already says what to do and to whom,
			// and a sentence restating it just makes the reader parse the same fact twice.
			// The blurb survives only where nothing else explains the situation.
			blurb={
				!anthersRoute && !creatorRoute
					? `Support ${creatorName} monthly to unlock this post and their other members-only work.`
					: undefined
			}
		>
			{anthersRoute ? (
				<button
					type="button"
					className={anthersFirst ? "btn btn-primary btn-wide" : "btn btn-ghost btn-sm"}
					onClick={unlockWithBadge}
					disabled={loading}
				>
					{loading
						? "Loading…"
						: `${anthersFirst ? "Unlock" : "Or unlock"} with ${seedsToGo(anthersRoute.moreNeeded)} to Anthers`}
				</button>
			) : null}

			{creatorRoute && creatorUsername ? (
				<Link
					to={`/${creatorUsername}?tab=badges`}
					className={anthersFirst ? "btn btn-ghost btn-sm" : "btn btn-primary btn-wide"}
				>
					{`${anthersFirst ? "Or unlock" : "Unlock"} with ${seedsToGo(creatorRoute.moreNeeded)} to ${creatorName}`}
				</Link>
			) : null}

			{!anthersRoute && !creatorRoute && creatorUsername ? (
				<Link to={`/${creatorUsername}?tab=badges`} className="btn btn-primary btn-wide">
					Join to unlock
				</Link>
			) : null}

			{error && <p className="text-error text-xs">{error}</p>}

			{pending && (
				<SubscriptionPaymentModal
					anthersSupport={pending.anthersSupport}
					badgeName={pending.badgeName}
					preview={pending.preview}
					onComplete={() => {
						setPending(null);
						onUnlocked();
					}}
					onClose={() => setPending(null)}
				/>
			)}
		</UnlockCard>
	);
}

function UnlockCard({
	blurb,
	lockedBy,
	children,
}: {
	/** Only for states the action itself doesn't explain (login, or no route at all). */
	blurb?: string;
	/** Badge the gate sits on, when it sits on one — the lock's *identity*. */
	lockedBy?: string | null;
	children: React.ReactNode;
}) {
	return (
		<div className="card bg-base-200 border border-base-300">
			<div className="card-body items-center text-center gap-3">
				<div className="w-12 h-12 rounded-full bg-base-300 flex items-center justify-center">
					<LockClosedIcon className="w-6 h-6 text-base-content/70" />
				</div>
				<h3 className="font-bold text-lg">
					{lockedBy ? `Locked · ${lockedBy}` : "Unlock this post"}
				</h3>
				{blurb ? <p className="text-sm text-base-content/60 max-w-sm">{blurb}</p> : null}
				{children}
			</div>
		</div>
	);
}
