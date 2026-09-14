// SPDX-License-Identifier: Apache-2.0
/**
 * Which AT Protocol servers this process may reach, and which directory it resolves identities in.
 *
 * 🛑 **Nothing a developer's machine or a test run does may write to the real network** — no
 * record in a real repository, no account on a real server, nothing a relay could pick up. A
 * record is world-readable the moment it lands, and an identity registered with `plc.directory`
 * is permanent: its log is append-only, and without the rotation key it cannot even be
 * tombstoned. So the rule is enforced here, at the two places a write leaves the hub, rather
 * than by remembering which URL a `.env` holds.
 *
 * ⚠️ **Every default in the ecosystem points at production, so a convention is not enough.** A
 * Personal Data Server not told which directory to use registers its accounts with
 * `plc.directory`, and a `.env` carrying production's server URL makes a local signup issue a
 * real identity. Both look exactly like local development from the inside.
 *
 * ⭐ **The test is what a host can be, not what a variable says.** A server on the real network
 * always has a public name. Loopback addresses and the special-use names that can never resolve
 * publicly — `.test`, `.invalid`, `.example` and `.localhost` — cannot be one, so a destination
 * on either list is safe by construction, whatever the configuration around it gets wrong.
 *
 * 🚨 **The restriction lifts only for a public deployment**, detected the way
 * {@link isPublicDeployment} detects it. That makes the refusal the answer an unset variable
 * falls into: a deployment that lost its origin stops writing to the network, loudly, rather
 * than a developer's machine starting to.
 *
 * ⚠️ **Reads are not restricted, and that is deliberate.** Resolving somebody's identity or
 * reading a public profile changes nothing anywhere, and the rule this module enforces is about
 * writes. What it cannot see is where a local server sends its own directory operations — that is
 * guaranteed by the local network the make targets start, whose directory lives in memory.
 */
import { isPublicDeployment } from "./deployment.js";

/** Names reserved so that they can never resolve on the public internet (RFC 2606, RFC 6761). */
const SPECIAL_USE_SUFFIXES = [".test", ".invalid", ".example", ".localhost"] as const;

/** The directory Anthers resolves `did:plc` identities in when nothing says otherwise. */
export const PRODUCTION_PLC_DIRECTORY = "https://plc.directory";

/** True when a URL's host can only ever be a machine local to this one, or a name that resolves nowhere. */
export function isOffNetworkUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	// `URL` keeps the brackets around an IPv6 literal in `hostname`.
	host = host.replace(/^\[(.*)\]$/, "$1");
	if (host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)) return true;
	return SPECIAL_USE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Why this process may not write to the server at `url`, or `null` when it may.
 *
 * The environment is injectable so the rule can be tested against a fixture rather than
 * against whatever this machine has in `.env`, as `isPublicDeployment` is.
 */
export function atprotoWriteRefusal(
	url: string,
	env: Record<string, string | undefined> = process.env,
): string | null {
	if (isPublicDeployment(env)) return null;
	if (isOffNetworkUrl(url)) return null;
	let origin = url;
	try {
		origin = new URL(url).origin;
	} catch {
		// Keep the raw value, so the message still says what was refused.
	}
	return (
		`refusing to write to ${origin}: this is not a public deployment, so it may only reach ` +
		"a local AT Protocol network (loopback, or a .test/.invalid/.example/.localhost name)"
	);
}

/**
 * The PLC directory identities are resolved in: `ATPROTO_PLC_URL`, or the production directory.
 *
 * A local network sets it to its own directory, because an identity created there exists nowhere
 * else. Reading the production directory from a developer's machine is harmless, which is why the
 * default can be the production one.
 */
export function plcDirectoryUrl(env: Record<string, string | undefined> = process.env): string {
	const configured = (env.ATPROTO_PLC_URL ?? "").trim().replace(/\/+$/, "");
	return configured || PRODUCTION_PLC_DIRECTORY;
}

const warned = new Set<string>();

/** Log a refusal once per process, so a misconfigured `.env` says so without flooding the log. */
export function warnRefusalOnce(refusal: string): void {
	if (warned.has(refusal)) return;
	warned.add(refusal);
	console.warn(`[atproto-network] ${refusal}`);
}
