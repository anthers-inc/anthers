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
import type { AccessRow, Work } from "../../lib/types";
import { accessRowsOf } from "../../lib/types";

// ─── Access ─────────────────────────────────────────────────────────────────

/**
 * What a Work's own access table means to its creator.
 *
 * Derived, never stored — the same property `publicAccess` has on the user-facing
 * serializer, and deliberately the same rule (`isFree && streamEnabled && released`) so
 * the creator's badge and the user's experience cannot disagree. The creator's Catalog
 * response carries `access` in full, so nothing here needs the resolver: with nothing
 * given, a user qualifies for the baseline row alone.
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

/**
 * The access rows plus the two switches that decide the state — a Work, or a live form.
 *
 * `access` takes the union because a `Work` carries whichever serialization it arrived
 * on; only the OWNER's shape holds rows here, and that is the only shape this function
 * is ever called on — the user's carries the resolver's `AccessResult`, which has no
 * rows to read.
 */
export interface AccessShape {
	visibility?: Work["visibility"];
	access?: AccessRow[] | null | Work["access"];
	streamEnabled?: boolean;
	/**
	 * The Work's type, when the caller carries one. A physical Work's free baseline
	 * row reads as a sale, not as a freebie — the store prices it (the goods-works
	 * rule; service joins the goods kinds when its purchase rail lands).
	 */
	type?: string;
}

export function accessState(item: AccessShape): AccessState {
	if (item.visibility !== "released") return "private";

	const rows = accessRowsOf(item.access) ?? [];
	if (!rows.some((r) => r.allow)) return "locked";

	const baseline = rows.find((r) => r.threshold === 0);
	if (baseline?.allow) {
		if (Number(baseline.price) > 0) return "sale";
		// A goods Work is bought, not cleared: its price lives in the store, never in
		// this table (the goods-works rule in the API's resolver). The baseline row
		// opening the page reads as somebody selling, not as a freebie — a shirt
		// wearing a "free download" badge would be exactly the categorization error
		// Parker named on 2026-10-09. Service joins the goods kinds with its own rail.
		if (item.type === "physical") return "sale";
		// Free to everyone, but only the commons when it actually streams — a
		// download-only freebie is free, and is not Public Access.
		return item.streamEnabled ? "public-access" : "free";
	}
	return "gated";
}
