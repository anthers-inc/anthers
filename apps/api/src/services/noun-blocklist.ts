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
import { and, eq } from "drizzle-orm";
import { vendorPost } from "../lib/noun/client";

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

/**
 * Remove one entry — the report-path's reversal, and its own admin action.
 */
export async function removeFromBlocklist(kind: BlocklistKind, value: string): Promise<void> {
	await db
		.delete(nounBlocklist)
		.where(and(eq(nounBlocklist.kind, kind), eq(nounBlocklist.value, value.trim().toLowerCase())));
}

/**
 * Push every Anthers-side blocklist entry up to the vendor's key-level blocklist.
 *
 * 🚨 **The term half is what this sync exists for** — an entry on the vendor's own
 * blocklist refuses the query on their side too, so a search answer never carries it,
 * and the control holds for any other surface that ever shares the key. Best-effort per
 * entry: the local list is the control that actually gates the routes, so a vendor
 * refusal is recorded in the run's return and never blocks the others.
 *
 * ⚠️ The vendor's blocklist view is cached ten minutes on their side, so their
 * endpoints lag a sync by that much; the LOCAL list is what Anthers' routes read, and
 * it takes effect immediately.
 */
export async function blocklistVendorSync(): Promise<{
	pushed: string[];
	failed: string[];
}> {
	const rows = await db.select().from(nounBlocklist);
	const vendorPath = (kind: BlocklistKind) =>
		kind === "term"
			? "/v2/client/blacklist/term"
			: kind === "icon"
				? "/v2/client/blacklist/id"
				: "/v2/client/blacklist/collection";
	const pushed: string[] = [];
	const failed: string[] = [];
	for (const row of rows) {
		try {
			await vendorPost(vendorPath(row.kind as BlocklistKind), {
				[row.kind === "term" ? "term" : "id"]: row.value,
			});
			pushed.push(`${row.kind}:${row.value}`);
		} catch (err) {
			failed.push(
				`${row.kind}:${row.value} — ${err instanceof Error ? err.message.slice(0, 120) : "unknown"}`,
			);
		}
	}
	return { pushed, failed };
}
