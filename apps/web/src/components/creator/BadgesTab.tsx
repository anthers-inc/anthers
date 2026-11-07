// SPDX-License-Identifier: Apache-2.0
/**
 * A creator's **Badges tab** — one ladder, read the same way by the creator and by a
 * visitor, as a grid of tall cards.
 *
 * ⭐ **The creator meets what the supporter meets** (Parker, 2026-10-23), the rule the
 * profile's own fields and the Work page already follow. The card carries the mark, the
 * Badge's name, its monthly amount, and the words the creator wrote about it; being the
 * creator adds one thing — the pencil that opens the Badge Maker for that card — and
 * nothing else changes shape.
 *
 * ⭐ **Buying is direct, one button per card** (Parker, 2026-11-06). There is no selection
 * step and no basket pair: a card above the rung the reader holds says **Upgrade**, one
 * below says **Downgrade**, and the rung they hold says **Cancel**. A reader with no Badge
 * sees Upgrade on every card. The action opens the one subscription-change modal, which
 * prorates a raise and holds a decrease until the first of the month; the first Badge on an
 * account with no subscription takes a card and address there like any first subscription.
 *
 * ⭐ **The cards read cheapest first** (Parker, 2026-11-06), and the rung held wears its
 * outline around the card's edge with **Current Badge** above it, so the mark never pushes
 * the contents it surrounds.
 */

import { currentCycleKey, cycleEnd } from "@anthers/shared/billing-cycle";
import { amountLabel, supportAmount } from "@anthers/shared/constants";
import { withNextPath } from "@anthers/shared/next-path";
import { CreatorBadgeMark } from "@anthers/web-shared/economics/CreatorBadgeMark";
import { useLocation, useNavigate } from "@anthers/web-shared/router";
import { apiBaseUrl, client } from "@anthers/web-shared/rpc";
import type {
	AccountResponse,
	BadgeHoldingsResponse,
	CreatorBadge,
} from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import {
	ArrowDownIcon,
	BoltIcon,
	PencilSquareIcon,
	PlusCircleIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { currentRungId } from "../../lib/badge-ladder";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../subscribe/SubscriptionPaymentModal";

/** Which way one card moves the reader's support. */
type BadgeAction = "upgrade" | "downgrade" | "cancel";

/** What the one subscription-change modal needs, built from the account and this ladder. */
interface CheckoutState {
	anthersSupport: number;
	directed: { creatorId: number; amount: number }[];
	badgeName: string;
	preview: SubscriptionPreview;
}

/**
 * One tall Badge card.
 *
 * The mark, the name and the amount sit on one centered line; the description is fenced
 * by a soft rule above and below; the artist credit is the emblem's hover, not a line
 * competing with the creator's own words. The footer is the card's one action.
 */
function BadgeCard({
	rung,
	index,
	current,
	held,
	busy,
	onAction,
	onEdit,
}: {
	rung: CreatorBadge;
	/** The rung's display position, for the fallback mark. */
	index: number;
	/** Whether this is the rung the reader's monthly amount currently holds. */
	current: boolean;
	/** What the reader gives this creator each month, for the direction. */
	held: number;
	busy: boolean;
	onAction?: (action: BadgeAction) => void;
	/** The creator's page only — the pencil that opens the Badge Maker. */
	onEdit?: () => void;
}) {
	const target = Number(rung.threshold);
	const action: BadgeAction = current
		? "cancel"
		: held === 0 || target > held
			? "upgrade"
			: "downgrade";

	return (
		<article
			className={`relative flex h-full flex-col rounded-2xl border bg-base-200 p-4 ${
				current ? "border-success/60" : "border-base-content/10"
			}`}
		>
			{current && (
				<>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute -inset-1.5 rounded-[1.15rem] ring-2 ring-success/40"
					/>
					<span className="absolute -top-3 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-success px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-success-content shadow">
						Current Badge
					</span>
				</>
			)}

			<div className="flex items-center gap-4">
				<div className="group/emblem relative shrink-0">
					<CreatorBadgeMark
						badgeId={rung.id}
						index={index}
						label={`${rung.label} badge`}
						art={rung}
						size="h-16 w-16"
					/>
					{/* The artist credit the supporter reads on the Badge's back, now on the
					    emblem's hover rather than in the card's own column. Every emblem has a
					    named human behind it, and naming them is the promise made when the
					    library was taken on. */}
					{rung.artistCredit && (
						<div className="pointer-events-none absolute left-0 top-full z-20 mt-2 hidden w-56 rounded-lg border border-base-300 bg-base-100 p-2 text-xs leading-relaxed text-base-content/60 shadow-lg group-hover/emblem:block">
							Emblem by{" "}
							{rung.artistCredit.artistPermalink ? (
								<a
									href={rung.artistCredit.artistPermalink}
									target="_blank"
									rel="noopener noreferrer"
									className="underline decoration-dotted underline-offset-2"
								>
									{rung.artistCredit.artistName}
								</a>
							) : (
								rung.artistCredit.artistName
							)}{" "}
							· Noun Project
						</div>
					)}
				</div>
				<div className="min-w-0 flex-1">
					<h4 className="text-xl font-bold leading-tight">{rung.label}</h4>
					<p className="mt-1 text-2xl font-semibold leading-none">
						{amountLabel(rung.threshold)}
						<span className="ml-0.5 text-sm font-normal text-base-content/50">/mo</span>
					</p>
				</div>
				{onEdit && (
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square -mr-1 -mt-1 self-start text-base-content/40 hover:text-base-content/80"
						onClick={onEdit}
						aria-label={`Edit ${rung.label}`}
						title={`Edit ${rung.label}`}
					>
						<PencilSquareIcon className="w-4 h-4" />
					</button>
				)}
			</div>

			{rung.description && (
				<p className="my-4 whitespace-pre-line border-y border-base-300/60 py-3 text-sm text-base-content/60">
					{rung.description}
				</p>
			)}

			<div className="mt-auto pt-1">
				{onEdit ? (
					!rung.hasArt && (
						// The fallback is a start, not a design to settle for — said where the
						// creator is scanning their own ladder. The card already draws an emblem,
						// so the line names whose design it is.
						<p className="text-xs text-base-content/40">Anthers' design — make it yours</p>
					)
				) : onAction ? (
					action === "cancel" ? (
						<button
							type="button"
							className="btn btn-error btn-outline btn-sm w-full"
							disabled={busy}
							onClick={() => onAction("cancel")}
						>
							{busy ? "Opening…" : "Cancel"}
						</button>
					) : action === "downgrade" ? (
						<button
							type="button"
							className="btn btn-outline btn-sm w-full"
							disabled={busy}
							onClick={() => onAction("downgrade")}
						>
							<ArrowDownIcon className="size-4" />
							{busy ? "Opening…" : "Downgrade"}
						</button>
					) : (
						<button
							type="button"
							className="btn btn-primary btn-sm w-full"
							disabled={busy}
							onClick={() => onAction("upgrade")}
						>
							<BoltIcon className="size-4" />
							{busy ? "Opening…" : "Upgrade"}
						</button>
					)
				) : null}
			</div>
		</article>
	);
}

/** The creator's own trailing card — the same dialog the pencils open, empty. */
function AddBadgeCard({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="flex h-full min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-base-content/20 bg-base-200/40 p-4 text-center transition-colors hover:border-primary/50"
		>
			<PlusCircleIcon className="w-8 h-8 text-base-content/30" />
			<span className="mt-1 font-medium">Add a Badge</span>
			<span className="text-xs text-base-content/50">Give supporters a level to give at.</span>
		</button>
	);
}

export default function BadgesTab({
	rungs,
	unlockedBadges,
	heldAmount,
	creatorName,
	canBuy,
	authenticated,
	isOwner,
	onEdit,
	onAdd,
}: {
	rungs: CreatorBadge[];
	unlockedBadges: number[];
	heldAmount: string;
	creatorName: string;
	/** Looking at somebody else's profile — you can't buy your own ladder. */
	canBuy: boolean;
	authenticated: boolean;
	/** The creator's own page, where each card carries its pencil. */
	isOwner: boolean;
	onEdit: (badge: CreatorBadge) => void;
	onAdd: () => void;
}) {
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const [checkout, setCheckout] = useState<CheckoutState | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	const held = supportAmount(heldAmount);
	const currentId = currentRungId(rungs, unlockedBadges);
	// Cheapest first (Parker, 2026-11-06): the display order is the price order, and the
	// ladder's stored order stays the creator's own arrangement on their side.
	const ladder = [...rungs].sort((a, b) => Number(a.threshold) - Number(b.threshold));

	/**
	 * Every directed amount this account already carries, as the subscription route needs
	 * it. `my-badges` is the in-force truth for the cycle; the ladder read supplies the
	 * creator id each holding's handle names. A Badge is the only directed support the app
	 * sells, so the holdings are the whole set.
	 */
	const loadDirected = async (): Promise<{ creatorId: number; amount: number }[]> => {
		const res = await fetch(`${apiBaseUrl()}/api/subscriptions/my-badges`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Couldn't read your current Badges.");
		const holdings = (await res.json()) as BadgeHoldingsResponse;
		const byCreator = new Map<number, number>();
		for (const holding of holdings.badges) {
			const ladderRes = await fetch(
				`${apiBaseUrl()}/api/subscriptions/badges?creator=${encodeURIComponent(holding.creator.handle)}`,
			);
			if (!ladderRes.ok) continue;
			const { badges } = (await ladderRes.json()) as { badges: CreatorBadge[] };
			const creatorId =
				badges.find((badge) => badge.id === holding.id)?.creatorId ?? badges[0]?.creatorId;
			if (creatorId == null) continue;
			byCreator.set(creatorId, Math.max(byCreator.get(creatorId) ?? 0, Number(holding.threshold)));
		}
		return [...byCreator].map(([creatorId, amount]) => ({ creatorId, amount }));
	};

	const act = async (rung: CreatorBadge, action: BadgeAction) => {
		if (!authenticated) {
			navigate(withNextPath("/login", pathname));
			return;
		}
		setBusyId(rung.id);
		setError(null);
		try {
			const meRes = await client.api.subscriptions.me.$get();
			if (!meRes.ok) throw new Error("Couldn't read your account.");
			const me = (await meRes.json()) as AccountResponse;
			const directed = await loadDirected();
			const nextDirected = directed.filter((item) => item.creatorId !== rung.creatorId);
			if (action !== "cancel") {
				nextDirected.push({ creatorId: rung.creatorId, amount: Number(rung.threshold) });
			}
			const recurring =
				me.anthersSupport + nextDirected.reduce((sum, item) => sum + item.amount, 0);
			const target = Number(rung.threshold);
			// A raise is charged today in full — the delta when a rung is held, the whole
			// first month when none is. A decrease or a cancellation waits for the 1st.
			const chargeNow = action === "upgrade" ? Math.max(0, target - held) : 0;
			const nextBillingUnix = me.account.currentPeriodEnd
				? Math.floor(new Date(me.account.currentPeriodEnd).getTime() / 1000)
				: Math.floor(cycleEnd(currentCycleKey()).getTime() / 1000);
			setCheckout({
				anthersSupport: me.anthersSupport,
				directed: nextDirected,
				badgeName: action === "cancel" ? `no Badge from ${creatorName}` : rung.label,
				preview: {
					isChange: Boolean(me.account.stripeSubscriptionId),
					recurring: { amount: recurring.toFixed(2), interval: "month" },
					chargeNow: chargeNow.toFixed(2),
					nextBillingUnix,
					savedCard: me.savedCard ?? null,
				},
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't open the change.");
		} finally {
			setBusyId(null);
		}
	};

	// A visitor on a ladder with nothing on it gets the sentence; the owner gets the add
	// card, which is the invitation and the empty state in one.
	if (rungs.length === 0 && !isOwner) {
		return (
			<EmptyState
				title="No Badges configured"
				description={`${creatorName} hasn't set up any Badges yet. All content is publicly available.`}
			/>
		);
	}

	return (
		<div className="space-y-6">
			<div>
				<div className="mb-3 flex flex-wrap items-end justify-between gap-2">
					<div>
						<h3 className="text-lg font-bold">Badges</h3>
						<p className="text-sm text-base-content/50">
							{isOwner
								? "The monthly levels supporters can give at. Each one clears the Work gates at or below its amount."
								: `Badges set by ${creatorName}. Choose a level — it renews monthly until you cancel.`}
						</p>
					</div>
				</div>

				{error && <p className="mb-3 text-sm text-error">{error}</p>}

				{/* The same uniform grid every listing surface uses, with room around the
				    cards for the current outline and its label to sit OUTSIDE the card. */}
				<div
					className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-x-4 gap-y-8 px-1.5 py-2"
					data-testid="badge-grid"
				>
					{ladder.map((rung, index) => (
						<BadgeCard
							key={rung.id}
							rung={rung}
							index={index}
							current={!isOwner && rung.id === currentId}
							held={isOwner ? 0 : held}
							busy={busyId === rung.id}
							onAction={canBuy ? (action) => void act(rung, action) : undefined}
							onEdit={isOwner ? () => onEdit(rung) : undefined}
						/>
					))}
					{isOwner && <AddBadgeCard onClick={onAdd} />}
				</div>
			</div>

			{checkout && (
				<SubscriptionPaymentModal
					open
					anthersSupport={checkout.anthersSupport}
					directed={checkout.directed}
					badgeName={checkout.badgeName}
					preview={checkout.preview}
					onComplete={() => {
						setCheckout(null);
						navigate("/settings?tab=badges");
					}}
					onClose={() => setCheckout(null)}
				/>
			)}
		</div>
	);
}
