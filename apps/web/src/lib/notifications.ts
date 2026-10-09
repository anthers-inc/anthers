// SPDX-License-Identifier: Apache-2.0
/**
 * The bell's store — the unread count, polled, one fetch shared by every subscriber.
 *
 * 🚨 **A module store rather than per-component state, because the bell is chrome**: the
 * header renders in every mode and every route, so per-component polling would be one
 * fetch per mounted surface (and the Layout remounts over the auth unmount, so its state
 * dies with it). This is the basket store's exact shape — one truth at module scope, a
 * `Set` of subscribers, publish on every read — chosen by copying it rather than by
 * inventing a third way.
 *
 * ⭐ **The poll is slow (Parker, 2026-10-08: "relatively slow; not literally real-time")**
 * — 30 seconds, started once, in the store rather than the component, so it runs exactly
 * once however many surfaces listen. A poll that stops when the bell unmounts would die
 * with the auth remount and never restart; a store-level interval that the app's own
 * sign-out clears is simpler and cannot orphan.
 *
 * The refresh-on-navigation trigger lives in the bell component (which sees routing);
 * the interval here covers sitting still on one page.
 */
// The poll is slow (Parker, 2026-10-08: "relatively slow; not literally real-time") —
// 30 seconds, started once, in the store rather than the component, so it runs exactly
// once however many surfaces listen. A poll that stops when the bell unmounts would die
// with the auth remount and never restart; a store-level interval that the app's own
// sign-out clears is simpler and cannot orphan.
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";

const POLL_MS = 30_000;

let count: number | null = null;
const listeners = new Set<(n: number | null) => void>();

function publish(next: number | null) {
	count = next;
	for (const fn of listeners) fn(next);
}

let inFlight: Promise<void> | null = null;

async function load(): Promise<void> {
	try {
		const res = await client.api.accounts.me.notifications.unread.$get();
		if (!res.ok) {
			// A 401 is a sign-out mid-poll: drop the count and stop the interval. Self-parking
			// here rather than asking sign-out to know about the store — the shared auth
			// module cannot import back down into an app lib without a cycle.
			publish(null);
			stopUnreadPolling();
			return;
		}
		const body = (await res.json()) as unknown as { unread: number };
		publish(body.unread);
	} catch {
		// Leave the last count standing: a dropped poll is not evidence of zero.
	}
}

/**
 * Refresh the count now, deduplicated — every caller in one tick shares the fetch.
 * Called on bell mount and on navigation.
 */
export function refreshUnreadCount(): void {
	if (inFlight) return;
	inFlight = load().finally(() => {
		inFlight = null;
	});
}

/**
 * Drop the count after a read-all — the notifications page marks everything read, and the
 * bell must move in the same tick rather than waiting out the poll.
 */
export function setUnreadCount(n: number) {
	publish(n);
}

/** The bell's subscription. Returns the count; null means "not loaded / signed out". */
export function useUnreadCount(): number | null {
	const [value, setValue] = useState<number | null>(count);
	useEffect(() => {
		listeners.add(setValue);
		setValue(count);
		return () => {
			listeners.delete(setValue);
		};
	}, []);
	return value;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the store's own poll. Idempotent; called by the bell's effect. */
export function startUnreadPolling(): void {
	if (timer) return;
	timer = setInterval(() => {
		// Only while somebody is listening: a poll with no bell on screen is a request the
		// app makes for nobody.
		if (listeners.size === 0) return;
		refreshUnreadCount();
	}, POLL_MS);
}

/** Stop it — sign-out's cleanup, so a signed-out tab does not poll a 401 forever. */
export function stopUnreadPolling(): void {
	if (timer) {
		clearInterval(timer);
		timer = null;
	}
	count = null;
	for (const fn of listeners) fn(null);
}
