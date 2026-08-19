// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure half of the Catalog's authoring surface: what a Work's access table means from
 * its creator's side of the glass, and how a creator-asserted Created date converts to and
 * from the instant the API stores.
 *
 * Kept out of the `.tsx` files that render it so both are testable without a DOM — the
 * same reasoning that puts `attention.ts`, `public-access.ts` and `resolveAccessSync`
 * behind pure modules. Neither of these can be checked by looking at the screen: a
 * timezone slip renders a perfectly plausible date one day early, and a drifted access
 * rule renders a perfectly plausible badge.
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

// ─── The creator-asserted Created date ──────────────────────────────────────

export type AuthoredPrecisionValue = "year" | "month" | "day";

/**
 * The Created date is stored as a full instant plus the precision the creator actually
 * claimed, so a back-dated 2015 game renders "2015" and never an invented 1 January.
 *
 * Everything here works in **UTC** because the read side does — `WorkCard.madeLabel` uses
 * `getUTCFullYear()` and `timeZone: "UTC"`. A local-midnight instant would render as the
 * previous day for every reader west of Greenwich, which is the kind of defect that looks
 * like a plausible date rather than an error.
 *
 * The API takes `z.string().datetime()`, i.e. RFC 3339 with the `Z`, so a bare
 * `"2015-01-01"` is rejected outright. Each precision widens to the first instant of its
 * period.
 */
export function authoredToIso(
	precision: AuthoredPrecisionValue | null,
	value: string,
): string | null {
	if (!precision || !value) return null;
	const full =
		precision === "year" ? `${value}-01-01` : precision === "month" ? `${value}-01` : value;
	const d = new Date(`${full}T00:00:00.000Z`);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The stored instant → the value its precision's input expects. Inverse of the above. */
export function isoToAuthoredValue(
	iso: string | null | undefined,
	precision: AuthoredPrecisionValue,
): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const day = d.toISOString().slice(0, 10); // YYYY-MM-DD, already UTC
	switch (precision) {
		case "year":
			return day.slice(0, 4);
		case "month":
			return day.slice(0, 7);
		default:
			return day;
	}
}
