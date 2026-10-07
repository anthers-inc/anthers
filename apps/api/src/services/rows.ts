// SPDX-License-Identifier: Apache-2.0
/**
 * Rows from a drizzle `db.execute` — which answers differently across drivers, so the
 * admin route's own guard is the shared shape (routes/admin.ts carries the reasoning).
 */
export function rowsOf<T = Record<string, unknown>>(res: unknown): T[] {
	if (Array.isArray(res)) return res as T[];
	const maybe = (res as { rows?: T[] } | null)?.rows;
	return Array.isArray(maybe) ? maybe : [];
}
