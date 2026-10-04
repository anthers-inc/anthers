// SPDX-License-Identifier: Apache-2.0
/**
 * Anthers' Badge ladder, browser side — the seeded values the copy surfaces quote.
 *
 * The rows are the source of truth (Parker, 2026-10-03: "there's no reason to pin
 * `PUBLIC_ACCESS_PRICE` as a doc constant. Go look at the code — or now the database —
 * and read whatever value is actually there"), and this module is how the browser looks:
 * one fetch of `GET /api/subscriptions/anthers-ladder` shared by every surface that
 * quotes the ladder — the signup matrix, the marketing pages, the FAQ, the meter notice,
 * the onboarding first-run — the same store shape the Public Access meter uses
 * (`lib/public-access.ts`), for the same three reasons: the flusher that isn't a
 * component, several surfaces wanting the same numbers at once, and a ladder that must
 * re-render when the fetch lands rather than four pages each fetching it.
 *
 * ⚠️ **The constants (`ANTHERS_BADGES`, `PUBLIC_ACCESS_PRICE` in
 * `@anthers/shared/constants`) are the UNTIL-FETCHED fallback, deliberately.** A marketing
 * page must render its ladder on the first paint without waiting on the network, so every
 * hook reads the constants first and re-renders on the fetch. The fallback is the seed's
 * own input, so the two agree today; the moment they diverge, **fetched wins and the
 * stale fallback is a render flash on the way to the truth, not a published answer**.
 * What this must never become is an excuse to keep typing: a page that stops reading the
 * store has gone back to the constant.
 *
 * 🚨 **A 503 from the route (unseeded ladder) leaves the fallback standing** — logged,
 * never thrown: copy showing the seed's own values is strictly better than a ladder-shaped
 * hole on the page. The route refuses when the rows are absent; the page does not have to
 * refuse with it.
 */

import {
	ANTHERS_BADGES,
	type BadgeDef,
	badgeLabel,
	PUBLIC_ACCESS_PRICE,
} from "@anthers/shared/constants";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

/** The ladder as the rows state it — Free is not a row (the absence answer). */
export interface LadderRung {
	name: string;
	label: string;
	threshold: number;
	description: string;
}

export interface AnthersLadder {
	rungs: LadderRung[];
	/** The bottom rung's threshold — what unlimited Public Access costs. */
	publicAccessPrice: number;
}

/** The constants as a ladder, in the same shape — the until-fetched fallback. */
export function constantLadder(): AnthersLadder {
	const rungs = fromDefs(ANTHERS_BADGES);
	return {
		rungs,
		publicAccessPrice: rungs.length > 0 ? rungs[0].threshold : PUBLIC_ACCESS_PRICE,
	};
}

/** A `BadgeDef` set (the constants) read as rungs, in the shape both paths share. */
function fromDefs(defs: readonly BadgeDef[]): LadderRung[] {
	return defs.map((def) => ({
		name: def.name,
		label: badgeLabel(def.name),
		threshold: def.threshold,
		description: "",
	}));
}

let current: AnthersLadder | null = null;
let fetched = false;
const listeners = new Set<(ladder: AnthersLadder) => void>();
/** Guards against every mounting subscriber firing its own first fetch. */
let inFlight: Promise<void> | null = null;

function publish(next: AnthersLadder): void {
	current = next;
	for (const fn of listeners) fn(next);
}

/** Ask the server outright, once per session; the answer replaces the constants. */
async function fetchLadder(): Promise<void> {
	try {
		const res = await client.api.subscriptions["anthers-ladder"].$get();
		if (res.ok) {
			const body = (await res.json()) as AnthersLadder;
			if (Array.isArray(body.rungs) && body.rungs.length > 0) publish(body);
		}
	} catch {
		/* The fallback stands — see the module note on the 503/unreachable case. */
	} finally {
		fetched = true;
	}
}

/**
 * Kick the fetch without subscribing — for a page that quotes the ladder only inside an
 * event handler, or that wants the numbers warm before its own mounts subscribe.
 */
export function refreshLadder(): void {
	if (fetched || inFlight) return;
	inFlight = fetchLadder().finally(() => {
		inFlight = null;
	});
}

/**
 * The ladder — fetched when known, the constants until then.
 *
 * Re-renders on the fetch landing, which is the whole point of the store: the first paint
 * is the fallback and the moment the rows arrive, the copy is theirs.
 */
export function useAnthersLadder(): AnthersLadder {
	const [ladder, setLadder] = useState<AnthersLadder>(current ?? constantLadder());

	useEffect(() => {
		listeners.add(setLadder);
		if (current) setLadder(current);
		else refreshLadder();
		return () => {
			listeners.delete(setLadder);
		};
	}, []);

	return ladder;
}
