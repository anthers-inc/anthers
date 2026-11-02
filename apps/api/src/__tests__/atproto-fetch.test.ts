// SPDX-License-Identifier: Apache-2.0
/**
 * The address check in front of every fetch whose URL came from somebody else's document.
 *
 * The two failures that matter are the ones a URL string cannot show: a hostname that
 * resolves to a private address, and a redirect that moves a checked request somewhere
 * unchecked. The literal cases are here too, because they are the ones a reader will try.
 */
import { describe, expect, it } from "bun:test";
import { assertPublicUrl, fetchPublicUrl, isPrivateAddress } from "../lib/atproto-fetch";

describe("private addresses", () => {
	it("knows the v4 ranges a public URL must not reach", () => {
		for (const ip of [
			"127.0.0.1",
			"10.0.0.1",
			"172.16.0.1",
			"192.168.1.1",
			"169.254.169.254",
			"100.64.0.1",
			"0.0.0.0",
			"224.0.0.1",
		]) {
			expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: true });
		}
		expect(isPrivateAddress("8.8.8.8")).toBe(false);
	});

	it("knows the v6 ranges too", () => {
		for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1", "2001:db8::1"]) {
			expect({ ip, private: isPrivateAddress(ip) }).toEqual({ ip, private: true });
		}
		expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
	});
});

describe("assertPublicUrl", () => {
	it("refuses a link-local metadata address even in a dev checkout", async () => {
		await expect(
			assertPublicUrl(new URL("http://169.254.169.254/latest/meta-data")),
		).rejects.toThrow(/not public/);
	});

	it("refuses a private literal host before any connection", async () => {
		await expect(assertPublicUrl(new URL("https://10.0.0.1/repo"))).rejects.toThrow(/not public/);
	});
});

describe("fetchPublicUrl", () => {
	it("refuses a redirect rather than following it to an unchecked host", async () => {
		const fake = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: "http://169.254.169.254/" },
			})) as unknown as typeof fetch;
		await expect(
			fetchPublicUrl("https://pds.example/repo", {}, { fetchImpl: fake }),
		).rejects.toThrow(/redirect/);
	});

	it("refuses a body past the declared cap before reading it", async () => {
		const fake = (async () =>
			new Response("x", {
				status: 200,
				headers: { "content-length": "999999999" },
			})) as unknown as typeof fetch;
		await expect(
			fetchPublicUrl("https://pds.example/repo", {}, { fetchImpl: fake, maxBytes: 1024 }),
		).rejects.toThrow(/larger/);
	});
});
