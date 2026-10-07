// SPDX-License-Identifier: Apache-2.0
/**
 * The Blocklist — the content control for the Badge Maker's creator-facing search, and
 * the only module that writes `noun_blocklist`.
 *
 * 🚨 **THE TERM LIST IS THE HALF THAT MATTERS, AND IT REFUSES THE QUERY RATHER THAN
 * FILTERING THE RESULT.** A term on the list means the search is refused before the
 * vendor is asked, which is both the safety control — the result never exists here —
 * and an unspent service call. Icon and collection entries filter a returned result
 * set, the weaker half, because the query already reached the vendor.
 *
 * 🚨 **The search route consults this module; nothing else reads the table.** A creator
 * report about an emblem a search surfaced is an admin action into this module, and the
 * vendor's own blocklist endpoints receive the same entry by the sync job here — so
 * Anthers' list and the key's agree within the sync interval.
 *
 * Seeding the initial list and owning its review cadence are safety decisions above
 * this module — Parker's court, per the sourcing document's *Questions for Anthers* —
 * and the picker must not ship with the mechanism present and the list never discussed.
 */

import { db } from "@anthers/db/client";
import { nounBlocklist } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

export type BlocklistKind = "term" | "icon" | "collection";

export function isBlocklistKind(value: unknown): value is BlocklistKind {
	return value === "term" || value === "icon" || value === "collection";
}

/**
 * Add one entry, idempotently — a term added twice is one entry, because the table's
 * unique key is the pair and a duplicate reason would read as two decisions.
 */
export async function addToBlocklist(input: {
	kind: BlocklistKind;
	value: string;
	reason: string;
	addedBy: number;
}): Promise<void> {
	await db
		.insert(nounBlocklist)
		.values({
			kind: input.kind,
			value: input.value.trim().toLowerCase(),
			reason: input.reason,
			addedBy: input.addedBy,
		})
		.onConflictDoNothing();
}

/**
 * Whether a query is refused outright — true when any whitespace-separated word of it
 * (or the whole phrase) sits on the term list.
 *
 * ⭐ **Both the phrase and its words are matched.** A blocklisted phrase ("swastika")
 * must refuse the query that names it; a blocklisted word must refuse the query that
 * carries it inside any other phrase. Matching is case-insensitive and
 * whitespace-normalized, because a query's shape is the querier's choice, not the
 * list's.
 */
export async function queryRefused(query: string): Promise<boolean> {
	const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
	if (!normalized) return false;
	const terms = await db
		.select({ value: nounBlocklist.value })
		.from(nounBlocklist)
		.where(eq(nounBlocklist.kind, "term"));
	return terms.some((t) => {
		const v = t.value.toLowerCase();
		return normalized === v || normalized.includes(v);
	});
}

/**
 * Filter a returned result set by the icon and collection halves of the list.
 *
 * Called only on a live vendor response — after the term list has already refused the
 * refused queries — and on the way OUT, which is why it is the weaker half.
 */
export async function filterBlockedIcons<
	T extends { id: unknown; collections?: { id?: unknown }[] },
>(icons: T[]): Promise<T[]> {
	const [iconRows, collectionRows] = await Promise.all([
		db
			.select({ value: nounBlocklist.value })
			.from(nounBlocklist)
			.where(eq(nounBlocklist.kind, "icon")),
		db
			.select({ value: nounBlocklist.value })
			.from(nounBlocklist)
			.where(eq(nounBlocklist.kind, "collection")),
	]);
	const blockedIcons = new Set(iconRows.map((r) => String(r.value)));
	const blockedCollections = new Set(collectionRows.map((r) => String(r.value)));
	return icons.filter((icon) => {
		if (blockedIcons.has(String(icon.id))) return false;
		return !(icon.collections ?? []).some(
			(c) => c?.id !== undefined && blockedCollections.has(String(c.id)),
		);
	});
}
