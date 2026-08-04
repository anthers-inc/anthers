// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inline unlock for a gated **Work**. Instead of bouncing the viewer to the creator's
 * Badges page, this offers the *exact minimum upgrade* that unlocks it — the lowest
 * allowed Anthers threshold (subscribe inline, with the confirmation modal) and/or the
 * lowest Seed rung — right where the viewer hit the gate.
 */
import { type BadgeKey, badgeLabel } from "@anthers/shared/constants";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult } from "@anthers/web-shared/types";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../subscribe/SubscriptionPaymentModal";

/** "1 Seed" / "3 Seeds" — thresholds count Seeds, so the copy must too. */
function seedCount(seeds: number): string {
	return `${seeds} Seed${seeds === 1 ? "" : "s"}`;
}

/** The MARGINAL ask — what the viewer still has to add, not what the gate requires. */
function seedsToGo(moreNeeded: number): string {
	return `${moreNeeded} more Seed${moreNeeded === 1 ? "" : "s"}`;
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
		anthersSeeds: number;
		badgeName: string;
		preview: SubscriptionPreview;
	} | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const creatorName = post.creator?.displayName || post.creator?.username || "this creator";
	const creatorUsername = post.creator?.username;

	// Not logged in → send them to log in and return to the post.
	if (access.reason === "login_required") {
		return (
			<UnlockCard blurb={`Log in to check your access to this post from ${creatorName}.`}>
				<Link to="/login" className="btn btn-primary btn-wide">
					Log in to unlock
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
	const minAnthersSeeds = anthersRoute?.threshold;

	const unlockWithBadge = async () => {
		if (minAnthersSeeds == null) return;
		setLoading(true);
		setError(null);
		try {
			// The gate's own threshold, not the Badge's — buying up to the named Badge could
			// overshoot, and buying the Badge below would not clear the gate at all.
			const res = await client.api.subscriptions.preview[":seeds"].$get({
				param: { seeds: String(minAnthersSeeds) },
			});
			if (!res.ok) {
				setError("Couldn't load the details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({
				anthersSeeds: minAnthersSeeds,
				// Name the Badge only when the gate actually sits on one; otherwise the
				// level itself is the honest label for what's being bought.
				badgeName: anthersRoute?.badge
					? badgeLabel(anthersRoute.badge as BadgeKey)
					: `${minAnthersSeeds} Seed${minAnthersSeeds === 1 ? "" : "s"}`,
				preview,
			});
		} catch {
			setError("Couldn't load the details. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	// Whichever side asks for less is the primary action; a tie goes to the creator, since
	// Anthers takes no cut of a Seed given to a creator.
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
					? `Give Seeds to ${creatorName} to unlock this post and their other members-only work.`
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
					anthersSeeds={pending.anthersSeeds}
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
