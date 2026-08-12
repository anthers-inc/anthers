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
	consumptionModeFor,
	creditableClaims,
	eventTypeFor,
	isTimePoolEligible,
} from "@anthers/shared/attention";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { type RefObject, useEffect, useRef } from "react";
import { publishBudget } from "./public-access";

const TICK_MS = 1_000;
const FLUSH_INTERVAL_MS = 30_000;
/** The API caps a single event at 300s and a batch at 50 (`routes/subscriptions.ts`). */
const MAX_EVENT_SECONDS = 300;
const MAX_EVENTS_PER_REQUEST = 50;
/** Backstop so a long offline stretch can't grow the queue without bound. */
const MAX_PENDING_EVENTS = 500;

// ── Element-visibility controls ──────────────────────────────────────────────
// Tuning dials for the IntersectionObserver that gates presence-mode claims on
// the Work's deliverable being on screen. Exposed as named constants (not inlined
// in the hook) so a future tuning pass can adjust them in one place without
// re-deriving the context. Same separation as the shared policy's IDLE_TIMEOUT_MS:
// these are mechanism (DOM-observer config), not rules — the policy only sees the
// boolean `elementVisible` that results.
//
// Playback-mode claims (video/audio) are exempt: audio in the mini-player is
// legitimately consumed with nothing visible, so the observer is only set up for
// presence-mode claims (text/image/game/software).

/**
 * IntersectionObserver threshold: the fraction of the deliverable element that must
 * be in the viewport to count as "visible". `0` means any pixel; `0.1` means 10%.
 *
 * Default `0` (any pixel) because the idle gate is the real protection against a
 * tab left open — element visibility is the first gate ("is it even possible
 * they're looking at it"), and any-pixel is the honest answer to that. The edge
 * case (1px sliver visible while reading comments below) is a 1-second over-credit
 * until the user scrolls that last pixel off, which is negligible. Raising this
 * risks penalizing long text Works whose 10% is more than a screenful.
 */
const ELEMENT_VISIBLE_THRESHOLD = 0;

/**
 * IntersectionObserver rootMargin, shrinks or grows the effective viewport.
 * `""` (default) uses the actual viewport. `"−50px 0px"` would require the element
 * to be 50px inside the viewport on top/bottom before counting, so edge slivers
 * don't count. Default empty because the idle gate covers "walked away"; the
 * threshold-default-of-0 edge case is negligible. Tune if real-user feedback shows
 * the sliver case is actually a problem.
 */
const ELEMENT_VISIBLE_ROOT_MARGIN = "";

interface AttentionEvent {
	creatorId: number;
	workId?: number | null;
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
 * Per-element visibility (the IntersectionObserver gating presence claims on the
 * deliverable being on screen) now covers that long-form-reading case directly —
 * `elementVisible: true` credits regardless of whether `mousemove` fires. So the
 * defense for keeping `mousemove` is weaker now than when it was written (2026-07-26).
 * Revisit whether to drop it as a separate decision; this is the note, not the change.
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
				workId: entry.claim.workId,
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
					...(e.workId != null ? { workId: e.workId } : {}),
				})),
			},
		});
		if (!res.ok) {
			pendingEvents.unshift(...batch);
			return;
		}

		/*
		 * The write answers with the Public Access budget **after** this batch, and this
		 * is the only place in the app that learns it in the ordinary course of watching.
		 *
		 * 🚨 That makes this line the meter's live signal, not a nicety: the flush that
		 * spends a viewer's last minute is the same flush that reports zero remaining, so
		 * publishing it here is what lets a player stop at the limit and *say so* rather
		 * than discovering it by having a segment request refused. Without it the first
		 * sign of the limit is a dead player.
		 */
		publishBudget(((await res.json()) as { publicAccess?: unknown }).publicAccess);
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
 *
 * `elementRef` is optional and only consulted by presence-mode claims. When
 * provided, an IntersectionObserver gates the claim on the element being on
 * screen, so a Work scrolled entirely off-screen stops earning even while the tab
 * is visible and the user is active (e.g. reading comments below it). Playback
 * claims (video/audio) are exempt — pass a ref or don't, it's ignored either way.
 */
export function useAttentionClaim(params: {
	creatorId: number | null;
	workId?: number | null;
	contentType: string;
	/** Required for playback-mode content (video/audio); ignored otherwise. */
	playing?: boolean;
	/** Set false to suspend the claim (e.g. the viewer can't access the Work). */
	active?: boolean;
	/** Ref to the deliverable element. Presence-mode only; gates the claim on the element being on screen. */
	elementRef?: RefObject<HTMLElement | null>;
}) {
	const { creatorId, workId = null, contentType, playing, active = true, elementRef } = params;
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

		// Presence-mode with an element ref: start visible (true) so the first tick
		// credits while the observer warms up, then let the observer correct it.
		// Playback-mode claims omit the ref; elementVisible is undefined → treated as
		// visible by the policy, which never consults it for playback anyway.
		const presence = consumptionModeFor(contentType) === "presence";
		claims.set(id, {
			creatorId,
			workId,
			contentType,
			playing,
			...(elementRef && presence ? { elementVisible: true } : {}),
		});
		startEngine();

		// IntersectionObserver for presence-mode claims with a ref. Mutates the stored
		// claim's `elementVisible` directly rather than re-running this effect, because
		// visibility changes on every scroll and re-running the effect that often is
		// wasteful and would churn the claim Map.
		let observer: IntersectionObserver | null = null;
		if (elementRef && presence && typeof IntersectionObserver !== "undefined") {
			observer = new IntersectionObserver(
				(entries) => {
					const entry = entries[0];
					if (!entry) return;
					const claim = claims.get(id);
					if (claim) claims.set(id, { ...claim, elementVisible: entry.isIntersecting });
				},
				{ threshold: ELEMENT_VISIBLE_THRESHOLD, rootMargin: ELEMENT_VISIBLE_ROOT_MARGIN },
			);
			if (elementRef.current) observer.observe(elementRef.current);
		}

		return () => {
			observer?.disconnect();
			claims.delete(id);
			stopEngineIfIdle();
		};
	}, [authStatus, creatorId, workId, contentType, playing, active, elementRef]);
}

/**
 * Record a one-shot, zero-duration visit — an analytics signal that earns no
 * Time Pool minutes. This is what non-content surfaces use: a project page is a
 * shelf, not a work, so it registers the visit and earns nothing.
 */
export function useReportVisit(params: { creatorId: number | null; workId?: number | null }) {
	const { creatorId, workId = null } = params;
	const { isAuthenticated: authStatus } = useAuth();
	const reportedRef = useRef<number | null>(null);

	useEffect(() => {
		isAuthenticated = authStatus;
	}, [authStatus]);

	useEffect(() => {
		if (!authStatus || creatorId === null || reportedRef.current === creatorId) return;
		reportedRef.current = creatorId;

		pushEvent({ creatorId, workId, eventType: "page_view", durationSeconds: 0 });
		void flushEvents();
	}, [authStatus, creatorId, workId]);
}
