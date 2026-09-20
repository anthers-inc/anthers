// SPDX-License-Identifier: Apache-2.0
/**
 * Attention measurement — the model rules deciding which seconds become Time Pool
 * minutes. This module is the single source of truth for those rules and is pure
 * (no clock, no DOM, no I/O), so the whole policy is exhaustively testable without
 * a browser — the same shape as `services/access.ts`'s `resolveAccessSync`.
 *
 * Two principles drive everything here:
 *
 * 1. **Eligibility attaches to the content entity, not the page.** Only a post's
 *    *content elements* — the library-able entities a creator publishes — earn
 *    time. The connective tissue around them (post bodies, project pages,
 *    profiles, discovery, comments) earns nothing. A body-only announcement post
 *    is connective tissue and earns nothing.
 *
 * 2. **The equal-time principle: a minute is a minute.** Which means, read
 *    strictly, that a user's real minute can never become two credited minutes.
 *    Concurrent claims within a tab *split* the tick rather than each taking it
 *    whole — see `creditableClaims` — and ranges across tabs and devices are
 *    split on the server, on read — see `splitOverlappingRanges`.
 *
 * What differs by media type is only the *evidence* we require before crediting
 * a second. Video and audio can legitimately be consumed passively (audio-only,
 * or a background tab while you work elsewhere), so playback alone is proof and
 * tab visibility is irrelevant. Text can't be consumed passively — someone has
 * to actually be there reading it — so it requires a visible tab plus a recent
 * sign of life.
 */

import type { WorkType } from "./content.js";

/** The kind of evidence a content type needs before its seconds count. */
export type ConsumptionMode =
	/** Timed media: credits only while playing, visible or not. */
	| "playback"
	/** Attended content: credits only while the tab is visible and the user isn't idle. */
	| "presence"
	/** Not consumed at all (a listing, not a work) — never credits. */
	| "none";

/** The attention event types the API accepts (`attention_events.event_type`). */
export type AttentionEventType = "page_view" | "play" | "watch" | "read" | "listen";

/**
 * Consumption mode per Work type. Physical goods and services are listings, not works —
 * nothing is consumed, so nothing accrues.
 *
 * 🚨 **Keyed by `WorkType` so that a new type cannot compile without an entry.**
 * `consumptionModeFor` returns "none" for an unrecognized type, which makes it
 * Time-Pool-ineligible — the safe default (unknown types are inert rather than free money)
 * and the wrong answer for a real medium. A Work type missing here would earn its creator
 * nothing, with no error anywhere to say so.
 */
const CONSUMPTION: Record<WorkType, ConsumptionMode> = {
	video: "playback",
	music: "playback",
	audio: "playback",
	text: "presence",
	image: "presence",
	// A comic or a book is read, which is presence: visible tab plus a sign of life.
	// Turning pages supplies that naturally.
	comic: "presence",
	ebook: "presence",
	game: "presence",
	software: "presence",
	physical: "none",
	service: "none",
};

/** The attention event type recorded for each Work type that is consumed at all. */
const EVENT_TYPE: Record<Exclude<WorkType, "physical" | "service">, AttentionEventType> = {
	video: "watch",
	music: "listen",
	audio: "listen",
	text: "read",
	image: "read",
	comic: "read",
	ebook: "read",
	game: "play",
	software: "play",
};

/** How a content entity is consumed. Unknown types are inert rather than free money. */
export function consumptionModeFor(contentType: string): ConsumptionMode {
	return (CONSUMPTION as Record<string, ConsumptionMode>)[contentType] ?? "none";
}

/** The event type recorded for a content entity's attention. */
export function eventTypeFor(contentType: string): AttentionEventType {
	return (EVENT_TYPE as Record<string, AttentionEventType>)[contentType] ?? "page_view";
}

/** Whether time spent with this content entity can earn Time Pool minutes at all. */
export function isTimePoolEligible(contentType: string): boolean {
	return consumptionModeFor(contentType) !== "none";
}

/** How long without a sign of life before an attended claim stops crediting. */
export const IDLE_TIMEOUT_MS = 60_000;

/** A registered claim on the user's attention for one tick. */
export interface AttentionClaim {
	creatorId: number;
	/**
	 * The Work this claim is about. Null for surfaces that aren't a Work — a post, a
	 * profile, discovery — which earn nothing; part of the dedupe key either way.
	 */
	workId: number | null;
	contentType: string;
	/** Only consulted when the claim's mode is `playback`. */
	playing?: boolean;
	/**
	 * Whether the Work's deliverable element is on screen (IntersectionObserver).
	 * Only consulted by presence-mode claims — playback-mode content is legitimately
	 * consumed with nothing visible (audio in the mini-player, a background tab).
	 * Undefined means "not measured" and is treated as visible, so surfaces that
	 * don't pass an element ref (the players, the mini-player, tests) are unaffected.
	 */
	elementVisible?: boolean;
}

/** Everything about the user's state that the credit decision depends on. */
export interface AttentionContext {
	/** `document.visibilityState === "visible"`. */
	visible: boolean;
	/** Milliseconds since the last pointer/key/scroll/touch event. */
	msSinceInteraction: number;
}

// ── The union-timeline split (server side) ─────────────────────────────────

/**
 * One recorded range of attention, as the client reported it. The server splits
 * overlapping ranges on *read* rather than at intake, so the database holds ground
 * truth and the analysis method can change without losing information.
 */
export interface AttentionRange {
	/** The range's own server row id, or any unique identity the caller assigns. */
	id: number | string;
	/** UTC epoch milliseconds when the activity started (client-reported, server-bounded). */
	startedAt: number;
	/** UTC epoch milliseconds when the activity ended (client-reported, server-bounded). */
	endedAt: number;
}

/**
 * How far back in time a range may start, relative to when the server receives it.
 * A range can only arrive after it happened, so a start time earlier than this
 * could never have been covered by an honest flush — it is either a bug or a
 * forged request. Thirty minutes covers the worst honest case (a long offline
 * session draining a full queue of 30-second-cadence flushes) while keeping a
 * forged range from reaching back into settled history and re-splitting it.
 */
export const RANGE_LOOKBACK_SECONDS = 1_800;

/**
 * The longest a single reported range may run. Ten minutes is long enough that an
 * honest continuous session flushes several ranges within it, short enough that a
 * forged "I watched this all day" claim is bounded at intake.
 */
export const MAX_RANGE_SECONDS = 600;

/**
 * Split overlapping ranges so that every second of real elapsed time is credited
 * at most once, divided evenly among the ranges live in it.
 *
 * This is the read-side heart of the equal-time principle. The browser already
 * splits a tick between concurrent claims in one tab, but it only sees one tab;
 * the server is the only place every tab and every device are visible at once, so
 * the union timeline is built here. Five tabs, two devices, or a hand-written
 * request all draw on the same seconds — nothing a client sends can credit more
 * than one second per second of real time.
 *
 * Ranges are clipped to [windowStart, windowEnd] before splitting, so a range
 * straddling a meter boundary contributes only its in-window share. Returns
 * fractional seconds (they are split, not rounded) so callers sum exactly.
 *
 * Nothing is written back: the stored rows remain ground truth as reported, and
 * this function is the only place the derivative is computed.
 */
export function splitOverlappingRanges(
	ranges: AttentionRange[],
	windowStart: number,
	windowEnd: number,
): Map<number | string, number> {
	const credited = new Map<number | string, number>();
	if (ranges.length === 0 || windowEnd <= windowStart) return credited;

	// Clip every range to the window and drop whatever lands entirely outside it.
	const clipped: Array<{ id: number | string; start: number; end: number }> = [];
	for (const r of ranges) {
		const start = Math.max(r.startedAt, windowStart);
		const end = Math.min(r.endedAt, windowEnd);
		if (end > start) clipped.push({ id: r.id, start, end });
	}
	if (clipped.length === 0) return credited;

	// The union timeline: every boundary at which the live set changes.
	const boundaries = new Set<number>();
	for (const r of clipped) {
		boundaries.add(r.start);
		boundaries.add(r.end);
	}
	const points = [...boundaries].sort((a, b) => a - b);

	// Sweep adjacent boundary pairs. Within [points[i], points[i+1]) the live set is
	// constant, so that span divides evenly among however many ranges cover it.
	for (let i = 0; i + 1 < points.length; i++) {
		const spanStart = points[i] as number;
		const spanEnd = points[i + 1] as number;
		if (spanEnd <= spanStart) continue;
		const live = clipped.filter((r) => r.start <= spanStart && r.end >= spanEnd);
		if (live.length === 0) continue;
		const share = (spanEnd - spanStart) / 1_000 / live.length;
		for (const r of live) {
			credited.set(r.id, (credited.get(r.id) ?? 0) + share);
		}
	}

	return credited;
}

/** The dedupe key: one credit per creator/post pair per tick, never two. */
export function claimKey(claim: AttentionClaim): string {
	return `${claim.creatorId}:${claim.workId ?? "none"}`;
}

/** Whether this claim has the evidence its consumption mode requires, right now. */
function isLive(claim: AttentionClaim, ctx: AttentionContext): boolean {
	switch (consumptionModeFor(claim.contentType)) {
		case "playback":
			return claim.playing === true;
		case "presence":
			// Tab visible, the Work's deliverable is on screen (when measured), and
			// the user isn't idle. `elementVisible !== false` is the element-visibility
			// gate — undefined (not measured) reads as visible so unobserving surfaces
			// and tests stay unaffected. Playback-mode is exempt by the switch above.
			return (
				ctx.visible && claim.elementVisible !== false && ctx.msSinceInteraction < IDLE_TIMEOUT_MS
			);
		default:
			return false;
	}
}

/**
 * The claims that earn a share of this tick, at most one per creator/post pair.
 *
 * Playback beats presence on the same pair, which is what makes double-counting
 * structurally impossible: a track playing in the mini-player while the user sits
 * on that same post's page is one claim, not two, without either surface knowing
 * the other exists.
 *
 * Callers split the tick evenly across the returned claims — N concurrent claims
 * each earn `1/N` of a second, so a user's real second is never credited twice.
 */
export function creditableClaims(
	claims: AttentionClaim[],
	ctx: AttentionContext,
): AttentionClaim[] {
	const winners = new Map<string, AttentionClaim>();

	for (const claim of claims) {
		if (!isLive(claim, ctx)) continue;
		const key = claimKey(claim);
		const held = winners.get(key);
		if (!held) {
			winners.set(key, claim);
			continue;
		}
		// Same pair claimed twice — playback is the stronger evidence, so it wins.
		if (
			consumptionModeFor(held.contentType) === "presence" &&
			consumptionModeFor(claim.contentType) === "playback"
		) {
			winners.set(key, claim);
		}
	}

	return [...winners.values()];
}
