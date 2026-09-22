// SPDX-License-Identifier: Apache-2.0
/**
 * The pure half of the Catalog's authoring surface: what a Work's access table means from
 * its creator's side of the glass.
 *
 * Kept out of the `.tsx` files that render it so it is testable without a DOM — the
 * same reasoning that puts `attention.ts`, `public-access.ts` and `resolveAccessSync`
 * behind pure modules. A drifted access rule renders a perfectly plausible badge, which
 * is the kind of defect that cannot be caught by looking at the screen.
 */
import type { SeedAccessRow, Work } from "../../lib/types";

// ─── Access ─────────────────────────────────────────────────────────────────

/**
 * What a Work's own access table means to its creator.
 *
 * Derived, never stored — the same property `publicAccess` has on the viewer-facing
 * serializer, and deliberately the same rule (`isFree && streamEnabled && released`) so
 * the creator's badge and the reader's experience cannot disagree. The creator's Catalog
 * response carries `seedAccess` in full, so nothing here needs the resolver: with nothing
 * given, a viewer qualifies for the baseline row alone.
 *
 * 🚨 That last sentence is the load-bearing assumption, and it is a claim about code in
 * another package. It is pinned by `apps/api/src/__tests__/catalog-badge-contract.test.ts`
 * against the real `resolveAccessSync` — read that file before changing anything here.
 *
 * `locked` is the state worth naming loudly. A Work ships "free but fully locked"
 * (`defaultSeedAccess()` on the server is one baseline row with `allow: false`), so a
 * creator who releases without touching this table publishes something nobody can open,
 * and nothing else in the app would tell them.
 */
export type AccessState = "private" | "locked" | "public-access" | "free" | "sale" | "gated";

/** The access rows plus the two switches that decide the state — a Work, or a live form. */
export interface AccessShape {
	visibility?: Work["visibility"];
	seedAccess?: SeedAccessRow[] | null;
	streamEnabled?: boolean;
}

export function accessState(item: AccessShape): AccessState {
	if (item.visibility !== "released") return "private";

	const rows: SeedAccessRow[] = item.seedAccess ?? [];
	if (!rows.some((r) => r.allow)) return "locked";

	const baseline = rows.find((r) => r.threshold === 0);
	if (baseline?.allow) {
		if (Number(baseline.price) > 0) return "sale";
		// Free to everyone, but only the commons when it actually streams — a
		// download-only freebie is free, and is not Public Access.
		return item.streamEnabled ? "public-access" : "free";
	}
	return "gated";
}
