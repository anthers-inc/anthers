// SPDX-License-Identifier: Apache-2.0
/**
 * The collaboration invitations and publisher requests waiting on this account.
 *
 * A Badge invitation is intentionally quiet until it is answered: the Badge stays with its
 * current owners, and the invited creator sees it here rather than on their public profile.
 * Accepting adds the second view; declining leaves the Badge where it was. A publisher
 * request is the same shape — the target has to agree before the billing and art home moves.
 */

import { amountLabel } from "@anthers/shared/constants";
import { CreatorBadgeMark } from "@anthers/web-shared/economics/CreatorBadgeMark";
import { apiBaseUrl } from "@anthers/web-shared/rpc";
import type { CreatorBadge } from "@anthers/web-shared/types";
import { useCallback, useEffect, useState } from "react";

interface Invite {
	id: number;
	createdAt: string;
	badge: CreatorBadge;
	inviter: { handle: string; displayName: string | null };
}

interface Handover {
	id: number;
	createdAt: string;
	badge: CreatorBadge;
	from: { handle: string; displayName: string | null };
}

interface CollaborationsResponse {
	invites: Invite[];
	handovers: Handover[];
}

export default function CollaborationInvites({
	onChanged,
}: {
	/** Refetch the account's holdings after an acceptance. */
	onChanged?: () => void | Promise<void>;
}) {
	const [data, setData] = useState<CollaborationsResponse | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await fetch(`${apiBaseUrl()}/api/subscriptions/collaborations`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Couldn't read your collaboration invitations.");
		setData((await res.json()) as CollaborationsResponse);
	}, []);

	useEffect(() => {
		let live = true;
		void load().catch((err: unknown) => {
			if (live) setError(err instanceof Error ? err.message : "Couldn't read your invitations.");
		});
		return () => {
			live = false;
		};
	}, [load]);

	const act = async (key: string, url: string, method: "POST") => {
		setBusy(key);
		setError(null);
		try {
			const res = await fetch(url, { method, credentials: "include" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't answer the invitation.");
			}
			await load();
			await onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't answer the invitation.");
		} finally {
			setBusy(null);
		}
	};

	if (!data) return null;
	if (data.invites.length === 0 && data.handovers.length === 0) return null;

	const badgeMark = (badge: CreatorBadge) => (
		<CreatorBadgeMark
			badgeId={badge.id}
			index={badge.sortOrder}
			label={`${badge.label} badge`}
			art={badge}
			owners={badge.owners}
			size="h-12 w-12"
		/>
	);

	const ownerNames = (badge: CreatorBadge) =>
		(badge.owners ?? []).map((owner) => owner.displayName || `@${owner.handle}`).join(", ");

	return (
		<section className="card bg-base-200/60 shadow-xl p-5 mb-6" aria-labelledby="collab-invites">
			<h3 id="collab-invites" className="text-lg font-bold">
				Collaborations
			</h3>
			<p className="mb-3 text-sm text-base-content/60">
				Invitations to co-own a Badge, and requests to take its publisher role.
			</p>
			{error && <p className="mb-3 text-sm text-error">{error}</p>}
			<div className="space-y-3">
				{data.invites.map((invite) => (
					<div
						key={`invite-${invite.id}`}
						className="flex flex-wrap items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3"
					>
						{badgeMark(invite.badge)}
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold">
								{invite.inviter.displayName || `@${invite.inviter.handle}`} invited you to co-own{" "}
								{invite.badge.label}
							</p>
							<p className="text-xs text-base-content/50">
								{amountLabel(invite.badge.threshold)}/mo · owned by {ownerNames(invite.badge)}
							</p>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								className="btn btn-primary btn-sm"
								disabled={busy !== null}
								onClick={() =>
									void act(
										`accept-${invite.badge.id}`,
										`${apiBaseUrl()}/api/subscriptions/badges/${invite.badge.id}/collaborators/accept`,
										"POST",
									)
								}
							>
								Accept
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								disabled={busy !== null}
								onClick={() =>
									void act(
										`decline-${invite.badge.id}`,
										`${apiBaseUrl()}/api/subscriptions/badges/${invite.badge.id}/collaborators/decline`,
										"POST",
									)
								}
							>
								Decline
							</button>
						</div>
					</div>
				))}
				{data.handovers.map((handover) => (
					<div
						key={`handover-${handover.id}`}
						className="flex flex-wrap items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3"
					>
						{badgeMark(handover.badge)}
						<div className="min-w-0 flex-1">
							<p className="text-sm font-semibold">
								{handover.from.displayName || `@${handover.from.handle}`} wants to make you the
								publisher of {handover.badge.label}
							</p>
							<p className="text-xs text-base-content/50">
								The publisher holds the billing and art home. Ownership, editing and the split do
								not change.
							</p>
						</div>
						<div className="flex gap-2">
							<button
								type="button"
								className="btn btn-primary btn-sm"
								disabled={busy !== null}
								onClick={() =>
									void act(
										`publisher-accept-${handover.badge.id}`,
										`${apiBaseUrl()}/api/subscriptions/badges/${handover.badge.id}/publisher/accept`,
										"POST",
									)
								}
							>
								Accept publisher
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-sm"
								disabled={busy !== null}
								onClick={() =>
									void act(
										`publisher-decline-${handover.badge.id}`,
										`${apiBaseUrl()}/api/subscriptions/badges/${handover.badge.id}/publisher/decline`,
										"POST",
									)
								}
							>
								Decline
							</button>
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
