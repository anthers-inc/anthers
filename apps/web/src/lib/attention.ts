// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Attention tracking — the browser half of Time Pool measurement.
 *
 * Surfaces register *claims* on the user's attention; a single module-level
 * ticker decides once a second which of them have earned that second, using the
 * pure policy in `@anthers/shared/attention`. Nothing here decides policy — this
 * file only supplies the evidence (visibility, idleness, playback) and batches
 * the result to the API.
 *
 * The single-ticker shape is load-bearing. When every hook ran its own interval,
 * no surface could see any other, so the mini-player and the post page both
 * billed the same second of the same track. Now they're two claims on one pair,
 * and the policy credits one of them.
 */

import {
	type AttentionClaim,
	claimKey,
	creditableClaims,
	eventTypeFor,
	isTimePoolEligible,
} from "@anthers/shared/attention";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { useEffect, useRef } from "react";

const TICK_MS = 1_000;
const FLUSH_INTERVAL_MS = 30_000;
/** The API caps a single event at 300s and a batch at 50 (`routes/subscriptions.ts`). */
const MAX_EVENT_SECONDS = 300;
const MAX_EVENTS_PER_REQUEST = 50;
/** Backstop so a long offline stretch can't grow the queue without bound. */
const MAX_PENDING_EVENTS = 500;

interface AttentionEvent {
	creatorId: number;
	postId?: number | null;
	eventType: ReturnType<typeof eventTypeFor>;
	durationSeconds: number;
}

// ── Module state ─────────────────────────────────────────────────────────────

/** Live claims by registration id. */
const claims = new Map<number, AttentionClaim>();
/** Fractional seconds earned per creator/post pair, awaiting a whole-second flush. */
const accrued = new Map<string, { claim: AttentionClaim; seconds: number }>();
let pendingEvents: AttentionEvent[] = [];

let nextId = 1;
let ticker: ReturnType<typeof setInterval> | null = null;
let flusher: ReturnType<typeof setInterval> | null = null;
let lastInteractionAt = Date.now();
let isAuthenticated = false;
let listenersBound = false;

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * What counts as a sign of life for presence-mode content.
 *
 * `mousemove` is the loose one — it's the only entry here that fires without
 * intent (a bumped desk, a drifting optical sensor, a mouse jiggler), so it does
 * defeat the idle gate. Kept deliberately, on this reasoning: presence mode also
 * requires a *visible* tab, so the jiggle has to happen on a foregrounded post,
 * and the server's wall-clock clamp means credited seconds can never exceed
 * elapsed ones. What a jiggler gains is therefore not more money — the Time Pool
 * is a fixed $1.50 per Anthers-Seed either way — but a different allocation of
 * their own share. That's a user pointing their own pool at a tab they left open,
 * which is a far smaller problem than fraud that mints seconds, and dropping
 * `mousemove` would under-credit the real case it exists for: someone reading a
 * screenful of long-form text for a minute without scrolling.
 *
 * The measurement that WOULD sharpen this is per-element visibility (today only
 * tab visibility is measured, so a post earns while its content is scrolled off
 * screen). That's a real change to how claims are registered — see the task
 * "Measure element visibility, not just tab visibility".
 */
const INTERACTION_EVENTS = [
	"pointerdown",
	"keydown",
	"scroll",
	"wheel",
	"touchstart",
	"mousemove",
] as const;

function markInteraction() {
	lastInteractionAt = Date.now();
}

function bindListeners() {
	if (listenersBound || typeof window === "undefined") return;
	listenersBound = true;

	for (const type of INTERACTION_EVENTS) {
		window.addEventListener(type, markInteraction, { passive: true });
	}
	// A tab returning to the foreground is itself a sign of life; without this a
	// user who left, came back, and read without touching anything would look idle.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") {
			markInteraction();
		} else {
			flushAccrued();
			void flushEvents();
		}
	});
}

// ── The ticker ───────────────────────────────────────────────────────────────

function tick() {
	const credited = creditableClaims([...claims.values()], {
		visible: typeof document === "undefined" || document.visibilityState === "visible",
		msSinceInteraction: Date.now() - lastInteractionAt,
	});
	if (credited.length === 0) return;

	// Split the tick evenly: a user's real second never becomes two credited
	// seconds, however many things are playing at once.
	const share = TICK_MS / 1_000 / credited.length;
	for (const claim of credited) {
		const key = claimKey(claim);
		const entry = accrued.get(key);
		if (entry) {
			entry.claim = claim;
			entry.seconds += share;
		} else {
			accrued.set(key, { claim, seconds: share });
		}
	}
}

/** Move whole accrued seconds into pending events, carrying the fraction forward. */
function flushAccrued() {
	const liveKeys = new Set([...claims.values()].map(claimKey));

	for (const [key, entry] of accrued) {
		const whole = Math.floor(entry.seconds);
		if (whole > 0) {
			entry.seconds -= whole;
			pushEvent({
				creatorId: entry.claim.creatorId,
				postId: entry.claim.postId,
				eventType: eventTypeFor(entry.claim.contentType),
				durationSeconds: Math.min(whole, MAX_EVENT_SECONDS),
			});
		}
		// Drop sub-second remainders for pairs nothing is claiming any more, so a
		// long browsing session doesn't accumulate dead keys.
		if (entry.seconds < 1 && !liveKeys.has(key)) accrued.delete(key);
	}
}

function pushEvent(event: AttentionEvent) {
	pendingEvents.push(event);
	if (pendingEvents.length > MAX_PENDING_EVENTS) {
		pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS);
	}
}

async function flushEvents() {
	if (!isAuthenticated || pendingEvents.length === 0) return;

	// Never send more than the endpoint accepts. Sending the whole backlog was a
	// permanent wedge: a batch over 50 is rejected, requeued, and rejected again.
	const batch = pendingEvents.splice(0, MAX_EVENTS_PER_REQUEST);
	try {
		const res = await client.api.subscriptions.attention.$post({
			json: {
				events: batch.map((e) => ({
					creatorId: e.creatorId,
					eventType: e.eventType,
					durationSeconds: e.durationSeconds,
					...(e.postId != null ? { postId: e.postId } : {}),
				})),
			},
		});
		if (!res.ok) pendingEvents.unshift(...batch);
	} catch {
		pendingEvents.unshift(...batch);
	}
}

function startEngine() {
	bindListeners();
	if (!ticker) ticker = setInterval(tick, TICK_MS);
	if (!flusher) {
		flusher = setInterval(() => {
			flushAccrued();
			void flushEvents();
		}, FLUSH_INTERVAL_MS);
	}
}

function stopEngineIfIdle() {
	if (claims.size > 0) return;
	flushAccrued();
	void flushEvents();
	if (ticker) {
		clearInterval(ticker);
		ticker = null;
	}
	if (flusher) {
		clearInterval(flusher);
		flusher = null;
	}
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Register one claim on the user's attention for as long as the component is
 * mounted and `active`.
 *
 * `contentType` is the *content entity* being consumed — a `content_items.type`
 * or `"text"` for a post-native text block. That's what decides both the
 * consumption mode and whether this earns anything at all: pages, profiles, and
 * other connective tissue have no content entity and so make no claim.
 */
export function useAttentionClaim(params: {
	creatorId: number | null;
	postId?: number | null;
	contentType: string;
	/** Required for playback-mode content (video/audio); ignored otherwise. */
	playing?: boolean;
	/** Set false to suspend the claim (e.g. the viewer can't access the post). */
	active?: boolean;
}) {
	const { creatorId, postId = null, contentType, playing, active = true } = params;
	const { isAuthenticated: authStatus } = useAuth();
	const idRef = useRef<number | null>(null);
	if (idRef.current === null) idRef.current = nextId++;

	useEffect(() => {
		isAuthenticated = authStatus;
	}, [authStatus]);

	useEffect(() => {
		const id = idRef.current;
		if (id === null) return;

		const eligible = authStatus && creatorId !== null && active && isTimePoolEligible(contentType);
		if (!eligible) {
			if (claims.delete(id)) stopEngineIfIdle();
			return;
		}

		claims.set(id, { creatorId, postId, contentType, playing });
		startEngine();

		return () => {
			claims.delete(id);
			stopEngineIfIdle();
		};
	}, [authStatus, creatorId, postId, contentType, playing, active]);
}

/**
 * Record a one-shot, zero-duration visit — an analytics signal that earns no
 * Time Pool minutes. This is what non-content surfaces use: a project page is a
 * shelf, not a work, so it registers the visit and earns nothing.
 */
export function useReportVisit(params: { creatorId: number | null; postId?: number | null }) {
	const { creatorId, postId = null } = params;
	const { isAuthenticated: authStatus } = useAuth();
	const reportedRef = useRef<number | null>(null);

	useEffect(() => {
		isAuthenticated = authStatus;
	}, [authStatus]);

	useEffect(() => {
		if (!authStatus || creatorId === null || reportedRef.current === creatorId) return;
		reportedRef.current = creatorId;

		pushEvent({ creatorId, postId, eventType: "page_view", durationSeconds: 0 });
		void flushEvents();
	}, [authStatus, creatorId, postId]);
}
