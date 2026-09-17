// SPDX-License-Identifier: Apache-2.0
/**
 * Converting between a stored instant and the value an `<input type="datetime-local">` holds.
 *
 * The input speaks the viewer's local clock with no zone and no seconds, and the API stores an
 * instant, so a schedule typed as "9:00" has to become 9:00 wherever the person typing it is.
 * Both scheduling controls — a post's publish time and a Work's release time — go through here,
 * so the two cannot disagree about what a typed time means.
 *
 * ⚠️ **Local time is the point here**, unlike the billing code `local-time-guard.test.ts` keeps
 * to UTC: a creator scheduling a release means their own 9:00.
 */

/** A stored ISO instant → the local value the input expects, or "" for none. */
export function isoToLocalInput(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The input's local value → an ISO instant, or null when it is empty or unreadable. */
export function localInputToIso(value: string): string | null {
	if (!value.trim()) return null;
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
