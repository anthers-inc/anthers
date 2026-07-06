// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { useCallback, useEffect, useRef } from "react";

const FLUSH_INTERVAL_MS = 30_000; // Report every 30 seconds
const TICK_INTERVAL_MS = 1_000; // Accumulate every 1 second

interface AttentionEvent {
	creatorId: number;
	postId?: number | null;
	eventType: "page_view" | "play" | "watch" | "read" | "listen";
	durationSeconds: number;
}

// Pending events waiting to be flushed
let pendingEvents: AttentionEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let isAuthenticated = false;

async function flushEvents() {
	if (!isAuthenticated || pendingEvents.length === 0) return;

	const toSend = [...pendingEvents];
	pendingEvents = [];

	try {
		const res = await client.api.subscriptions.attention.$post({
			json: {
				events: toSend.map((e) => ({
					creatorId: e.creatorId,
					eventType: e.eventType,
					durationSeconds: e.durationSeconds,
					...(e.postId != null ? { postId: e.postId } : {}),
				})),
			},
		});
		if (!res.ok) {
			// On failure, put events back for next flush attempt
			pendingEvents.unshift(...toSend);
		}
	} catch {
		// On failure, put events back for next flush attempt
		pendingEvents.unshift(...toSend);
	}
}

function ensureFlushTimer() {
	if (flushTimer) return;
	flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);

	// Also flush on page unload
	if (typeof window !== "undefined") {
		window.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				flushEvents();
			}
		});
	}
}

/**
 * Hook that tracks attention time on a content page.
 * Accumulates seconds while the page is visible/active, then batch-reports.
 */
export function useAttentionTracker(params: {
	creatorId: number | null;
	postId?: number | null;
	eventType: AttentionEvent["eventType"];
	active?: boolean; // defaults to true; set false to pause tracking
}) {
	const { creatorId, postId, eventType, active = true } = params;
	const { isAuthenticated: authStatus } = useAuth();
	const accumulatedRef = useRef(0);
	const lastCreatorRef = useRef(creatorId);

	// Keep module-level auth state in sync
	useEffect(() => {
		isAuthenticated = authStatus;
	}, [authStatus]);

	// Flush accumulated time into pending events
	const flushAccumulated = useCallback(() => {
		if (accumulatedRef.current > 0 && lastCreatorRef.current) {
			pendingEvents.push({
				creatorId: lastCreatorRef.current,
				postId: postId || null,
				eventType,
				durationSeconds: accumulatedRef.current,
			});
			accumulatedRef.current = 0;
		}
	}, [postId, eventType]);

	useEffect(() => {
		// If creator changed, flush old data
		if (lastCreatorRef.current !== creatorId) {
			flushAccumulated();
			lastCreatorRef.current = creatorId;
		}
	}, [creatorId, flushAccumulated]);

	useEffect(() => {
		if (!authStatus || !creatorId || !active) return;

		ensureFlushTimer();

		const tickTimer = setInterval(() => {
			// Only tick when page is visible
			if (document.visibilityState === "visible") {
				accumulatedRef.current += 1;
			}
		}, TICK_INTERVAL_MS);

		// Periodically flush accumulated to pending
		const localFlush = setInterval(flushAccumulated, FLUSH_INTERVAL_MS);

		return () => {
			clearInterval(tickTimer);
			clearInterval(localFlush);
			// Flush remaining on unmount
			flushAccumulated();
		};
	}, [authStatus, creatorId, active, flushAccumulated]);
}

/**
 * Report a one-shot attention event (e.g., page_view).
 */
export function reportAttention(event: AttentionEvent) {
	if (!isAuthenticated) return;
	pendingEvents.push(event);
	ensureFlushTimer();
}
