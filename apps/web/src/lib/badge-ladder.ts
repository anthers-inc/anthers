// SPDX-License-Identifier: Apache-2.0
/**
 * Which rung of a creator's ladder a viewer holds.
 *
 * A viewer's `unlockedBadges` is every rung at or below what they give that creator, so
 * the Badges grid has to decide which one they are *at* — the card that gets the "Your
 * Badge" highlight. It is the unlocked rung with the **highest threshold**, which is not
 * the same as the last unlocked id in the list: the server builds both lists from the
 * ladder order, and a creator can reorder their rungs without changing what anyone holds.
 *
 * ⚠️ **Thresholds are compared as numbers.** They travel as `numeric` columns read back as
 * strings, and `"10.00" < "9.00"` under a string comparison — the one way this could pick a
 * $9 rung as "yours" while the viewer gives $10.
 *
 * A duplicate threshold (the ladder does not forbid two rungs at one amount) resolves to
 * the later rung in ladder order, so the pick is stable across refetches rather than
 * depending on object identity.
 */

import type { CreatorBadge } from "@anthers/web-shared/types";

export function currentRungId(rungs: CreatorBadge[], unlocked: number[]): number | null {
	if (rungs.length === 0 || unlocked.length === 0) return null;
	const unlockedSet = new Set(unlocked);
	let current: CreatorBadge | null = null;
	for (const rung of rungs) {
		if (!unlockedSet.has(rung.id)) continue;
		// `>=` on equal thresholds keeps the later rung, which is the ladder-order answer.
		if (current === null || Number(rung.threshold) >= Number(current.threshold)) current = rung;
	}
	return current?.id ?? null;
}
