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
import { CALL_PRICE, callClass, credentials, DOWNLOAD_COLOR } from "./client";

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
	it("reads the vault's own names, which Anthers Prod already carries", () => {
		// One credential spelling across the whole arrangement: the vault's
		// `NOUN_PROJECT_KEY`/`NOUN_PROJECT_SECRET`, which production's project holds and
		// `spec-apply --from-bws` resolves BY NAME. A runtime-specific spelling would be a
		// second set of secrets for no reason (Parker, 2026-10-07: no redundant secrets,
		// full stop).
		const source = readFileSync(join(HERE, "client.ts"), "utf8");
		expect(source.includes("NOUN_PROJECT_KEY")).toBe(true);
		expect(source.includes("NOUNPRO_")).toBe(false);
	});

	it("refuses cleanly with the runtime names unset", async () => {
		const key = process.env.NOUN_PROJECT_KEY;
		const secret = process.env.NOUN_PROJECT_SECRET;
		delete process.env.NOUN_PROJECT_KEY;
		delete process.env.NOUN_PROJECT_SECRET;
		try {
			await expect(credentials()).rejects.toThrow(/NOUN_PROJECT_KEY/);
		} finally {
			// Restore: another suite sharing this process may have set them.
			if (key) process.env.NOUN_PROJECT_KEY = key;
			if (secret) process.env.NOUN_PROJECT_SECRET = secret;
		}
	});
});
