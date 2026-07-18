// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inline unlock for a gated post. Instead of bouncing the viewer to the creator's
 * Tiers page, this offers the *exact minimum upgrade* that unlocks the post — the
 * lowest Badge tier (subscribe inline, with the confirmation modal) and/or the
 * lowest Seed rung — right on the post.
 */
import { type Badge, badgeLabel, badgeRank } from "@anthers/shared/constants";
import { badgePlanViews } from "@anthers/shared/fees";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult, Post } from "@anthers/web-shared/types";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../subscribe/SubscriptionPaymentModal";

export default function InlineUnlock({
	post,
	access,
	onUnlocked,
}: {
	post: Post;
	access: AccessResult;
	onUnlocked: () => void;
}) {
	const [pending, setPending] = useState<{
		badge: Badge;
		planName: string;
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

	// The minimum unlock rungs: lowest allowed Badge tier (above free) and lowest Seed rung.
	const minBadge = (post.anthersAccess ?? [])
		.filter((r) => r.allow && badgeRank(r.tier as Badge) > 0)
		.sort((a, b) => badgeRank(a.tier as Badge) - badgeRank(b.tier as Badge))[0]?.tier as
		| Badge
		| undefined;
	const minSeeds = (post.seedAccess ?? [])
		.filter((r) => r.allow && r.threshold > 0)
		.sort((a, b) => a.threshold - b.threshold)[0]?.threshold;
	const badgePrice = minBadge ? badgePlanViews().find((p) => p.id === minBadge)?.price : undefined;

	const unlockWithBadge = async () => {
		if (!minBadge) return;
		setLoading(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.preview[":badge"].$get({
				param: { badge: minBadge },
			});
			if (!res.ok) {
				setError("Couldn't load plan details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({ badge: minBadge, planName: badgeLabel(minBadge), preview });
		} catch {
			setError("Couldn't load plan details. Please try again.");
		} finally {
			setLoading(false);
		}
	};

	return (
		<UnlockCard
			blurb={`Subscribe or give Seeds to ${creatorName} to unlock this post and their other members-only work.`}
		>
			{minBadge ? (
				<button
					type="button"
					className="btn btn-primary btn-wide"
					onClick={unlockWithBadge}
					disabled={loading}
				>
					{loading
						? "Loading…"
						: `Unlock with ${badgeLabel(minBadge)}${badgePrice ? ` · $${badgePrice}/mo` : ""}`}
				</button>
			) : null}

			{minSeeds != null && creatorUsername ? (
				<Link
					to={`/${creatorUsername}?tab=tiers`}
					className={minBadge ? "btn btn-ghost btn-sm" : "btn btn-primary btn-wide"}
				>
					{minBadge ? `Or give $${minSeeds} in Seeds` : `Give $${minSeeds} in Seeds to unlock`}
				</Link>
			) : null}

			{!minBadge && minSeeds == null && creatorUsername ? (
				<Link to={`/${creatorUsername}?tab=tiers`} className="btn btn-primary btn-wide">
					Join to unlock
				</Link>
			) : null}

			{error && <p className="text-error text-xs">{error}</p>}

			{pending && (
				<SubscriptionPaymentModal
					badge={pending.badge}
					planName={pending.planName}
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

function UnlockCard({ blurb, children }: { blurb: string; children: React.ReactNode }) {
	return (
		<div className="card bg-base-200 border border-base-300">
			<div className="card-body items-center text-center gap-3">
				<div className="w-12 h-12 rounded-full bg-base-300 flex items-center justify-center">
					<LockClosedIcon className="w-6 h-6 text-base-content/70" />
				</div>
				<h3 className="font-bold text-lg">Unlock this post</h3>
				<p className="text-sm text-base-content/60 max-w-sm">{blurb}</p>
				{children}
			</div>
		</div>
	);
}
