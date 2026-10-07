// SPDX-License-Identifier: Apache-2.0
/**
 * The play-token codec and the delivery-host guard — the two pieces of the build
 * surface that decide *who may hold an address and where it answers*.
 *
 * 🚨 **These are policy pieces, not plumbing, and the tests are the proof.** A token
 * that verified when it shouldn't would be a working address at a user the gate
 * refuses; a host check that admitted the bare domain would put first-party pages one
 * config line away from the delivery origin — the thing the PSL entry forbids
 * permanently. Both fail closed in every branch here, and each branch is exercised.
 */

import { describe, expect, it } from "bun:test";
import {
	buildDeliveryHost,
	buildPathProblem,
	isBuildDeliveryHost,
	mintPlayToken,
	verifyPlayToken,
} from "../lib/web-build.js";

const DEV_ENV = { NODE_ENV: "development" } as Record<string, string | undefined>;

describe("build path rules", () => {
	const bad: [string, string][] = [
		["", "empty"],
		["/abs.html", "leading slash"],
		["a/../b.js", "dot-dot climb"],
		["./a.js", "dot segment"],
		["dir\\win.js", "backslash"],
		["a?b.js", "question mark"],
		["a#b.js", "fragment"],
		["a%2Fb.js", "percent"],
		["a/%2e%2e/b.js", "encoded climb"],
		["a//b.js", "empty segment"],
		["trailing/", "trailing slash"],
		["\0x.js", "NUL"],
		[`${"a".repeat(251)}.js`, "too long"],
	];
	for (const [path, why] of bad) {
		it(`refuses ${why}`, () => {
			expect(buildPathProblem(path)).not.toBeNull();
		});
	}
	it("accepts a build's own relative path", () => {
		expect(buildPathProblem("index.html")).toBeNull();
		expect(buildPathProblem("assets/logo.png")).toBeNull();
		expect(buildPathProblem("AudioWorkletProcessor.js")).toBeNull();
	});
});

describe("play tokens", () => {
	it("mints and verifies round-trip", () => {
		const token = mintPlayToken(42, 3600, DEV_ENV);
		const payload = verifyPlayToken(token, DEV_ENV);
		expect(payload?.w).toBe(42);
		expect(payload?.exp).toBeGreaterThan(Date.now() / 1000);
	});

	it("refuses a token from a different key", () => {
		const token = mintPlayToken(42, 3600, DEV_ENV);
		// A different process's ephemeral key — the token does not travel.
		expect(
			verifyPlayToken(token, { ...DEV_ENV, WEB_BUILD_SIGNING_KEY: "another-key-material" }),
		).toBeNull();
	});

	it("refuses an expired token", () => {
		// Mint short-lived and step past it.
		const token = mintPlayToken(42, 1, DEV_ENV);
		expect(verifyPlayToken(token, DEV_ENV)).not.toBeNull();
		// A directly crafted expired payload: sign real bytes with a known key.
		const env = { ...DEV_ENV, WEB_BUILD_SIGNING_KEY: "test-key" };
		const expired = mintPlayToken(7, -10, env);
		expect(verifyPlayToken(expired, env)).toBeNull();
	});

	it("refuses a malformed or re-signed body", () => {
		const env = { ...DEV_ENV, WEB_BUILD_SIGNING_KEY: "test-key" };
		const token = mintPlayToken(42, 3600, env);
		// Tamper the payload body, keep the mac.
		const [body, mac] = token.split(".");
		const forged = `${Buffer.from(JSON.stringify({ w: 43, iat: 1, exp: Date.now() / 1000 + 600 })).toString("base64url")}.${mac}`;
		expect(verifyPlayToken(forged, env)).toBeNull();
		expect(verifyPlayToken("garbage", env)).toBeNull();
		expect(verifyPlayToken(`${body}.${mac.slice(0, -2)}xx`, env)).toBeNull();
		void body;
	});
});

describe("delivery host guard", () => {
	it("names a per-Work subdomain from the suffix", () => {
		const host = buildDeliveryHost(924832388, { BUILD_ORIGIN_SUFFIX: "anthers.run" });
		expect(host).toBe("924832388.anthers.run");
	});

	it("answers null without a suffix on a public deployment — the refusal, not a fallback", () => {
		expect(
			buildDeliveryHost(1, { NODE_ENV: "production", FRONTEND_URL: "https://anthers.org" }),
		).toBeNull();
	});

	it("checks hosts against the suffix, refusing the bare delivery domain", () => {
		const env = { BUILD_ORIGIN_SUFFIX: "anthers.run" };
		expect(isBuildDeliveryHost("924832388.anthers.run", env)).toBe(true);
		expect(isBuildDeliveryHost("anthers.run", env)).toBe(false);
		expect(isBuildDeliveryHost("evil-anthers.run", env)).toBe(false);
		expect(isBuildDeliveryHost("anthers.run.evil.test", env)).toBe(false);
		expect(isBuildDeliveryHost("api.anthers.org", env)).toBe(false);
	});

	it("serves any host in a checkout but none in production without a suffix", () => {
		expect(isBuildDeliveryHost("localhost:8000", DEV_ENV)).toBe(true);
		expect(
			isBuildDeliveryHost("anthers.org", {
				NODE_ENV: "production",
				FRONTEND_URL: "https://anthers.org",
			}),
		).toBe(false);
	});
});
