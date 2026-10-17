// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund's published ledger, browser side — the figure the free tier's
 * pool rides.
 *
 * The free account's Time Pool is not a constant (`FREE_TIME_POOL` retired with the
 * pool mechanism): it is the **Fund** — a stated share of the charitable remainder
 * after the admin budget, published monthly, divided across the cycle's active free
 * accounts. Every surface quoting the free pool's number reads it here, from
 * `GET /api/subscriptions/time-pool-fund`, exactly as the Badge ladder's seeded
 * values are fetched rather than quoted from code.
 *
 * ⚠️ **There is no number fallback, on purpose.** The ladder's fallback can be its own
 * constant (the seed's input); the Fund's value is RUNTIME data with no seed-time
 * predecessor — a stale number typed into the bundle would sit beside a published
 * record that moved. Until the fetch lands, the hook answers `null` and the surface
 * renders the settled placeholder — "varies — published monthly" — exactly as the
 * signup walk-down's Free rung does. A 503 or an empty ledger answers the same null.
 */

import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** One published cycle of the ledger — the route's row shape. */
export interface PublishedFundCycle {
	billingCycle: string;
	status: string;
	charitableRevenue: number;
	poolAmount: number;
	activeFreeAccounts: number;
	slicePerAccount: number;
}

export interface PublishedFund {
	/** Newest first: actuals, then the next month's commitment, then its estimate. */
	cycles: PublishedFundCycle[];
}

/** The published values the copy reads: the current cycle and its per-account slice. */
export interface FundValues {
	/** The cycle the figures name. */
	billingCycle: string;
	/** The Fund's pot for the cycle, and the per-account slice it divides into. */
	poolAmount: number;
	slicePerAccount: number;
	/** Actual for an ended or in-flight cycle; committed once it is published in advance. */
	status: string;
}

let current: FundValues | null = null;
let fetched = false;
const listeners = new Set<(values: FundValues | null) => void>();
let inFlight: Promise<void> | null = null;

function publish(next: FundValues | null): void {
	current = next;
	for (const fn of listeners) fn(next);
}

/** Ask the server outright, once per session; the answer replaces the absence. */
async function fetchFund(): Promise<void> {
	try {
		const res = await client.api.subscriptions["time-pool-fund"].$get();
		if (res.ok) {
			const body = (await res.json()) as PublishedFund;
			const rows = Array.isArray(body.cycles) ? body.cycles : [];
			// The newest ACTUAL row is the current published value; a committed or
			// estimate row is a promise about a later cycle, not today's pool.
			const actual = rows.find((r) => r.status === "actual");
			if (actual) {
				publish({
					billingCycle: actual.billingCycle,
					poolAmount: actual.poolAmount,
					slicePerAccount: actual.slicePerAccount,
					status: actual.status,
				});
			}
		}
	} catch {
		/* The absence stands — see the module note. */
	} finally {
		fetched = true;
	}
}

/**
 * Kick the fetch without subscribing — for a surface that quotes the Fund only inside
 * an event handler, or that wants the numbers warm before its own mounts subscribe.
 */
export function refreshTimePoolFund(): void {
	if (fetched || inFlight) return;
	inFlight = fetchFund().finally(() => {
		inFlight = null;
	});
}

/**
 * The Fund's published values — fetched when known, null until then.
 *
 * Re-renders when the fetch lands, so the first paint's placeholder is a flash on the
 * way to the record, never a stale number posing as the record.
 */
export function useTimePoolFund(): FundValues | null {
	const [values, setValues] = useState<FundValues | null>(current);

	useEffect(() => {
		listeners.add(setValues);
		if (current) setValues(current);
		else refreshTimePoolFund();
		return () => {
			listeners.delete(setValues);
		};
	}, []);

	return values;
}