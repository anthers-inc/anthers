// SPDX-License-Identifier: Apache-2.0
/**
 * A script's writer reaches the real network only when its caller says so.
 *
 * ⚠️ **The refusal is paired with two sessions that do make a request**, one to a local-only name
 * and one to a public-shaped name with the opt-in, so "nothing was requested" cannot pass merely
 * because nothing ever is. Neither name resolves anywhere, so a stub that failed to intercept could
 * still reach no real server.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readRecord, sessionWriter } from "./atproto-writer.js";

const realFetch = globalThis.fetch;
let requested: string[] = [];

beforeEach(() => {
	requested = [];
	globalThis.fetch = Object.assign(
		async (input: RequestInfo | URL) => {
			requested.push(String(input instanceof Request ? input.url : input));
			return new Response(JSON.stringify({ error: "AuthenticationRequired" }), { status: 401 });
		},
		{ preconnect: realFetch.preconnect },
	);
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

const CREDENTIALS = { identifier: "someone.test", password: "EXAMPLE-not-a-real-password" };
/** Shaped like a real server, and resolving nowhere. */
const PUBLIC_SHAPED = "https://pds.anthers-example-never-registered.com";

describe("opening a session from a script", () => {
	it("refuses a real server without the opt-in, before any request", async () => {
		await expect(sessionWriter({ service: "https://bsky.social", ...CREDENTIALS })).rejects.toThrow(
			"refusing to open a session on https://bsky.social",
		);
		await expect(
			readRecord({ service: PUBLIC_SHAPED, ...CREDENTIALS, collection: "x.y.z", rkey: "self" }),
		).rejects.toThrow("refusing");
		expect(requested).toEqual([]);
	});

	it("reaches a local server without asking", async () => {
		await expect(
			sessionWriter({ service: "https://pds.example", ...CREDENTIALS }),
		).rejects.toThrow();
		expect(requested.some((url) => url.startsWith("https://pds.example/"))).toBe(true);
	});

	it("reaches a real server when the caller opts in", async () => {
		await expect(
			sessionWriter({ service: PUBLIC_SHAPED, ...CREDENTIALS, realNetwork: true }),
		).rejects.not.toThrow("refusing");
		expect(requested.some((url) => url.startsWith(`${PUBLIC_SHAPED}/`))).toBe(true);
	});
});
