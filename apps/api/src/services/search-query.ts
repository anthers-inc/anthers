// SPDX-License-Identifier: Apache-2.0
/**
 * The SQL half of the shared search rule.
 *
 * `@anthers/shared/search` owns tokenizing and the literal containment rule; this turns
 * those terms into a `WHERE` condition. Every term must appear in at least one of the
 * fields — the same AND the client's local matcher implements, so a Filter-mode view and
 * the global endpoint cannot disagree about what a query means.
 */
import { likeContains } from "@anthers/shared/search";
import { and, type Column, ilike, or, type SQL } from "drizzle-orm";

export function matchesFields(terms: readonly string[], fields: (SQL | Column)[]): SQL {
	const conditions = terms.map((term) =>
		or(...fields.map((field) => ilike(field, likeContains(term)))),
	);
	return and(...conditions) as SQL;
}
