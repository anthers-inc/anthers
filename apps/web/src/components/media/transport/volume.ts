// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One volume setting for the whole app, remembered between visits.
 *
 * Volume is a property of *the listener*, not of the element they happen to be pointed
 * at. A video that starts at 100% because the last thing you touched was the music bar
 * is the same defect as a music bar that starts at 100% after you turned a video down —
 * so both read this, and a change in either is a change in both.
 *
 * Same module-store shape as `lib/public-access.ts`, and for one of the same reasons: a
 * second player mounting mid-session has to arrive already agreeing with the first.
 *
 * ⚠️ **Muting is stored separately from the level, deliberately.** Mute-then-unmute has
 * to come back to the level you had, so mute cannot be "volume = 0" — that forgets it.
 */

import { useEffect, useState } from "react";

const VOLUME_KEY = "anthers_media_volume";
const MUTED_KEY = "anthers_media_muted";

export interface VolumeState {
	/** 0–1, the level to return to when unmuted. Never 0 by way of muting. */
	level: number;
	muted: boolean;
}

/** What the element should actually be set to. */
export function effectiveVolume(v: VolumeState): number {
	return v.muted ? 0 : v.level;
}

/** What is in storage, or the first-visit default. Exported so it is testable alone. */
export function readStoredVolume(): VolumeState {
	try {
		// 🚨 The emptiness check is the whole of this function's difficulty. `Number(null)`
		// is **0**, and so is `Number("")` and `Number("  ")` — all of which pass every
		// range test you would think to write. So the obvious `Number(getItem(...))` gives
		// a first-time visitor a remembered volume of *silent*, and every player on the
		// site opens muted with nothing logged and no error anywhere. It reads as "the
		// video has no sound", which is a content bug rather than a storage one, so it
		// sends you looking in the wrong file entirely.
		const stored = localStorage.getItem(VOLUME_KEY)?.trim();
		const raw = stored ? Number(stored) : Number.NaN;
		const level = Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 1;
		return { level, muted: localStorage.getItem(MUTED_KEY) === "1" };
	} catch {
		// Storage disabled (private mode, a hardened browser). Full volume, unmuted —
		// the same thing a first-time visitor gets, which is the honest fallback.
		return { level: 1, muted: false };
	}
}

let current: VolumeState | null = null;
const listeners = new Set<(v: VolumeState) => void>();

function publish(next: VolumeState) {
	current = next;
	try {
		localStorage.setItem(VOLUME_KEY, String(next.level));
		localStorage.setItem(MUTED_KEY, next.muted ? "1" : "0");
	} catch {
		/* Unwritable storage costs persistence, not the setting itself. */
	}
	for (const fn of listeners) fn(next);
}

/**
 * The shared volume, plus the two ways to change it.
 *
 * `setLevel` un-mutes as a side effect when the level is raised above zero, because
 * dragging a muted slider up and hearing nothing is the kind of dead control people
 * conclude is broken.
 */
export function useVolume(): {
	volume: VolumeState;
	effective: number;
	setLevel: (level: number) => void;
	toggleMuted: () => void;
} {
	const [volume, setVolume] = useState<VolumeState>(() => current ?? readStoredVolume());

	useEffect(() => {
		current ??= readStoredVolume();
		setVolume(current);
		listeners.add(setVolume);
		return () => {
			listeners.delete(setVolume);
		};
	}, []);

	return {
		volume,
		effective: effectiveVolume(volume),
		setLevel: (level) => {
			const clamped = Math.min(1, Math.max(0, level));
			publish({ level: clamped, muted: clamped === 0 ? volume.muted : false });
		},
		toggleMuted: () => publish({ ...volume, muted: !volume.muted }),
	};
}
