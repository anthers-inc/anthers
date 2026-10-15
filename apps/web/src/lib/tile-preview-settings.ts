// SPDX-License-Identifier: Apache-2.0
/**
 * The feed-tile preview preferences, remembered per install.
 *
 * Both are properties of *the browser*, not of the account — the same home the desktop
 * home and the remembered volume keep — so they live in `localStorage` beside them. The
 * settings page reads and writes them through this module's hooks, and the feed reads
 * them on every render, so a change takes effect the moment it is set, preview or no.
 *
 * ## Play previews as I browse (Parker, 2026-10-15)
 *
 * Defaults **on**, per the brief that called for the stop: inline hover playback is
 * the cursor's doing, and it stays that way by being stoppable rather than by being
 * forced. Turning it off returns every tile to its poster — see the gate in
 * `lib/tile-preview.ts`, which is the one function every tile's preview passes.
 *
 * ## Play audio on hover previews (Parker, 2026-10-15)
 *
 * Defaults **off**, holding the preview rule that nothing audible rides the cursor:
 * sound is the viewer's explicit gesture — the speaker button on a hovered video, or
 * this setting — never a hover's side effect. The setting is one, deliberately: the
 * button and the settings row flip the same remembered answer, so unmuting one hover
 * carries to the next. Sound follows the shared media volume
 * (`components/media/transport/volume.ts`), including its mute — a listener who muted
 * the site does not get sound back from a hover, and unmuting the players brings the
 * hover audio back. The listened family keeps its invisible muted preview: the ask
 * names videos, and an audible element under a poster band has no surface to explain
 * itself from.
 */

import { useSyncExternalStore } from "react";

const PREVIEWS_KEY = "anthers_tile_previews";
const AUDIO_KEY = "anthers_tile_preview_audio";

/** What is stored, or the first-visit default. Exported so it is testable alone. */
export function readStoredPreviews(): boolean {
	try {
		// Anything but the off mark is on: a missing key, a corrupted value and
		// unreadable storage all land on the default. `getItem` never throws here that
		// the catch would need to mean anyway.
		return localStorage.getItem(PREVIEWS_KEY) !== "0";
	} catch {
		// Storage disabled (private mode, a hardened browser): the default, which is on.
		return true;
	}
}

/**
 * What is stored for hover audio, or the first-visit default. Exported so it is
 * testable alone; the on mark is opt-in, so only a present `"1"` turns sound on.
 */
export function readStoredPreviewAudio(): boolean {
	try {
		return localStorage.getItem(AUDIO_KEY) === "1";
	} catch {
		// Storage disabled: the default, which is off.
		return false;
	}
}

let current: boolean = readStoredPreviews();
let currentAudio: boolean = readStoredPreviewAudio();
const listeners = new Set<() => void>();

function publish(): void {
	for (const fn of listeners) fn();
}

/** Write the preference through, so a later visit reads the same answer. */
export function setPreviewsEnabled(next: boolean): void {
	current = next;
	try {
		localStorage.setItem(PREVIEWS_KEY, next ? "1" : "0");
	} catch {
		// Unwritable storage costs persistence, not the setting — the same failure
		// mode the remembered volume keeps.
	}
	publish();
}

/** Write the audio preference through — the speaker button and the setting row call it. */
export function setPreviewAudio(next: boolean): void {
	currentAudio = next;
	try {
		localStorage.setItem(AUDIO_KEY, next ? "1" : "0");
	} catch {
		// Unwritable storage costs persistence, not the setting.
	}
	publish();
}

export function previewsEnabled(): boolean {
	return current;
}

export function previewAudio(): boolean {
	return currentAudio;
}

/** The store's change subscription, as an unsubscribe — the hooks register the readers. */
export function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** The current previews preference with live updates — setting it re-renders every reader. */
export function usePreviewsEnabled(): boolean {
	return useSyncExternalStore(subscribe, previewsEnabled);
}

/** The current hover-audio preference with live updates — the button and the row share it. */
export function usePreviewAudio(): boolean {
	return useSyncExternalStore(subscribe, previewAudio);
}
