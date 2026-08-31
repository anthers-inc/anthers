// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Public Access meter, browser side — what a viewer has left, and who knows it.
 *
 * The API has told us this all along and nothing listened. `GET /subscriptions/public-access`
 * answers on demand, and **every attention write returns the budget after the batch** —
 * which is the interesting one, because it means a countdown needs no polling of its own.
 * A viewer watching video is already talking to the server every 30 seconds; the budget
 * rides back on those replies for free.
 *
 * So this is a module-level store rather than a hook that fetches. Three reasons, and
 * the last is the one that decided it:
 *
 *   1. The attention flusher is not a component and cannot hold React state, but it is
 *      the thing that learns the budget most often.
 *   2. Several surfaces want the same number at once — the player, a banner, and
 *      whatever the page puts in a corner — and none of them should each be fetching it.
 *   3. **A player has to react to the budget running out mid-playback.** The flush that
 *      spends the last minute is the same flush that reports zero remaining, so a store
 *      every player subscribes to turns "you have run out" into an ordinary render
 *      instead of something that has to be discovered by failing a request.
 *
 * 🚨 **An anonymous viewer has no allowance, so there is no meter to render them.** They
 * cannot consume a Work at all — delivery requires an account (the public wiki's *What Is Free, and What Is Gated*) — so a budget
 * would be a countdown on something that never starts. `useMeteredBudget` returns null when
 * signed out, and what a signed-out visitor sees in place of a player is the invitation to
 * make an account, from `InlineUnlock`.
 *
 * ⚠️ This said the opposite until 2026-08-28: that the server handed a logged-out caller
 * the full allowance on purpose, "because anonymous streaming of the commons is the shop
 * window". The null return was right; the reason given for it was a justification written
 * after the fact for a missing `requireAuth`. The shop window is the Work's *page*, which
 * is still public.
 */

import type { PublicAccessBudget } from "@anthers/shared/public-access";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

export type { PublicAccessBudget };

let current: PublicAccessBudget | null = null;
const listeners = new Set<(b: PublicAccessBudget) => void>();
/** Guards against every mounting subscriber firing its own first fetch. */
let inFlight: Promise<void> | null = null;

/**
 * Push a freshly-known budget to everyone watching.
 *
 * Called by the attention flusher on each successful write, and by the fetch below.
 * Deliberately tolerant of a malformed payload: a countdown is not worth a crash, and
 * this runs on a response path that a player's playback depends on.
 */
export function publishBudget(next: unknown): void {
	if (!isBudget(next)) return;
	current = next;
	for (const fn of listeners) fn(next);
}

function isBudget(v: unknown): v is PublicAccessBudget {
	if (v === null || typeof v !== "object") return false;
	const b = v as Record<string, unknown>;
	return typeof b.unlimited === "boolean" && typeof b.allowed === "boolean";
}

/** Ask the server outright. Used once per session by the first subscriber. */
async function fetchBudget(): Promise<void> {
	try {
		const res = await client.api.subscriptions["public-access"].$get();
		if (res.ok) publishBudget(await res.json());
	} catch {
		/* A missing countdown is not worth surfacing an error over. */
	}
}

/**
 * Re-ask, now.
 *
 * For the one case the attention stream cannot cover: delivery has just refused a
 * request, so the allowance emptied *between* flushes and the store is stale by up to
 * half a minute. Re-reading turns a player's local "I was refused" into the real budget,
 * which is what the wall renders from.
 */
export function refreshBudget(): void {
	inFlight ??= fetchBudget().finally(() => {
		inFlight = null;
	});
}

/**
 * The current budget, or null until it is known.
 *
 * Returns the raw server answer including the anonymous full-allowance case — most
 * callers want {@link useMeteredBudget} instead.
 */
export function usePublicAccessBudget(): PublicAccessBudget | null {
	const [budget, setBudget] = useState<PublicAccessBudget | null>(current);

	useEffect(() => {
		listeners.add(setBudget);
		if (current) setBudget(current);
		else {
			inFlight ??= fetchBudget().finally(() => {
				inFlight = null;
			});
		}
		return () => {
			listeners.delete(setBudget);
		};
	}, []);

	return budget;
}

/**
 * The budget **only when it actually applies to this viewer** — signed in, and limited.
 *
 * Null covers three genuinely different situations that all mean *do not render a
 * meter*: not signed in (not metered at all), not yet known, and unlimited (gives Anthers
 * the Public Access price). Collapsing them is safe here because every caller does the same thing with all
 * three, and separating them would push a three-way branch into every consumer to no
 * end.
 *
 * ⚠️ **The `unlimited` clause here is redundant today, and that is recorded rather than
 * hidden.** Sabotage-testing found that removing it changes nothing: an unlimited viewer's
 * budget carries `allowed: true` and a null remainder, so `shouldWarn` suppresses the
 * countdown and the players never read `spent`. It is kept because it states the
 * *semantic* boundary — an unlimited viewer is not a metered viewer — and because the
 * players use the returned budget directly to render the wall. The property it stands
 * for is enforced, and pinned, in `shouldWarn`; do not mistake this line for the guard.
 */
export function useMeteredBudget(): PublicAccessBudget | null {
	const { user } = useAuth();
	const budget = usePublicAccessBudget();
	if (!user || !budget || budget.unlimited) return null;
	return budget;
}

/** Whole hours and minutes left, for copy. Never negative — the budget clamps at zero. */
export function describeRemaining(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds / 60));
	const hours = Math.floor(total / 60);
	const minutes = total % 60;
	if (hours === 0) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
	if (minutes === 0) return hours === 1 ? "1 hour" : `${hours} hours`;
	return `${hours} hr ${minutes} min`;
}

/**
 * When to start saying anything at all.
 *
 * An hour, because the point is to warn *before* the stop rather than to nag: at ten
 * hours a month, an hour left is roughly a last sitting. Below this the viewer is told
 * where they stand; above it the meter stays out of the way, which is the difference
 * between a limit that is honest and a limit that is loud.
 */
export const LOW_BUDGET_SECONDS = 3600;

/** Whether the meter should say something — running low, or spent. */
export function shouldWarn(budget: PublicAccessBudget | null): boolean {
	if (!budget || budget.unlimited || budget.remainingSeconds === null) return false;
	return budget.remainingSeconds <= LOW_BUDGET_SECONDS;
}

// ── The anonymous viewer ─────────────────────────────────────────────────────
//
// 🚨 **A local tally of anonymous viewing time used to live here, and it is gone with the
// model it served (2026-08-28).** `ANON_PROMPT_SECONDS`, `recordAnonymousSeconds`,
// `readAnonymousSeconds` and `clearAnonymousSeconds` counted how long a logged-out visitor
// had watched, in `localStorage`, so that `AnonymousViewerBanner` could invite them to make
// an account after half an hour. Consuming a Work now requires an account, so there is no
// anonymous playback to count: a signed-out visitor never reaches a player, and the invitation
// to sign up is the thing standing where the player would be.
//
// Worth a note rather than a silent deletion, because the code was careful, well-tested and
// entirely correct about a rule that had never been agreed. It was cited in the public wiki's *What Is Free, and What Is Gated* step
// 3 — *"after approximately 30 minutes of cumulative viewing"* — which is the sentence that
// section was rewritten to remove.
