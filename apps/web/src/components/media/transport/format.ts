// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Time formatting shared by every player.
 *
 * One copy, because three players printing durations three slightly different ways is
 * the small end of exactly the failure this whole transport layer exists to avoid: a
 * video that says `1:05:03` beside audio that says `65:03` reads as two products.
 */

/**
 * `m:ss`, or `h:mm:ss` once there is an hour to show.
 *
 * Hours appear only when the clip actually has them — padding every track to `0:03:41`
 * makes a three-minute song look like a feature film. NaN and Infinity (a media element
 * that has not read its duration yet, or a live stream) render as `0:00` rather than
 * leaking `NaN:aN` into the UI.
 */
export function formatTime(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00";
	const total = Math.floor(seconds);
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const ss = s.toString().padStart(2, "0");
	return h > 0 ? `${h}:${m.toString().padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** `-m:ss` — time left, for the right-hand slot of a transport. */
export function formatRemaining(position: number, duration: number): string {
	if (!Number.isFinite(duration) || duration <= 0) return formatTime(0);
	return `-${formatTime(Math.max(0, duration - position))}`;
}

/**
 * A spoken duration for screen readers — "3 minutes 41 seconds".
 *
 * `1:05` is read aloud as "one oh five", which is a time of day. Anywhere a duration is
 * the only thing in a control's accessible name, this is what belongs there.
 */
export function spokenDuration(seconds: number | null | undefined): string {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "unknown length";
	const total = Math.floor(seconds);
	const parts: string[] = [];
	const h = Math.floor(total / 3600);
	const m = Math.floor(total / 60) % 60;
	const s = total % 60;
	if (h > 0) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
	if (m > 0) parts.push(`${m} minute${m === 1 ? "" : "s"}`);
	if (s > 0 || parts.length === 0) parts.push(`${s} second${s === 1 ? "" : "s"}`);
	return parts.join(" ");
}
