// SPDX-License-Identifier: Apache-2.0
/**
 * A creator's **Badges tab** — one ladder, read the same way by the creator and by a
 * visitor, as a grid of tall cards.
 *
 * ⭐ **The creator meets what the supporter meets** (Parker, 2026-10-23), the rule the
 * profile's own fields and the Work page already follow. The card carries the mark, the
 * Badge's name, its monthly amount, and the words the creator wrote about it; being the
 * creator adds one thing — the pencil that opens the Badge Maker for that card — and
 * nothing else changes shape. The old second list of the same rungs, always open above the
 * ladder, is gone with this: a Badge is edited one at a time, in a dialog.
 *
 * ⭐ **Two highlights, and they mean different things.** The rung the viewer's monthly
 * amount currently reaches wears "Your Badge" — the highest rung their giving covers, not
 * every rung beneath it, which is why the rest of the covered rungs read "Included". The
 * rung they have picked to buy wears "Selected" until the pick is added or abandoned.
 *
 * 🚨 **The ladder is a purchase surface on every creator's page, Anthers' own included**
 * — one flow, one basket: a pick adds the line to the basket, and Buy Now is the same add
 * plus the trip to the one checkout. The server prices the pick (the full threshold, or an
 * upgrade's delta); this surface never decides a gate.
 */

import { amountLabel, supportAmount } from "@anthers/shared/constants";
import { withNextPath } from "@anthers/shared/next-path";
import { CreatorBadgeMark } from "@anthers/web-shared/economics/CreatorBadgeMark";
import { Link, useLocation, useNavigate } from "@anthers/web-shared/router";
import type { CreatorBadge } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import {
	BoltIcon,
	CheckCircleIcon,
	PencilSquareIcon,
	PlusCircleIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { currentRungId } from "../../lib/badge-ladder";
import { useBasket } from "../../lib/basket";

/** What a card is for the person looking at it. */
type CardState = "current" | "selected" | "included" | "selectable" | "locked";

/**
 * One tall Badge card.
 *
 * The mark sits beside the name and the amount at the top, and everything the creator
 * wrote about the rung — its description, the artist behind its emblem — reads below. The
 * footer holds the card's one action: select it, say it is already in the basket, or, on
 * the creator's own page, invite them to give an artless rung its own emblem.
 */
function BadgeCard({
	rung,
	index,
	state,
	inBasket,
	onPick,
	onEdit,
}: {
	rung: CreatorBadge;
	/** The rung's position on the ladder, for a fallback mark. */
	index: number;
	state: CardState;
	inBasket: boolean;
	onPick: () => void;
	/** The creator's page only — the pencil that opens the Badge Maker. */
	onEdit?: () => void;
}) {
	const ribbon =
		state === "current"
			? { label: "Your Badge", className: "bg-success/15 text-success" }
			: state === "selected"
				? { label: "Selected", className: "bg-primary text-primary-content" }
				: null;

	return (
		<article
			className={`card h-full overflow-hidden border bg-base-200 ${
				state === "current"
					? "border-success ring-2 ring-success/40"
					: state === "selected"
						? "border-primary ring-2 ring-primary/50"
						: "border-base-content/10"
			}`}
		>
			{ribbon && (
				<div
					className={`px-3 py-1 text-center text-[11px] font-semibold uppercase tracking-wide ${ribbon.className}`}
				>
					{ribbon.label}
				</div>
			)}
			<div className="card-body gap-3 p-4">
				<div className="flex items-start gap-3">
					<CreatorBadgeMark
						badgeId={rung.id}
						index={index}
						label={`${rung.label} badge`}
						art={rung}
						size="h-14 w-14"
					/>
					<div className="min-w-0 flex-1">
						<h4 className="truncate font-semibold leading-tight">{rung.label}</h4>
						<p className="text-sm text-base-content/60">
							{amountLabel(rung.threshold)}
							<span className="text-xs">/mo</span>
						</p>
					</div>
					{onEdit && (
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-square -mr-1 -mt-1 text-base-content/40 hover:text-base-content/80"
							onClick={onEdit}
							aria-label={`Edit ${rung.label}`}
							title={`Edit ${rung.label}`}
						>
							<PencilSquareIcon className="w-4 h-4" />
						</button>
					)}
				</div>

				{rung.description && (
					<p className="whitespace-pre-line text-sm text-base-content/60">{rung.description}</p>
				)}

				{/* 🚨 THE FLIP — the artist credit a supporter reads on a Badge's back. Every
				    emblem has a named human behind it, and naming them here is the promise made
				    when the library was taken on. It covers uploaded art's credit too when the
				    creator names one. */}
				{rung.artistCredit && (
					<p className="text-xs text-base-content/40">
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
					</p>
				)}

				<div className="mt-auto pt-1">
					{onEdit ? (
						!rung.hasArt && (
							// The fallback is a start, not a design to settle for — said where the
							// creator is scanning their own ladder.
							<p className="text-xs text-base-content/40">Give it your own emblem</p>
						)
					) : state === "included" ? (
						<p className="inline-flex items-center gap-1 text-sm text-base-content/50">
							<CheckCircleIcon className="w-4 h-4" />
							Included in your Badge
						</p>
					) : inBasket ? (
						<button type="button" className="btn btn-sm btn-outline w-full" disabled>
							In your basket
						</button>
					) : state === "selectable" || state === "selected" ? (
						<button
							type="button"
							className={`btn btn-sm w-full ${state === "selected" ? "btn-primary" : "btn-outline"}`}
							onClick={onPick}
							aria-pressed={state === "selected"}
						>
							{state === "selected" ? "Selected" : "Select"}
						</button>
					) : null}
				</div>
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
			className="card h-full min-h-56 items-center justify-center border border-dashed border-base-content/20 bg-base-200/40 text-center transition-colors hover:border-primary/50"
		>
			<div className="card-body items-center justify-center gap-1 p-4">
				<PlusCircleIcon className="w-8 h-8 text-base-content/30" />
				<span className="font-medium">Add a Badge</span>
				<span className="text-xs text-base-content/50">Give supporters a level to give at.</span>
			</div>
		</button>
	);
}

export default function BadgesTab({
	rungs,
	unlockedBadges,
	heldAmount,
	creatorName,
	creatorHandle,
	canBuy,
	authenticated,
	preselectedBadgeId,
	isOwner,
	onEdit,
	onAdd,
}: {
	rungs: CreatorBadge[];
	unlockedBadges: number[];
	heldAmount: string;
	creatorName: string;
	creatorHandle: string;
	/** Looking at somebody else's profile — you can't buy your own ladder. */
	canBuy: boolean;
	authenticated: boolean;
	/** A pick carried back across the sign-in detour, as `?badge=`. */
	preselectedBadgeId: number | null;
	/** The creator's own page, where each card carries its pencil. */
	isOwner: boolean;
	onEdit: (badge: CreatorBadge) => void;
	onAdd: () => void;
}) {
	const { hasBadge, add } = useBasket();
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const [pickId, setPickId] = useState<number | null>(preselectedBadgeId);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<number | null>(null);

	const unlockedSet = new Set(unlockedBadges);
	const held = supportAmount(heldAmount);
	const currentId = currentRungId(rungs, unlockedBadges);

	// The pick carried back across the detour sticks only to a rung that survives the
	// ratchet — a ladder edited between the click and the return re-picks clean.
	const pick = rungs.find((r) => r.id === pickId && Number(r.threshold) > held) ?? null;

	const pickIt = (rung: CreatorBadge) => {
		setAdded(null);
		setError(null);
		setPickId(Number(rung.threshold) > held ? rung.id : null);
	};

	/**
	 * Add the picked rung by way of the basket — the same add both buttons make, the
	 * scratchpad never seeing a Badge (a signed-out pick goes through the doors below
	 * before anything is held). Buy now is the add plus the trip: the basket page's
	 * embedded Checkout is the one purchase form, and every kind of line pays in it.
	 */
	const addThePick = async (thenBasket: boolean) => {
		if (!pick) return;
		setWorking(true);
		setError(null);
		try {
			const result = await Promise.resolve(
				add({
					kind: "badge",
					badgeId: pick.id,
					title: pick.label,
					price: "",
					recurring: String(pick.threshold),
					creatorHandle: creatorHandle,
				}),
			);
			if (!result.ok) {
				setError(result.error);
				return;
			}
			if (thenBasket) {
				navigate("/basket");
				return;
			}
			setAdded(pick.id);
		} finally {
			setWorking(false);
		}
	};

	// The detour's return trip: back to this page, badges tab, pick carried. The rung's
	// id in the URL is what survives the ceremony (signing in tears the page down — the
	// shell unmounts on the auth flip), and the rung above re-picks it on return.
	const back = `${pathname}?tab=badges&badge=${pick?.id ?? ""}`;

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
								: `Badges set by ${creatorName}. Pick one and buy it here — it renews monthly until you stop.`}
						</p>
					</div>
					{!isOwner && held > 0 && (
						<p className="text-sm text-base-content/60">
							You give {amountLabel(heldAmount)}/mo here.
						</p>
					)}
				</div>

				{/* The same uniform grid every listing surface uses, sized for a portrait card
				    rather than a tile: four across on the page's desktop width. */}
				<div
					className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4 items-stretch"
					data-testid="badge-grid"
				>
					{rungs.map((rung, index) => {
						const unlocked = unlockedSet.has(rung.id);
						const selectable = canBuy && Number(rung.threshold) > held;
						const state: CardState =
							rung.id === currentId
								? "current"
								: pick?.id === rung.id
									? "selected"
									: unlocked
										? "included"
										: selectable
											? "selectable"
											: "locked";

						return (
							<BadgeCard
								key={rung.id}
								rung={rung}
								index={index}
								state={state}
								inBasket={hasBadge(rung.id)}
								onPick={() => pickIt(rung)}
								onEdit={isOwner ? () => onEdit(rung) : undefined}
							/>
						);
					})}
					{isOwner && <AddBadgeCard onClick={onAdd} />}
				</div>
			</div>

			{/*
			 * The picked rung's action card — the whole purchase flow, in place: a signed-out
			 * buyer gets the account doors (both of them, both of them coming back), a
			 * signed-in buyer gets the two actions the Work page's buy row carries. The
			 * signup hop the old upgrade prompt was is gone: the intent's pick happens HERE,
			 * and the ceremony, when one exists, returns to it.
			 */}
			{pick && canBuy && (
				<div className="card max-w-xl bg-base-200" data-testid="badge-pick-actions">
					<div className="card-body gap-3 px-5 py-4">
						{!authenticated ? (
							<>
								<p className="mb-0 text-center text-sm text-base-content/60">
									Log in or make an account to buy {pick.label} — {amountLabel(pick.threshold)}/mo,
									starting with the first Month at the basket.
								</p>
								<div className="flex justify-center gap-2">
									<Link to={withNextPath("/signup", back)} className="btn btn-primary btn-sm">
										Sign up
									</Link>
									<Link to={withNextPath("/login", back)} className="btn btn-ghost btn-sm">
										Log in
									</Link>
								</div>
							</>
						) : (
							<>
								{error && <p className="text-xs text-error">{error}</p>}
								{added === pick.id && (
									<p className="text-xs text-success">
										In your basket. It charges with everything else you've added — the card fee is
										charged once per purchase.
									</p>
								)}
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-outline btn-sm"
										disabled={working || hasBadge(pick.id)}
										onClick={() => void addThePick(false)}
									>
										{hasBadge(pick.id) ? "In your basket" : working ? "Adding…" : "Add to basket"}
									</button>
									<button
										type="button"
										className="btn btn-primary btn-sm flex-1"
										disabled={working}
										onClick={() => void addThePick(true)}
									>
										<BoltIcon className="w-4 h-4" />
										{working ? "Adding…" : "Buy now"}
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
