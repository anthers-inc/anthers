// SPDX-License-Identifier: Apache-2.0
/**
 * Whether a Work's Edit page holds anything unsaved, decided by comparing what it would save.
 *
 * The page keeps one explicit Save rather than saving each field as it changes (Parker,
 * 2026-09-17), so it has to know when to offer it: the bar saying *Unsaved changes* appears
 * while what the page would send differs from what it last saved or loaded.
 *
 * ⚠️ **An access row that allows nobody at $0 is the same as no row.** The page rebuilds the
 * access table when the creator's Badge rungs arrive, which happens after the page has loaded,
 * and every rung the Work had no row for arrives as exactly that. Compared as they stand, the
 * page would announce unsaved changes the creator never made the moment the rungs loaded.
 */

import type { WorkInput } from "@anthers/web-shared/types";

/** A string that is equal for two saves exactly when they would change nothing different. */
export function unsavedKey(payload: WorkInput): string {
	const rows = payload.seedAccess ?? [];
	return JSON.stringify({
		...payload,
		seedAccess: rows.filter((row) => row.allow || Number(row.price) !== 0),
	});
}
