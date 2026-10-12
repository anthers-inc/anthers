// SPDX-License-Identifier: Apache-2.0
/**
 * The hover-preview gate and the one-active-tile store.
 *
 * The gate is the load-bearing half: these tests pin that a preview exists only
 * where a viewer could *open* the work — locked tiles and a spent meter stay
 * posters — and that only playback media previews at all. Break the gate to a
 * constant `true` and every verdict test below must fail; that is the stub the
 * suite was developed against.
 */

import { describe, expect, test } from "bun:test";
import type { PublicAccessBudget } from "@anthers/shared/public-access";
import type { AccessResult } from "@anthers/web-shared/types";
import {
	activeTilePreview,
	previewSourceFor,
	requestTilePreview,
	subscribeTilePreview,
	tilePreviewPlayable,
} from "./tile-preview";

const OPEN: AccessResult = {
	canAccess: true,
	reason: "free",
	isFree: true,
	requiresPurchase: false,
	price: null,
	isEntitled: false,
	streamEnabled: true,
	downloadEnabled: true,
};
const GATED: AccessResult = {
	canAccess: false,
	reason: "gated",
	isFree: false,
	requiresPurchase: false,
	price: null,
	isEntitled: false,
	streamEnabled: true,
	downloadEnabled: true,
	unlock: { creator: { threshold: 6, moreNeeded: 3, price: "6.00", badge: "Sprout" } },
};
const SPENT: PublicAccessBudget = {
	unlimited: false,
	usedSeconds: 3600,
	limitSeconds: 3600,
	remainingSeconds: 0,
	allowed: false,
};
const INTACT: PublicAccessBudget = {
	unlimited: false,
	usedSeconds: 1200,
	limitSeconds: 36000,
	remainingSeconds: 34800,
	allowed: true,
};

describe("tilePreviewPlayable", () => {
	test("previews playable, open video", () => {
		expect(tilePreviewPlayable({ type: "video", access: OPEN, budget: INTACT })).toBe(true);
	});

	test("previews the listened family", () => {
		expect(tilePreviewPlayable({ type: "music", access: OPEN, budget: INTACT })).toBe(true);
		expect(tilePreviewPlayable({ type: "audio", access: OPEN, budget: null })).toBe(true);
	});

	test("never previews a non-playback type", () => {
		expect(tilePreviewPlayable({ type: "physical", access: OPEN, budget: INTACT })).toBe(false);
		expect(tilePreviewPlayable({ type: "text", access: OPEN, budget: INTACT })).toBe(false);
	});

	test("a locked tile stays a poster", () => {
		expect(tilePreviewPlayable({ type: "video", access: GATED, budget: INTACT })).toBe(false);
	});

	test("a missing verdict stays a poster", () => {
		expect(tilePreviewPlayable({ type: "video", access: null, budget: INTACT })).toBe(false);
	});

	test("a spent Public Access meter stays a poster even on open work", () => {
		expect(tilePreviewPlayable({ type: "video", access: OPEN, budget: SPENT })).toBe(false);
	});

	test("an intact meter previews; no budget at all defers to the access verdict", () => {
		expect(tilePreviewPlayable({ type: "video", access: OPEN, budget: INTACT })).toBe(true);
		// A null budget means signed out or unlimited — signed out already fails
		// `canAccess`, so reaching here with a null budget is the unlimited case.
		expect(tilePreviewPlayable({ type: "video", access: OPEN, budget: null })).toBe(true);
	});
});

describe("previewSourceFor", () => {
	// The absolute-origin property (`apiBaseUrl()` prefixes the API host) is proven in
	// the browser, not here: with no `location`, the test environment's base is empty
	// and URLs come out page-relative — which is exactly the failure mode the
	// docblock warns against, so the test pins the endpoint shape and the test run
	// at `localhost:3000` pinned the wiring through the real API origin.
	test("video mints the access-checked HLS manifest path", () => {
		expect(previewSourceFor({ id: 42, type: "video" })).toContain("/api/content/works/42/hls/master.m3u8");
	});

	test("listened family mints the audio endpoint", () => {
		expect(previewSourceFor({ id: 7, type: "music" })).toContain("/api/content/works/7/audio");
		expect(previewSourceFor({ id: 9, type: "audio" })).toContain("/api/content/works/9/audio");
	});
});

describe("the one-active-tile store", () => {
	test("a requested key becomes the only active key", () => {
		requestTilePreview("a");
		expect(activeTilePreview()).toBe("a");
		requestTilePreview(null);
		expect(activeTilePreview()).toBe(null);
	});

	test("every listener hears each change", () => {
		const heard: (string | null)[] = [];
		const off = subscribeTilePreview((key) => heard.push(key));
		requestTilePreview("a");
		requestTilePreview("b");
		requestTilePreview(null);
		off();
		expect(heard).toEqual(["a", "b", null]);
	});

	test("re-requesting the active key is a no-op that notifies nobody", () => {
		let calls = 0;
		const off = subscribeTilePreview(() => {
			calls += 1;
		});
		requestTilePreview("a");
		requestTilePreview("a"); // The refresh case: confirming your own preview.
		expect(calls).toBe(1);
		off();
		requestTilePreview(null);
	});
});
