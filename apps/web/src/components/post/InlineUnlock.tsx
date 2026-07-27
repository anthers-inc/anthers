// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Inline unlock for a gated post. Instead of bouncing the viewer to the creator's
 * Badges page, this offers the *exact minimum upgrade* that unlocks the post — the
 * lowest allowed Anthers threshold (subscribe inline, with the confirmation modal)
 * and/or the lowest Seed rung — right on the post.
 */
import { badgeLabel, rankForSeeds } from "@anthers/shared/constants";
import { rankViews } from "@anthers/shared/fees";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { AccessResult, Post } from "@anthers/web-shared/types";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../subscribe/SubscriptionPaymentModal";

/** "1 Seed" / "3 Seeds" — thresholds count Seeds, so the copy must too. */
function seedCount(seeds: number): string {
	return `${seeds} Seed${seeds === 1 ? "" : "s"}`;
}

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
		anthersSeeds: number;
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

	// The minimum unlock rungs: the lowest allowed threshold above "everyone" in each table.
	// Both tables are the same shape now, so this is the same reduction twice.
	const lowestAllowed = (rows: { threshold: number; allow: boolean }[] | null | undefined) =>
		(rows ?? [])
			.filter((r) => r.allow && r.threshold > 0)
			.sort((a, b) => a.threshold - b.threshold)[0]?.threshold;

	const minAnthersSeeds = lowestAllowed(post.anthersAccess);
	const minSeeds = lowestAllowed(post.seedAccess);
	// The Anthers rung may sit at a level no Badge is named for; label it by Seeds if so.
	const minBadge = minAnthersSeeds != null ? rankForSeeds(minAnthersSeeds) : undefined;
	const badgePrice =
		minAnthersSeeds != null
			? rankViews().find((p) => p.anthersSeeds === minAnthersSeeds)?.price
			: undefined;

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
				setError("Couldn't load plan details. Please try again.");
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setPending({
				anthersSeeds: minAnthersSeeds,
				planName: badgeLabel(minBadge ?? "free"),
				preview,
			});
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
					to={`/${creatorUsername}?tab=badges`}
					className={minBadge ? "btn btn-ghost btn-sm" : "btn btn-primary btn-wide"}
				>
					{minBadge ? `Or give ${seedCount(minSeeds)}` : `Give ${seedCount(minSeeds)} to unlock`}
				</Link>
			) : null}

			{!minBadge && minSeeds == null && creatorUsername ? (
				<Link to={`/${creatorUsername}?tab=badges`} className="btn btn-primary btn-wide">
					Join to unlock
				</Link>
			) : null}

			{error && <p className="text-error text-xs">{error}</p>}

			{pending && (
				<SubscriptionPaymentModal
					anthersSeeds={pending.anthersSeeds}
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
