// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OAuth 1.0a request signing (RFC 5849) for the Noun Project Icon API.
//
// The API is TWO-LEGGED: a client key and secret sign every request and there is
// no access token, because no endpoint reaches a user's private data. That makes
// the token secret an empty string throughout — which still leaves the trailing
// "&" in the signing key, and dropping it is the classic way to get 401s that
// look like a bad credential.
//
// 🚨 THE PARAMETER STRING IS ENCODED TWICE, and every wrong implementation of
// this gets that wrong. Each name and value is percent-encoded, joined into
// `a=1&b=2`, and then the WHOLE joined string is percent-encoded again as one
// component of the base string. `signatureBaseString` is pinned to RFC 5849's own
// worked example in oauth.test.ts, so a change that breaks the double encoding
// fails there rather than as an unexplained 401 against a metered API.
//
// ⚠️ `encodeURIComponent` is NOT RFC 3986. It leaves `!'()*` unescaped, and the
// Noun Project's own search terms are exactly where an apostrophe shows up. Use
// `pctEncode` everywhere, never the built-in.

import { createHmac, randomBytes } from "node:crypto";

/**
 * Percent-encode per RFC 5849 § 3.6: everything except `A-Za-z0-9-._~`, in
 * uppercase hex.
 *
 * `encodeURIComponent` already emits uppercase hex and already leaves the four
 * unreserved punctuation marks alone; the five it wrongly spares are patched here.
 */
export function pctEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

/**
 * The base string URI: scheme and host lowercased, default port dropped, query
 * and fragment removed.
 *
 * The query is not lost — its parameters are signed through `params` instead,
 * which is what lets a signature cover them without depending on their order in
 * the URL.
 */
export function baseUri(url: string): string {
	const u = new URL(url);
	const scheme = u.protocol.slice(0, -1).toLowerCase();
	const defaultPort =
		(scheme === "http" && u.port === "80") || (scheme === "https" && u.port === "443");
	const port = u.port && !defaultPort ? `:${u.port}` : "";
	return `${scheme}://${u.hostname.toLowerCase()}${port}${u.pathname}`;
}

/**
 * The normalized parameter string: every name and value encoded, sorted by
 * encoded name and then by encoded value, joined with `&`.
 *
 * ⚠️ Sorting is over the ENCODED forms, not the raw ones, and the two orders
 * differ — `%20` sorts before `a` while a space sorts after it. Everything here
 * is ASCII once encoded, so JavaScript's string comparison is byte order.
 */
export function normalizeParams(params: [string, string][]): string {
	return params
		.map(([k, v]) => [pctEncode(k), pctEncode(v)] as const)
		.sort((a, b) =>
			a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1,
		)
		.map(([k, v]) => `${k}=${v}`)
		.join("&");
}

/** The string that gets signed: method, base URI and parameter string, each encoded. */
export function signatureBaseString(
	method: string,
	url: string,
	params: [string, string][],
): string {
	return [method.toUpperCase(), pctEncode(baseUri(url)), pctEncode(normalizeParams(params))].join(
		"&",
	);
}

/**
 * HMAC-SHA1 the base string with `secret&tokenSecret`, base64-encoded.
 *
 * ⚠️ The trailing `&` is required even with no token, which is the shape every
 * two-legged request takes. Passing the secret alone as the key signs correctly
 * against nothing and fails authentication with no useful message.
 */
export function sign(baseString: string, consumerSecret: string, tokenSecret = ""): string {
	const key = `${pctEncode(consumerSecret)}&${pctEncode(tokenSecret)}`;
	return createHmac("sha1", key).update(baseString).digest("base64");
}

export interface SigningOptions {
	method: string;
	/** The full URL including its query string; the query is re-signed from `params`. */
	url: string;
	consumerKey: string;
	consumerSecret: string;
	/** Query parameters, unencoded. These are signed alongside the oauth_* set. */
	params?: [string, string][];
	/** Fixed values for tests. Left out, a fresh nonce and the current time are used. */
	nonce?: string;
	timestamp?: number;
}

/**
 * Build the `Authorization: OAuth …` header for one request.
 *
 * ⚠️ **The nonce must be at least eight characters** — a Noun Project requirement
 * rather than an RFC one, and a short nonce is rejected with an error that names
 * the signature instead. Thirty-two hex characters is comfortably over.
 *
 * `oauth_version` is deliberately omitted: RFC 5849 makes it optional, and the
 * reference clients this API is documented against do not send it.
 */
export function authorizationHeader(options: SigningOptions): string {
	const oauth: [string, string][] = [
		["oauth_consumer_key", options.consumerKey],
		["oauth_nonce", options.nonce ?? randomBytes(16).toString("hex")],
		["oauth_signature_method", "HMAC-SHA1"],
		["oauth_timestamp", String(options.timestamp ?? Math.floor(Date.now() / 1000))],
	];
	const base = signatureBaseString(options.method, options.url, [
		...oauth,
		...(options.params ?? []),
	]);
	const signed: [string, string][] = [
		...oauth,
		["oauth_signature", sign(base, options.consumerSecret)],
	];
	return `OAuth ${signed.map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`).join(", ")}`;
}
