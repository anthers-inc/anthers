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
 * 🚨 **An anonymous viewer is not metered, and this must not pretend otherwise.** The
 * server hands a logged-out caller the full allowance with nothing spent — deliberately,
 * because anonymous streaming of the commons is the shop window — so their budget always
 * reads "10 hours left" no matter how long they watch. Rendering that as a meter would
 * state a falsehood with a number attached. `useMeteredBudget` returns null when signed
 * out for exactly this reason; the anonymous case gets a different surface.
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
 * meter*: not signed in (not metered at all), not yet known, and unlimited (holds a
 * Seed). Collapsing them is safe here because every caller does the same thing with all
 * three, and separating them would push a three-way branch into every consumer to no
 * end.
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

/** Where a logged-out viewer's running total lives. Cleared once they have an account. */
const ANON_WATCHED_KEY = "anthers_anon_watched_seconds";

/**
 * How long a logged-out viewer watches before being invited to make an account.
 *
 * 21.01 §9.1 step 3 — *"after approximately 30 minutes of cumulative viewing"*. The
 * prompt is dismissible and never blocks: the argument for an account here is that it
 * saves your place, not that you are running out of anything.
 */
export const ANON_PROMPT_SECONDS = 30 * 60;

/**
 * Accumulate a logged-out viewer's watch time, and say whether they have passed the mark.
 *
 * 🚨 **This is a genuinely different measurement from the meter and must not be confused
 * with it.** A logged-out viewer is *not metered* — the server hands them the full
 * allowance every time, on purpose — so there is nothing on the server to count and no
 * budget to draw down. This is a local tally, in `localStorage`, purely to decide when to
 * mention that accounts exist. It is trivially resettable by clearing site data, which is
 * fine: nothing is being enforced with it.
 */
export function recordAnonymousSeconds(seconds: number): number {
	if (seconds <= 0) return readAnonymousSeconds();
	const next = readAnonymousSeconds() + seconds;
	try {
		localStorage.setItem(ANON_WATCHED_KEY, String(next));
	} catch {
		/* Storage disabled — the prompt simply never fires, which is the safe direction. */
	}
	return next;
}

export function readAnonymousSeconds(): number {
	try {
		const raw = Number(localStorage.getItem(ANON_WATCHED_KEY));
		return Number.isFinite(raw) && raw > 0 ? raw : 0;
	} catch {
		return 0;
	}
}

/** Forget the tally — called once an account exists, since it has served its purpose. */
export function clearAnonymousSeconds(): void {
	try {
		localStorage.removeItem(ANON_WATCHED_KEY);
	} catch {
		/* ignore */
	}
}
