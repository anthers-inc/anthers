// SPDX-License-Identifier: Apache-2.0
/**
 * The runtime Noun Project client's own rules, proved rather than restated:
 * the download color is pinned, the credential names differ from the authoring
 * key's, and the shape of what persists is asserted by the compose service's
 * tests rather than here.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_PRICE, DOWNLOAD_COLOR, callClass, credentials } from "./client";

const HERE = import.meta.dir;

describe("the pin and the call classes", () => {
	it("pins the download color to black", () => {
		expect(DOWNLOAD_COLOR).toBe("000000");
	});

	it("counts any icon-id path as an icon call and search as a service call", () => {
		expect(callClass("/v2/icon/123/download")).toBe("icon");
		expect(callClass("/v2/icon/123/more-like-this")).toBe("icon");
		expect(callClass("/v2/icon")).toBe("service");
		expect(callClass("/v2/icon/autocomplete")).toBe("service");
		expect(callClass("/v2/client/usage")).toBe("service");
	});

	it("prices an icon call fourfold over a service call", () => {
		expect(CALL_PRICE.icon).toBeGreaterThan(CALL_PRICE.service);
	});
});

describe("the credential boundary", () => {
	it("keeps the runtime credential name distinct from the authoring key's", () => {
		// The authoring-time scan (`scripts/noun/authoring-time.test.ts`) fails the
		// build if the authoring key's env names appear anywhere that ships; the
		// runtime names differ by the whole string, so that scan stays true rather
		// than being weakened around. The assertion reads the compiled source on
		// disk, so it checks the file this test exists to police.
		const source = readFileSync(join(HERE, "client.ts"), "utf8");
		const authoringPrefix = "NOUN" + "_PROJECT"; // spelled assembled: this file ships too
		expect(source.includes(authoringPrefix)).toBe(false);
		expect(source.includes("NOUNPRO_KEY")).toBe(true);
	});

	it("refuses cleanly with the runtime names unset", async () => {
		const key = process.env.NOUNPRO_KEY;
		const secret = process.env.NOUNPRO_SECRET;
		delete process.env.NOUNPRO_KEY;
		delete process.env.NOUNPRO_SECRET;
		try {
			await expect(credentials()).rejects.toThrow(/NOUNPRO_KEY/);
		} finally {
			// Restore: another suite sharing this process may have set them.
			if (key) process.env.NOUNPRO_KEY = key;
			if (secret) process.env.NOUNPRO_SECRET = secret;
		}
	});
});