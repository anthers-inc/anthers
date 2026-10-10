// SPDX-License-Identifier: Apache-2.0
/**
 * The Bluesky door's landability guard (lib/bluesky-door.ts): behind the name proxy the round
 * trip's loopback landing is where the dev API does not sit, and the auth route refuses the
 * ceremony before it opens rather than letting it die after consent. The pure half is tested
 * with the probe injected; the route half runs the app as the e2e suites do.
 */
import { describe, expect, it } from "bun:test";
import { blueskyDoorRefusalFor, DOOR_LANDING } from "./bluesky-door.ts";

const PROBE = {
	notRunning: async (url: string) => url !== DOOR_LANDING,
	running: async () => true,
};

describe("the Bluesky door's landability", () => {
	it("opens with no proxy's name to answer on", async () => {
		expect(
			await blueskyDoorRefusalFor({ PORTLESS_URL: undefined }, PROBE.notRunning),
		).toBeUndefined();
	});

	it("refuses a proxy-served checkout whose loopback landing answers nothing", async () => {
		const refusal = await blueskyDoorRefusalFor(
			{ PORTLESS_URL: "https://signup-page.api.anthers.localhost" },
			PROBE.notRunning,
		);
		expect(refusal).toMatch(/127\.0\.0\.1:8000/);
		expect(refusal).toMatch(/PORTLESS=0/);
	});

	it("opens when something serves the landing, whatever it turns out to be", async () => {
		expect(
			await blueskyDoorRefusalFor(
				{ PORTLESS_URL: "https://signup-page.api.anthers.localhost" },
				PROBE.running,
			),
		).toBeUndefined();
	});
});
