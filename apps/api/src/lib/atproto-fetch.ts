// SPDX-License-Identifier: Apache-2.0
/**
 * Fetch a URL that came from somebody else's document — a DID's `#atproto_pds`, a PDS probe,
 * an exported repository — without letting it reach the private network.
 *
 * The three refusals are one rule seen from three sides: the scheme must be https (a dev
 * checkout may use http for its own loopback), the hostname must not be a private or
 * link-local literal, and a hostname must not *resolve* to one. The last is the important
 * one: a name the attacker controls can answer with `169.254.169.254` at fetch time even
 * though it looked public when the DID document was written, so the address is checked
 * immediately before the connection and the request follows no redirects — a 30x is a
 * second URL nobody validated.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isDevCheckout } from "@anthers/db/dev-only";

/** Documentation and test TLDs that deliberately never resolve; the suites use them. */
const RESERVED_SUFFIXES = [".example", ".invalid", ".test", ".localhost"];

function isLoopback(host: string): boolean {
	return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function inV4Range(ip: string): boolean {
	const [a, b] = ip.split(".").map(Number);
	if (![a, b].every(Number.isFinite)) return true;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/** Whether an address is private, loopback, link-local, CGNAT or otherwise not public. */
export function isPrivateAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return inV4Range(address);
	if (family !== 6) return true;
	const lower = address.toLowerCase();
	if (lower === "::1" || lower === "::") return true;
	if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
	if (lower.startsWith("ff")) return true;
	if (lower.startsWith("2001:db8")) return true;
	// An IPv4-mapped address is the v4 rule in a v6 spelling.
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
	if (mapped) return inV4Range(mapped[1]);
	return false;
}

/**
 * Refuse a URL whose scheme or host can reach something the public network should not.
 *
 * ⚠️ **A dev checkout allows its own loopback and nothing else.** The export and probe
 * suites run against local PDS fixtures at `http://127.0.0.1:…`, and the session's own
 * server is the legitimate case; a link-local metadata address is refused even there.
 */
export async function assertPublicUrl(url: URL): Promise<void> {
	const dev = isDevCheckout();
	if (url.protocol !== "https:" && !(dev && url.protocol === "http:")) {
		throw new Error("Only https URLs are fetched.");
	}
	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (dev && isLoopback(host)) return;
	if (isIP(host)) {
		if (isPrivateAddress(host)) throw new Error("That address is not public.");
		return;
	}
	if (RESERVED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return;
	const addresses = await lookup(host, { all: true, verbatim: true });
	if (addresses.length === 0) throw new Error("That host did not resolve.");
	for (const { address } of addresses) {
		if (isPrivateAddress(address)) throw new Error("That host resolves to a private address.");
	}
}

export interface PublicFetchOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
	/** Return a 3xx response instead of refusing it, for a caller that only reads the status. */
	allowRedirect?: boolean;
}

/** Fetch a public URL with the address check, no redirects, a timeout and a declared-size cap. */
export async function fetchPublicUrl(
	input: string | URL,
	init: RequestInit = {},
	opts: PublicFetchOptions = {},
): Promise<Response> {
	const url = new URL(input);
	await assertPublicUrl(url);
	const doFetch = opts.fetchImpl ?? fetch;
	const response = await doFetch(url, {
		...init,
		redirect: "manual",
		signal: init.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 10_000),
	});
	if (response.status >= 300 && response.status < 400 && !opts.allowRedirect) {
		await response.body?.cancel();
		throw new Error("A redirect from that host was refused.");
	}
	if (opts.maxBytes != null) {
		const declared = Number(response.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > opts.maxBytes) {
			await response.body?.cancel();
			throw new Error("That response is larger than the export accepts.");
		}
	}
	return response;
}

/** Read a response body, refusing once the actual bytes pass the cap. */
export async function readLimited(response: Response, maxBytes: number): Promise<Uint8Array> {
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error("That response is larger than the export accepts.");
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.byteLength;
	}
	return out;
}
