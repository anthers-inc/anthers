// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * OAuth 1.0a signing, pinned to RFC 5849's own worked example.
 *
 * ⭐ **The base string is an EXTERNAL known answer, which is the only kind worth
 * having here.** A test that recomputes the signature the same way the code does
 * would pass on any self-consistent implementation, including a wrong one — and a
 * wrong one fails against a metered third-party API as an unexplained 401, which is
 * a slow and expensive way to learn about a percent-encoding bug. The vector below
 * is copied from RFC 5849 § 3.4.1.1 verbatim.
 *
 * ⚠️ **The RFC's printed `oauth_signature` is not reproducible** — that example does
 * not publish the secrets behind it — so the HMAC step is pinned separately to a
 * digest computed with `openssl dgst -sha1 -hmac`, independently of this code.
 */

import { describe, expect, it } from "bun:test";
import {
	authorizationHeader,
	baseUri,
	normalizeParams,
	pctEncode,
	sign,
	signatureBaseString,
} from "./oauth";

/** RFC 5849 § 3.4.1.1, with the document's display line-wrapping removed. */
const RFC_BASE_STRING =
	"POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q" +
	"%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_" +
	"key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_m" +
	"ethod%3DHMAC-SHA1%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk" +
	"9d7dh3k39sjv7";

/** The same request's parameters, decoded — query, body and oauth_* together. */
const RFC_PARAMS: [string, string][] = [
	["b5", "=%3D"],
	["a3", "a"],
	["c@", ""],
	["a2", "r b"],
	["c2", ""],
	["a3", "2 q"],
	["oauth_consumer_key", "9djdj82h48djs9d2"],
	["oauth_token", "kkk9d7dh3k39sjv7"],
	["oauth_signature_method", "HMAC-SHA1"],
	["oauth_timestamp", "137131201"],
	["oauth_nonce", "7d8f3e4a"],
];

describe("percent-encoding (RFC 5849 § 3.6)", () => {
	it("⭐ escapes the five characters encodeURIComponent wrongly spares", () => {
		// The built-in leaves these alone, and an apostrophe is exactly what turns up in
		// a search term. Getting this wrong signs a different string than it sends.
		expect(pctEncode("!'()*")).toBe("%21%27%28%29%2A");
	});

	it("leaves the unreserved set alone and encodes everything else uppercase", () => {
		expect(pctEncode("azAZ09-._~")).toBe("azAZ09-._~");
		expect(pctEncode("r b")).toBe("r%20b");
		expect(pctEncode("=%3D")).toBe("%3D%253D");
		expect(pctEncode("ü")).toBe("%C3%BC");
	});
});

describe("the signature base string", () => {
	it("🚨 matches RFC 5849 § 3.4.1.1 exactly", () => {
		expect(signatureBaseString("POST", "http://example.com/request?b5=%3D%253D", RFC_PARAMS)).toBe(
			RFC_BASE_STRING,
		);
	});

	it("does not depend on the order parameters are supplied in", () => {
		const shuffled = [...RFC_PARAMS].reverse();
		expect(signatureBaseString("POST", "http://example.com/request", shuffled)).toBe(
			RFC_BASE_STRING,
		);
	});

	it("sorts a repeated name by its encoded value — `a3=2 q` before `a3=a`", () => {
		// `%20` sorts before `a`, while a raw space sorts after it, so sorting the decoded
		// forms would order these the other way round and still look reasonable.
		expect(
			normalizeParams([
				["a3", "a"],
				["a3", "2 q"],
			]),
		).toBe("a3=2%20q&a3=a");
	});

	it("encodes the parameter string a second time as one component", () => {
		// The `%26` between pairs is the signature of the double encoding. A single-encoded
		// base string is the most common way to get this wrong and it still looks plausible.
		expect(
			signatureBaseString("GET", "https://example.com/x", [
				["a", "1"],
				["b", "2"],
			]),
		).toBe("GET&https%3A%2F%2Fexample.com%2Fx&a%3D1%26b%3D2");
	});
});

describe("the base string URI", () => {
	it("drops the query and fragment, and lowercases scheme and host", () => {
		expect(baseUri("HTTPS://API.ThenounProject.com/v2/icon?query=bee#x")).toBe(
			"https://api.thenounproject.com/v2/icon",
		);
	});

	it("drops a default port and keeps a non-default one", () => {
		expect(baseUri("https://example.com:443/a")).toBe("https://example.com/a");
		expect(baseUri("http://example.com:8080/a")).toBe("http://example.com:8080/a");
	});
});

describe("signing", () => {
	it("🚨 matches an independently computed HMAC-SHA1 digest", () => {
		// openssl dgst -sha1 -hmac 'j49sk3j29djd&dh893hdasih9' over RFC_BASE_STRING.
		expect(sign(RFC_BASE_STRING, "j49sk3j29djd", "dh893hdasih9")).toBe(
			"r6/TJjbCOr97/+UU0NsvSne7s5g=",
		);
	});

	it("⚠️ builds the key as `secret&tokenSecret`, separator and all", () => {
		// Two-legged is every request this repository makes, and dropping the `&` signs
		// correctly against nothing — a 401 that reads like a bad credential.
		expect(sign("x", "secret")).toBe(sign("x", "secret", ""));
		// The token secret genuinely participates, so the empty case is a real value rather
		// than an argument the implementation happens to ignore.
		expect(sign("x", "secret", "tok")).not.toBe(sign("x", "secret"));
		// And the `&` is placed rather than embedded: `a`+`b` must not sign as `a&b` would.
		expect(sign("x", "a", "b")).not.toBe(sign("x", "a&b"));
	});
});

describe("the Authorization header", () => {
	const header = authorizationHeader({
		method: "GET",
		url: "https://api.thenounproject.com/v2/icon?query=bee%20keeper",
		consumerKey: "key",
		consumerSecret: "secret",
		params: [["query", "bee keeper"]],
		nonce: "0123456789abcdef",
		timestamp: 1700000000,
	});

	it("carries the four required parameters and a signature", () => {
		expect(header).toStartWith("OAuth ");
		for (const k of [
			"oauth_consumer_key",
			"oauth_nonce",
			"oauth_signature_method",
			"oauth_timestamp",
			"oauth_signature",
		]) {
			expect(header).toContain(`${k}="`);
		}
	});

	it("⚠️ uses a nonce of at least eight characters, which the vendor requires", () => {
		const nonce = /oauth_nonce="([^"]+)"/.exec(
			authorizationHeader({
				method: "GET",
				url: "https://api.thenounproject.com/v2/client/usage",
				consumerKey: "key",
				consumerSecret: "secret",
			}),
		)?.[1];
		expect(nonce?.length ?? 0).toBeGreaterThanOrEqual(8);
	});

	it("percent-encodes the signature it puts in the header", () => {
		// A base64 signature routinely contains `+` and `/`, and an unencoded `+` is read
		// as a space by the server — an intermittent failure that depends on the nonce.
		expect(header).not.toMatch(/oauth_signature="[^"]*[+/]/);
	});

	it("signs the query parameters rather than ignoring them", () => {
		const other = authorizationHeader({
			method: "GET",
			url: "https://api.thenounproject.com/v2/icon?query=daisy",
			consumerKey: "key",
			consumerSecret: "secret",
			params: [["query", "daisy"]],
			nonce: "0123456789abcdef",
			timestamp: 1700000000,
		});
		expect(other).not.toBe(header);
	});
});
