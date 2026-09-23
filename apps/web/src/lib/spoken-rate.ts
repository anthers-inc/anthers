// SPDX-License-Identifier: Apache-2.0
/**
 * The remembered playback speed for spoken audio, shared by the on-page spoken player
 * and the persistent bar.
 *
 * A podcast listener's rate is a preference, not a per-work choice, so it lives in
 * `localStorage` beside `anthers_media_volume` and applies to every spoken Work
 * thereafter. The bar honors it for any track whose `kind` is `"audio"`; music and
 * video stay at their recorded tempo.
 */
import { useState } from "react";

export const SPOKEN_RATE_KEY = "anthers_spoken_rate";

/** Playback speeds, slowest first. 1 is the identity and must stay in the list. */
export const SPOKEN_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export function readSpokenRate(): number {
	try {
		const stored = Number(localStorage.getItem(SPOKEN_RATE_KEY));
		return (SPOKEN_RATES as readonly number[]).includes(stored) ? stored : 1;
	} catch {
		return 1;
	}
}

export function writeSpokenRate(rate: number): void {
	try {
		localStorage.setItem(SPOKEN_RATE_KEY, String(rate));
	} catch {
		// A store that refuses the write simply forgets the preference, which is the
		// correct failure mode for a convenience.
	}
	// A `storage` event never fires in the tab that wrote, so the playing element learns
	// of the change through this — set from the bar mid-episode and the bar hears it now.
	// Guarded for the test runner, which has no window: a rate nobody can hear needs no
	// announcement.
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent(SPOKEN_RATE_EVENT, { detail: rate }));
	}
}

/** Dispatched on `window` when the remembered rate changes in this tab. */
export const SPOKEN_RATE_EVENT = "anthers:spoken-rate";

/** The current spoken rate with its setter — see the file comment for why it persists. */
export function useSpokenRate(): [number, (rate: number) => void] {
	const [rate, setRate] = useState<number>(readSpokenRate);
	return [
		rate,
		(next: number) => {
			setRate(next);
			writeSpokenRate(next);
		},
	];
}

/**
 * Step one notch through `SPOKEN_RATES`, clamping at the ends. Returns the rate it
 * landed on, so a caller can persist without re-reading state.
 */
export function stepSpokenRate(current: number, direction: 1 | -1): number {
	const rates = SPOKEN_RATES as readonly number[];
	const index = rates.includes(current) ? rates.indexOf(current) : rates.indexOf(1);
	const next = Math.max(0, Math.min(rates.length - 1, index + direction));
	return rates[next];
}
