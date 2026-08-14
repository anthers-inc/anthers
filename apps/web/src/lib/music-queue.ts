// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The listening queue — what should play, and in what order.
 *
 * Adapted from Garnet's `musicStore`, whose **order-index model** is the piece worth
 * stealing outright: `queue` holds the base track order and `order` is a *permutation of
 * indices into it*. Toggling shuffle rebuilds `order` while keeping the current track in
 * place, and repeat becomes a property of how you advance rather than a special case
 * threaded through every transition. The alternative — mutating the track array on shuffle
 * — loses the album's real order the moment anyone presses the button.
 *
 * This file is pure: no React, no audio element, no fetching. Everything here is a
 * function from one queue state to the next, which is what makes the awkward parts
 * (shuffle keeping its place, repeat wrapping, skipping what a listener cannot play)
 * testable without a browser — the same reason `services/access.ts` is pure.
 *
 * ## What Garnet has no answer for
 *
 * Garnet indexes a local filesystem: every track it lists, it can play. Anthers resolves
 * access per request, so **a queue can legitimately hold a track the listener turns out
 * not to own**. That is not an error state to prevent — an album with two free singles and
 * three gated tracks is a perfectly ordinary thing to press play on. It needs a behaviour,
 * and the behaviour is asymmetric on purpose:
 *
 *   - **Auto-advance skips it.** Ending track 2 and stopping dead on a gate the listener
 *     did not choose is the stall this exists to avoid.
 *   - **An explicit choice does not.** Clicking a locked track selects it and says why,
 *     because silently playing something *else* is worse than playing nothing.
 */

/** One entry in the queue. Everything the bar needs to render, decide and claim. */
export interface QueueTrack {
	workId: number;
	/** Canonical URL parts, for linking back to the Work page. */
	slug: string;
	publicId: number;
	title: string;
	/** Display name of the creator, for the bar's second line. */
	creator: string;
	creatorUsername: string | null;
	/** Whose Time Pool minutes this earns. Null suspends the claim. */
	creatorId: number | null;
	thumbnail: string | null;
	durationSeconds: number | null;
	waveform: number[] | null;
	/**
	 * The **audio delivery endpoint** for this Work — `/api/content/works/:id/audio`.
	 *
	 * 🚨 Not a signed CDN URL, and the difference is the whole of the delivery rule. That
	 * endpoint re-resolves access on every request and redirects to a short-lived signed
	 * URL, so holding *this* in a queue is safe however long the queue sits there: each
	 * play goes back through the check. Caching what it redirects to would be a pointer at
	 * the bytes that outlives the permission to have them.
	 *
	 * Null when this viewer cannot reach the track — the API withholds the URL rather than
	 * handing out one that would fail, so null IS the locked signal and needs no flag
	 * beside it that could disagree with it.
	 */
	src: string | null;
	/** Whether playing this draws the viewer's monthly Public Access allowance. */
	publicAccess: boolean;
	/** Untimestamped words, when the creator attached them and the viewer may see them. */
	lyrics: string | null;
}

export type RepeatMode = "off" | "all" | "one";

export interface QueueState {
	/** The base order — an album's real track order, never mutated by shuffle. */
	queue: QueueTrack[];
	/** A permutation of indices into `queue`. Play order. */
	order: number[];
	/** Position within `order`, or -1 when nothing is queued. */
	orderPos: number;
	shuffle: boolean;
	repeat: RepeatMode;
}

export const EMPTY_QUEUE: QueueState = {
	queue: [],
	order: [],
	orderPos: -1,
	shuffle: false,
	repeat: "off",
};

/** The track at the current position, or null. */
export function nowPlaying(s: QueueState): QueueTrack | null {
	if (s.orderPos < 0 || s.orderPos >= s.order.length) return null;
	return s.queue[s.order[s.orderPos]] ?? null;
}

/** Whether the listener can actually play this — see `QueueTrack.src`. */
export function isPlayable(track: QueueTrack | null | undefined): boolean {
	return !!track?.src;
}

function identityOrder(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

/**
 * A shuffled permutation of [0, n) with `first` at the front.
 *
 * `first` leads so that turning shuffle on continues from the track already playing
 * instead of jumping somewhere else mid-song — the behaviour every music player has and
 * nobody notices until it is missing.
 *
 * @param random Injected so the shuffle is testable. Production passes `Math.random`.
 */
export function shuffledOrder(
	n: number,
	first: number,
	random: () => number = Math.random,
): number[] {
	const rest: number[] = [];
	for (let i = 0; i < n; i++) if (i !== first) rest.push(i);
	for (let i = rest.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[rest[i], rest[j]] = [rest[j], rest[i]];
	}
	return [first, ...rest];
}

/**
 * Start a queue from a list of tracks, positioned at `startIndex`.
 *
 * `shuffle` and `repeat` carry over from the previous state, because they are the
 * listener's standing preferences rather than properties of the album they just opened.
 */
export function startQueue(
	prev: QueueState,
	tracks: QueueTrack[],
	startIndex = 0,
	options: { shuffle?: boolean; random?: () => number } = {},
): QueueState {
	const n = tracks.length;
	const shuffle = options.shuffle ?? prev.shuffle;
	if (n === 0) return { ...EMPTY_QUEUE, shuffle, repeat: prev.repeat };

	const idx = Math.max(0, Math.min(startIndex, n - 1));
	return {
		queue: tracks,
		order: shuffle ? shuffledOrder(n, idx, options.random) : identityOrder(n),
		// Shuffle puts the chosen track at the front of the new order, so position 0 is it.
		orderPos: shuffle ? 0 : idx,
		shuffle,
		repeat: prev.repeat,
	};
}

/** Turn shuffle on or off, keeping the current track exactly where it is. */
export function toggleShuffle(s: QueueState, random: () => number = Math.random): QueueState {
	const next = !s.shuffle;
	if (s.order.length === 0) return { ...s, shuffle: next };
	const currentIdx = s.order[s.orderPos];
	return next
		? { ...s, shuffle: true, order: shuffledOrder(s.queue.length, currentIdx, random), orderPos: 0 }
		: // Un-shuffling restores the album's order and puts the position back on the track
			// that is playing — which is exactly what `queue` never having been mutated buys.
			{ ...s, shuffle: false, order: identityOrder(s.queue.length), orderPos: currentIdx };
}

const REPEAT_CYCLE: RepeatMode[] = ["off", "all", "one"];

export function cycleRepeat(s: QueueState): QueueState {
	return { ...s, repeat: REPEAT_CYCLE[(REPEAT_CYCLE.indexOf(s.repeat) + 1) % REPEAT_CYCLE.length] };
}

/**
 * The next position in play order, or null when there is nowhere to go.
 *
 * @param skipUnplayable When advancing on its own — a track ending — step over anything
 *   the listener cannot play. A listener who *chose* a locked track gets to sit on it; a
 *   queue that stops dead on one they never picked is the stall.
 */
export function nextPosition(s: QueueState, skipUnplayable: boolean): number | null {
	if (s.order.length === 0) return null;
	// Walk at most one full lap. Without the bound, an all-locked queue on repeat-all
	// spins forever looking for something to play.
	for (let step = 1; step <= s.order.length; step++) {
		let pos = s.orderPos + step;
		if (pos >= s.order.length) {
			if (s.repeat !== "all") return null;
			pos %= s.order.length;
		}
		if (!skipUnplayable || isPlayable(s.queue[s.order[pos]])) return pos;
	}
	return null;
}

/** The previous position, or null. Never skips: going back is always deliberate. */
export function previousPosition(s: QueueState): number | null {
	if (s.order.length === 0) return null;
	if (s.orderPos > 0) return s.orderPos - 1;
	return s.repeat === "all" ? s.order.length - 1 : null;
}

/** Move to a position, ignoring one that isn't there. */
export function jumpTo(s: QueueState, pos: number): QueueState {
	if (pos < 0 || pos >= s.order.length) return s;
	return { ...s, orderPos: pos };
}

export function hasNext(s: QueueState): boolean {
	return nextPosition(s, false) !== null;
}

export function hasPrevious(s: QueueState): boolean {
	return previousPosition(s) !== null;
}

/** What is queued after the current track, in play order, with each one's position. */
export function upcoming(s: QueueState): { track: QueueTrack; pos: number }[] {
	if (s.orderPos < 0) return [];
	return s.order
		.slice(s.orderPos + 1)
		.map((qi, i) => ({ track: s.queue[qi], pos: s.orderPos + 1 + i }))
		.filter((e) => e.track != null);
}
