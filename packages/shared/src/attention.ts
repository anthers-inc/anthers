// SPDX-License-Identifier: AGPL-3.0-or-later
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
 *    Concurrent claims therefore *split* the tick rather than each taking it
 *    whole — see `creditableClaims`.
 *
 * What differs by media type is only the *evidence* we require before crediting
 * a second. Video and audio can legitimately be consumed passively (audio-only,
 * or a background tab while you work elsewhere), so playback alone is proof and
 * tab visibility is irrelevant. Text can't be consumed passively — someone has
 * to actually be there reading it — so it requires a visible tab plus a recent
 * sign of life.
 */

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
 * Consumption mode per content entity. Keys are `content_items.type` values plus
 * `text`, which is a post-native content element (`post_contents.kind = "text"`)
 * rather than a library item today. Physical goods and services are listings, not
 * works — nothing is consumed, so nothing accrues.
 */
const CONSUMPTION: Record<string, ConsumptionMode> = {
	video: "playback",
	audio: "playback",
	text: "presence",
	image: "presence",
	game: "presence",
	software: "presence",
	physical: "none",
	service: "none",
};

/** The attention event type recorded for each content entity. */
const EVENT_TYPE: Record<string, AttentionEventType> = {
	video: "watch",
	audio: "listen",
	text: "read",
	image: "read",
	game: "play",
	software: "play",
};

/** How a content entity is consumed. Unknown types are inert rather than free money. */
export function consumptionModeFor(contentType: string): ConsumptionMode {
	return CONSUMPTION[contentType] ?? "none";
}

/** The event type recorded for a content entity's attention. */
export function eventTypeFor(contentType: string): AttentionEventType {
	return EVENT_TYPE[contentType] ?? "page_view";
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

// ── The wall-clock clamp (server side) ───────────────────────────────────────

/**
 * The rolling window over which a user's credited seconds may not exceed elapsed
 * real seconds. One hour: long enough that ordinary batching and brief network
 * gaps never brush it, short enough that no one can bank idle time and spend it.
 */
export const CREDIT_WINDOW_SECONDS = 3_600;

/** Anything carrying a duration the clamp can trim. */
export interface CreditableEvent {
	durationSeconds: number;
}

export interface ClampResult<T> {
	/** The same events in the same order, with durations trimmed to fit the budget. */
	events: T[];
	/** Seconds actually credited. */
	granted: number;
	/** Seconds refused because the window was already full. */
	refused: number;
}

/**
 * Trim a batch of attention events so a user can never be credited more seconds
 * than have actually elapsed.
 *
 * Everything upstream of this is client-supplied and therefore advisory: the
 * browser splits ticks between concurrent claims, but it only sees one tab, and
 * a forged request sees nothing at all. This is the backstop that makes the
 * equal-time principle true rather than merely intended — five tabs, five
 * devices, or a hand-written `curl` all land against the same budget.
 *
 * Zero-duration events (visit pings) pass through untouched: they carry no time,
 * so they cannot over-credit, and they're the analytics signal for surfaces that
 * deliberately earn nothing.
 */
export function clampToWindow<T extends CreditableEvent>(
	events: T[],
	alreadyCreditedSeconds: number,
	windowSeconds: number = CREDIT_WINDOW_SECONDS,
): ClampResult<T> {
	let budget = Math.max(0, windowSeconds - Math.max(0, alreadyCreditedSeconds));
	let granted = 0;
	let refused = 0;

	const trimmed = events.map((event) => {
		const wanted = Math.max(0, event.durationSeconds);
		const give = Math.min(wanted, budget);
		budget -= give;
		granted += give;
		refused += wanted - give;
		return give === event.durationSeconds ? event : { ...event, durationSeconds: give };
	});

	return { events: trimmed, granted, refused };
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
