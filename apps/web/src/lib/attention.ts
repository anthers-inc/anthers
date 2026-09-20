// SPDX-License-Identifier: Apache-2.0
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
import { useShareToken } from "./share-link";

const TICK_MS = 1_000;
const FLUSH_INTERVAL_MS = 30_000;
/** The API caps a batch at 50 and a single range at MAX_RANGE_SECONDS (`routes/subscriptions.ts`). */
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
	/** The range's real window (epoch ms). Present on every timed event. */
	startedAt?: number;
	endedAt?: number;
	/** Stable per-range identity, so a retried flush is one range, never two. */
	clientId?: string;
	// The evidence at the time of the range, for the record.
	tabVisible?: boolean;
	elementVisible?: boolean;
	playing?: boolean;
	surface?: string;
	device?: string;
}

// ── Module state ─────────────────────────────────────────────────────────────

/** Live claims by registration id. */
const claims = new Map<number, AttentionClaim>();
/**
 * Fractional seconds earned per creator/post pair within the current open range.
 * A range opens when the pair starts earning and closes on pause, hide, idle,
 * unmount or flush — so the record is real time spent, not a duration total.
 */
const accrued = new Map<string, { claim: AttentionClaim; seconds: number }>();
/** The open range per claim pair: when this consecutive stretch of earning began. */
const openRanges = new Map<
	string,
	{
		claim: AttentionClaim;
		clientId: string;
		startedAt: number;
		// The latest evidence snapshot, carried into the closing record.
		tabVisible?: boolean;
		elementVisible?: boolean;
		playing?: boolean;
	}
>();
let pendingEvents: AttentionEvent[] = [];

let nextId = 1;
let ticker: ReturnType<typeof setInterval> | null = null;
let flusher: ReturnType<typeof setInterval> | null = null;
let lastInteractionAt = Date.now();
let isAuthenticated = false;
/**
 * The **share link** this page was reached by, if any.
 *
 * 🚨 **What this endpoint needs is an ATTRIBUTABLE claimant, not a logged-in one.** A
 * share-link recipient has no account; the seconds are attributed to whoever shared
 * the link, who does. So the flush below sends the token and the server decides whose month
 * pays — the browser never asserts an identity, it only says how it got here.
 */
let shareToken: string | null = null;
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
 * is a fixed share of what they give Anthers either way — but a different allocation of
 * their own share. That's a user pointing their own pool at a tab they left open,
 * which is a far smaller problem than fraud that mints seconds, and dropping
 * `mousemove` would under-credit the real case it exists for: someone reading a
 * screenful of long-form text for a minute without scrolling.
 *
 * ⚠️ Per-element visibility does NOT cover that case on its own. The IntersectionObserver
 * gate is ANDed with the idle gate in `isLive`, so a Work on screen still stops earning after
 * `IDLE_TIMEOUT_MS` with no interaction — `mousemove` is what keeps a still reader live.
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
			// Hidden: presence-mode claims stop earning, which the next tick sees as
			// dead keys and closes their ranges; flush what is closed.
			closeAllRanges();
			void flushEvents();
		}
	});
}

/** Close every open range (tab hiding, engine stopping) so no time is left open. */
function closeAllRanges() {
	const now = Date.now();
	for (const key of [...openRanges.keys()]) closeRange(key, now);
	// Drop accrued fractional remainders for keys whose range just closed.
	for (const [key] of accrued) accrued.delete(key);
}

// ── The ticker ───────────────────────────────────────────────────────────────

function tick() {
	const visible = typeof document === "undefined" || document.visibilityState === "visible";
	const msSinceInteraction = Date.now() - lastInteractionAt;
	const credited = creditableClaims([...claims.values()], { visible, msSinceInteraction });

	// Split the tick evenly across this tab's credited claims, as before. What changes
	// is what each claim does with its share: rather than accruing toward a whole-second
	// duration ping, a claim accumulates contiguous credited ticks into an OPEN RANGE.
	// Ranges from separate tabs and devices are split on the server, on read.
	const now = Date.now();
	const liveKeys = new Set(credited.map(claimKey));

	// Close any range whose claim stopped earning this tick (paused, hidden, idle,
	// unmounted) — a gap of even one tick ends the consecutive stretch.
	for (const [key, _range] of openRanges) {
		if (!liveKeys.has(key)) closeRange(key, now);
	}
	// Also close accrued entries for dead keys below, as before.
	for (const [key] of accrued) if (!liveKeys.has(key)) accrued.delete(key);

	if (credited.length === 0) return;
	const share = TICK_MS / 1_000 / credited.length;
	for (const claim of credited) {
		const key = claimKey(claim);
		if (!openRanges.has(key)) {
			openRanges.set(key, {
				claim,
				clientId:
					typeof crypto !== "undefined" && crypto.randomUUID
						? crypto.randomUUID()
						: `r-${now.toString(36)}-${Math.random().toString(36).slice(2)}`,
				startedAt: now,
				tabVisible: visible,
				elementVisible: claim.elementVisible,
				playing: claim.playing,
			});
		} else {
			const r = openRanges.get(key)!;
			// Keep the evidence current over the range's life.
			r.tabVisible = visible;
			r.elementVisible = claim.elementVisible;
			r.playing = claim.playing;
		}
		const entry = accrued.get(key);
		if (entry) {
			entry.claim = claim;
			entry.seconds += share;
		} else {
			accrued.set(key, { claim, seconds: share });
		}
	}
}

/**
 * Close the open range for a claim pair: what fractional time it actually earned
 * this stretch becomes the reported durationSeconds, and the range's real window
 * is [StartedAt, now]. A sub-second remainder that never reached a whole second
 * still closes the range — the split divides real time, and a 0.4s stretch is
 * still half of a contested 0.8s.
 */
function closeRange(key: string, endedAt: number) {
	const range = openRanges.get(key);
	if (!range) return;
	openRanges.delete(key);
	const entry = accrued.get(key);
	const seconds = entry ? entry.seconds : 0;
	accrued.delete(key);

	// Sub-tick or empty ranges (opened and closed within a second with less than a
	// tick's worth of credit) are noise the read side can never need; drop them.
	if (seconds < 0.5) return;

	pushEvent({
		creatorId: range.claim.creatorId,
		workId: range.claim.workId,
		eventType: eventTypeFor(range.claim.contentType),
		durationSeconds: Math.floor(seconds),
		startedAt: range.startedAt,
		endedAt,
		clientId: range.clientId,
		tabVisible: range.tabVisible,
		elementVisible: range.elementVisible,
		playing: range.playing,
		surface: currentSurface(),
		device: currentDevice(),
	});
}

/**
 * Which surface raised the claims — the coarse route family, for the record a
 * person reads back in their activity history. This is the pathname's first
 * segment rather than a route id, because a range should say "you were on a Work
 * page" and not enumerate routes.
 */
function currentSurface(): string {
	if (typeof window === "undefined") return "web";
	const first = window.location.pathname.split("/").filter(Boolean)[0];
	switch (first) {
		case "works":
			return "work";
		case "posts":
			return "post";
		case "library":
			return "library";
		case "studio":
			return "studio";
		default:
			return first ? `web:${first.slice(0, 32)}` : "web";
	}
}

/** Broad device class for the record: the desktop shell, or touch vs not. */
function currentDevice(): string {
	if (typeof navigator === "undefined") return "desktop";
	// The desktop shell names itself on `globalThis.__ANTHERS_DESKTOP__` (see rpc.ts).
	if ("__ANTHERS_DESKTOP__" in (window as object)) return "desktop-shell";
	return navigator.maxTouchPoints > 0 ? "mobile" : "desktop";
}

function pushEvent(event: AttentionEvent) {
	pendingEvents.push(event);
	if (pendingEvents.length > MAX_PENDING_EVENTS) {
		pendingEvents = pendingEvents.slice(-MAX_PENDING_EVENTS);
	}
}

async function flushEvents() {
	if ((!isAuthenticated && shareToken == null) || pendingEvents.length === 0) return;

	// Never send more than the endpoint accepts. Sending the whole backlog was a
	// permanent wedge: a batch over 50 is rejected, requeued, and rejected again.
	const batch = pendingEvents.splice(0, MAX_EVENTS_PER_REQUEST);
	try {
		const res = await client.api.subscriptions.attention.$post({
			// Sent only when there is one. A signed-in viewer's claim is theirs whatever link
			// they arrived by, and the server ignores a token beside a session anyway — but
			// sending one would say something untrue about what this request is.
			query: shareToken ? { share: shareToken } : {},
			json: {
				events: batch.map((e) => ({
					creatorId: e.creatorId,
					eventType: e.eventType,
					durationSeconds: e.durationSeconds,
					...(e.workId != null ? { workId: e.workId } : {}),
					// The range's real window and identity — present on every timed event,
					// omitted on zero-duration visit pings.
					...(e.startedAt != null ? { startedAt: e.startedAt } : {}),
					...(e.endedAt != null ? { endedAt: e.endedAt } : {}),
					...(e.clientId != null ? { clientId: e.clientId } : {}),
					...(e.tabVisible != null ? { tabVisible: e.tabVisible } : {}),
					...(e.elementVisible != null ? { elementVisible: e.elementVisible } : {}),
					...(e.playing != null ? { playing: e.playing } : {}),
					...(e.surface != null ? { surface: e.surface } : {}),
					...(e.device != null ? { device: e.device } : {}),
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
			// A long-lived range is flushed periodically rather than only at its end, so a
			// crash mid-session doesn't lose hours, and each flush closes and reopens the
			// range: the server's per-flush rows stay short, well under MAX_RANGE_SECONDS.
			closeAllRanges();
			void flushEvents();
		}, FLUSH_INTERVAL_MS);
	}
}

function stopEngineIfIdle() {
	if (claims.size > 0) return;
	closeAllRanges();
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
	// Read off the URL rather than plumbed through every player, because a claim is raised
	// from inside `VideoPlayer` and `AudioPlayer` as well as from the page. See `share-link.ts`
	// for why the token lives on the URL and nowhere more durable.
	const share = useShareToken();
	const idRef = useRef<number | null>(null);
	if (idRef.current === null) idRef.current = nextId++;

	useEffect(() => {
		isAuthenticated = authStatus;
		shareToken = share;
	}, [authStatus, share]);

	useEffect(() => {
		const id = idRef.current;
		if (id === null) return;

		// A share-link recipient is not signed in and their viewing still earns — for the
		// creator, out of the sharer's slice. That is the whole point of the exception: the
		// Time Pool cannot pay a creator for time it cannot attribute to anybody, and a
		// share link is what makes a stranger's minute attributable.
		const eligible =
			(authStatus || share != null) &&
			creatorId !== null &&
			active &&
			isTimePoolEligible(contentType);
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
	}, [authStatus, share, creatorId, workId, contentType, playing, active, elementRef]);
}

/**
 * Record a one-shot, zero-duration visit — an analytics signal that earns no
 * Time Pool minutes. This is what non-content surfaces use: a project page is a
 * shelf, not a work, so it registers the visit and earns nothing.
 */
export function useReportVisit(params: { creatorId: number | null; workId?: number | null }) {
	const { creatorId, workId = null } = params;
	const { isAuthenticated: authStatus } = useAuth();
	const share = useShareToken();
	const reportedRef = useRef<number | null>(null);

	useEffect(() => {
		isAuthenticated = authStatus;
		shareToken = share;
	}, [authStatus, share]);

	useEffect(() => {
		if (!authStatus || creatorId === null || reportedRef.current === creatorId) return;
		reportedRef.current = creatorId;

		pushEvent({ creatorId, workId, eventType: "page_view", durationSeconds: 0 });
		void flushEvents();
	}, [authStatus, creatorId, workId]);
}
