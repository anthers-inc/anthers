// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Locked-Work presentation — the *chrome* around a gate, not the flow through one.
 *
 * When a Work is gated to the viewer the whole thing locks (body + media are withheld
 * server-side), and this file supplies what a card or a page shows in its place: a blurred
 * cover with a lock chip, and the two labels that name what the lock IS and what to do
 * about it. Consumers are `WorkCard` and `WorkPage`.
 *
 * 🚨 **The unlock FLOW is not here — it is `apps/web/src/components/post/InlineUnlock.tsx`,
 * rendered by `WorkPage`.** This file used to also export `UnlockPanel` and `UnlockModal`,
 * two reason-aware components that offered log-in / sign-up / join-the-creator routes and
 * had **no callers anywhere in the repo** (deleted 2026-08-17). They are worth a note
 * rather than a silent removal, because of what believing in them cost: when the signup
 * consolidation landed, "the logged-out viewer lost their way back to the post" was
 * diagnosed against `UnlockModal` — which did carry a return destination — and the real
 * live surface, `InlineUnlock`, turned out never to have had one at all. **Reading a file
 * tells you what a component would do, not whether anything renders it.** Grep first.
 */
import { ANTHERS_BADGES, type BadgeKey, badgeLabel } from "@anthers/shared/constants";
import { LockClosedIcon } from "@heroicons/react/24/solid";
import type { AccessResult, UnlockRoute } from "../../lib/types";

/**
 * Whether a Work should be *presented* as locked — a blurred cover, a padlock, "members
 * only" — as opposed to merely being undeliverable right now.
 *
 * 🚨 **The two stopped being the same question on 2026-08-28, and conflating them turns
 * the commons into a wall of padlocks.** Consuming a Work now requires an account, so a
 * signed-out visitor is refused the bytes of *free* work too — and a card that reads
 * `!canAccess` as "locked" would put "Members-only work from this creator" under every
 * Public Access Work on Discover, shown to precisely the visitor the public page exists
 * for. The Work is free to everyone and stays free to everyone; what is missing is an
 * account for the time to be attributed to.
 *
 * That is the same line the Public Access meter draws and for the same reason — a Work is
 * never described as gated by something that belongs to the viewer, or the commons quietly
 * reads as stratified again, which is what retiring Anthers Gates was for.
 */
export function presentsAsLocked(access: AccessResult | null | undefined): boolean {
	if (!access || access.canAccess) return false;
	return !(access.reason === "login_required" && access.isFree);
}

/**
 * The cheapest route into a gated Work, and who the money would go to.
 *
 * "Cheapest" is the smallest amount the viewer still has to add, which is what they asked
 * for; a tie goes to the creator, since what a viewer gives a creator reaches them in full.
 * Returns null when the Work isn't gate-openable (purchase-only, or logged out).
 *
 * Module-private since 2026-08-17 — the two components that used it from outside the two
 * label helpers below are gone, and an export nobody imports is an invitation to grow a
 * second caller that doesn't know the labels exist.
 */
function cheapestRoute(
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
 * facing. One kind of giving, named by where it goes — there is no second kind. (The
 * guide entry this used to quote taught the Seed, and retired with it on 2026-08-16; the
 * point it made survives, because what changed was the unit and not the shape.)
 */
export function unlockLabel(access: AccessResult, creatorName = "this creator"): string {
	if (access.reason === "login_required") return "Log in to unlock";
	if (access.reason === "payment_required" && access.price) return `Unlock for $${access.price}`;
	const cheapest = cheapestRoute(access, creatorName);
	if (!cheapest) return "Join to unlock";
	return `Unlock with ${seedsToGo(cheapest.route.moreNeeded)} to ${cheapest.target}`;
}

/**
 * What the Work is locked BY, for the lock chip — the Badge sitting at the gate, when
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
