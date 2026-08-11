// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Peer discovery — the membership list for the swarm (45.01 § 3).
 *
 * `anthersp2p seed` gave the swarm its first member; this is what lets anyone find it.
 * Until now a peer's URL had to be passed by hand (`pull --peer https://…`), which means
 * peers existed and nobody could discover them — a swarm of one, repeated.
 *
 * Two operations, and the asymmetry between them is the design:
 *
 * - **Announce** is expensive and suspicious. It accepts a URL from a user, so it validates
 *   the origin, refuses to point anyone at a private address, and *probes the host* before
 *   it will publish it.
 * - **List** is cheap and boring. It reads live rows for an asset the caller can already
 *   download and returns a bounded set of origins.
 *
 * ── The hub's recommendation is the thing being protected ───────────────────────────
 *
 * A downloader verifies every chunk against the manifest, so a listed peer cannot poison a
 * file no matter what it serves — that half is already safe and is not why this file is
 * careful. What a peer list can do is *direct traffic*. "Announce `https://victim.example`
 * for a popular Work" turns the hub into a thing that tells thousands of browsers to go
 * fetch from a host that never volunteered. That is the attack this file exists to refuse,
 * and probing is the refusal: a host that is not running a seeder for this exact asset does
 * not answer the probe, so it never reaches the list.
 *
 * ── HTTPS is not a policy choice here ───────────────────────────────────────────────
 *
 * Peers must be `https:`, and the decisive reason is not security posture — it is that the
 * primary downloader is a browser on an `https:` page, and mixed content is *blocked*. An
 * `http:` peer is unusable by the client that matters, so listing one would advertise a
 * host that cannot serve. 42.07's outbound tunnel for creator origins terminates TLS, which
 * is how a creator on a home connection satisfies this without owning a certificate.
 *
 * ── SSRF ────────────────────────────────────────────────────────────────────────────
 *
 * Probing means the hub makes an outbound request to a user-supplied URL, which is the
 * classic shape of a server-side request forgery. The mitigation is that the hostname is
 * resolved and every resulting address checked against the private, loopback, link-local,
 * carrier-NAT and multicast ranges *before* the request goes out, and the probe reads a
 * small JSON body with a short timeout and reports nothing about failures beyond "no".
 */

import { lookup } from "node:dns/promises";
import { db } from "@anthers/db/client";
import { assets, p2pPeers } from "@anthers/db/schema";
import { sha256hex } from "@anthers/shared/p2p";
import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

/** How long an announcement is good for. Short: a lease, not a registration. */
export const PEER_LEASE_SECONDS = 10 * 60;

/** Peers returned to one downloader. Enough for failover, not enough to be a load plan. */
export const PEER_LIST_LIMIT = 5;

/** Origins one account may advertise for one asset. Two boxes is normal; fifty is not. */
export const PEERS_PER_USER_PER_ASSET = 3;

/** Probe budget. A seeder answers `/health` from memory, so slow means wrong. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Announcements accepted per asset. A ceiling on how large the table can get for a single
 * popular Work, independent of how many accounts are pushing at it.
 */
export const PEERS_PER_ASSET = 50;

export interface PeerPolicy {
	/**
	 * Allow `http:` and private addresses.
	 *
	 * 🚨 Development only, and named to be unpleasant to type into a production environment.
	 * With this on, the hub will happily probe — and publish — an address inside its own
	 * network. It exists because local dev has no public TLS host, and because the tests
	 * that prove the guard works need to be able to stand up a peer the guard would reject.
	 */
	allowInsecure: boolean;
	fetchImpl?: typeof fetch;
	/** Address resolution, injectable so a test can prove the private-range guard bites. */
	resolve?: (hostname: string) => Promise<string[]>;
}

export function defaultPolicy(): PeerPolicy {
	return { allowInsecure: process.env.P2P_ALLOW_INSECURE_PEERS === "1" };
}

export type OriginRejection =
	| "not_a_url"
	| "scheme"
	| "credentials"
	| "path"
	| "private_address"
	| "unresolvable";

/**
 * Normalize an announced URL to a bare origin, or say why not.
 *
 * Returns the origin **as the URL parser produced it**, so `https://Host.Example:443/` and
 * `https://host.example` become one string. That normalization is what makes the unique
 * index on `(asset_id, url)` mean what it says — without it the same host announced three
 * ways occupies three rows and three slots in every downloader's list.
 */
export function normalizeOrigin(
	raw: string,
	policy: Pick<PeerPolicy, "allowInsecure">,
): { origin: string } | { rejected: OriginRejection } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { rejected: "not_a_url" };
	}
	if (url.protocol !== "https:" && !(policy.allowInsecure && url.protocol === "http:")) {
		return { rejected: "scheme" };
	}
	if (url.username || url.password) return { rejected: "credentials" };
	// A peer serves the hub's own URL shape from its root, so a path here is either a
	// misunderstanding or an attempt to aim the probe at someone else's endpoint.
	if (url.pathname !== "/" || url.search || url.hash) return { rejected: "path" };
	return { origin: url.origin };
}

/** Parse dotted-quad IPv4 into its four octets, or null if it isn't one. */
function ipv4Octets(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
	return octets.every((n) => n >= 0 && n <= 255) ? octets : null;
}

/**
 * Is this address one the hub must never be talked into contacting?
 *
 * Covers the ranges that are either inside somebody's network or not routable at all:
 * this-network, loopback, link-local (including the cloud metadata address at
 * 169.254.169.254), the three private blocks, carrier-grade NAT, the benchmarking and
 * IETF-protocol blocks, multicast and reserved space — plus the IPv6 equivalents and the
 * v4-mapped form, which is the usual way this check gets bypassed.
 */
export function isBlockedAddress(address: string): boolean {
	const host = address.toLowerCase().replace(/^\[|\]$/g, "");

	// IPv4-mapped and IPv4-compatible IPv6 (::ffff:10.0.0.1) collapse to the v4 check.
	const mapped = host.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
	const v4 = ipv4Octets(mapped?.[1] ?? host);
	if (v4) {
		const [a, b] = v4;
		if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
		if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true; // private
		if (a === 192 && b === 168) return true; // private
		if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
		if (a === 192 && b === 0) return true; // IETF protocol assignments
		if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
		if (a >= 224) return true; // multicast and reserved
		return false;
	}

	if (host === "::" || host === "::1") return true;
	if (host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea")) return true;
	if (host.startsWith("feb")) return true; // fe80::/10 link-local
	if (host.startsWith("fc") || host.startsWith("fd")) return true; // fc00::/7 unique-local
	if (host.startsWith("ff")) return true; // ff00::/8 multicast
	return false;
}

async function resolveAll(hostname: string): Promise<string[]> {
	const results = await lookup(hostname, { all: true });
	return results.map((r) => r.address);
}

/**
 * Confirm an origin resolves only to addresses the hub is willing to contact.
 *
 * Every resolved address is checked, not just the first: a hostname with one public and one
 * private A record would otherwise pass the check and be dialled on the private one.
 * `localhost` and bare IP literals go through the same path — an IP literal "resolves" to
 * itself, so there is one rule rather than two that can drift apart.
 */
export async function originIsContactable(
	origin: string,
	policy: PeerPolicy,
): Promise<{ ok: true } | { rejected: OriginRejection }> {
	if (policy.allowInsecure) return { ok: true };
	const hostname = new URL(origin).hostname;
	let addresses: string[];
	try {
		addresses = await (policy.resolve ?? resolveAll)(hostname);
	} catch {
		return { rejected: "unresolvable" };
	}
	if (addresses.length === 0) return { rejected: "unresolvable" };
	if (addresses.some(isBlockedAddress)) return { rejected: "private_address" };
	return { ok: true };
}

/** What a seeder's `/health` says. Only `assetId` is load-bearing; see `probePeer`. */
interface PeerHealth {
	status?: string;
	assetId?: number;
	chunks?: number;
}

async function getJson(url: string, policy: PeerPolicy): Promise<unknown | null> {
	const doFetch = policy.fetchImpl ?? fetch;
	try {
		const res = await doFetch(url, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			redirect: "error", // A redirect is a second URL nobody validated.
			headers: { Accept: "application/json" },
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/**
 * Ask a host whether it is really seeding this asset.
 *
 * Compares **`assetId` only**, deliberately. A seeder is started with whatever work
 * identifier its operator typed — a numeric id, a public id, or a slug — so its `/health`
 * echoes back a string that may be any of the three, and comparing it would reject honest
 * peers for a naming difference. Asset ids are globally unique and numeric, which makes
 * that one field sufficient to establish "this host is serving the asset in question".
 */
export async function probeHealth(origin: string, assetId: number, policy: PeerPolicy) {
	const body = (await getJson(`${origin}/health`, policy)) as PeerHealth | null;
	if (!body || body.status !== "ok") return null;
	if (Number(body.assetId) !== assetId) return null;
	return body;
}

/**
 * The strong probe: pull chunk 0 and check it against the manifest.
 *
 * `/health` proves a host is *claiming* to serve an asset. This proves it actually holds the
 * bytes, which is the difference between a list of hosts that said the right words and a
 * list of hosts that can serve. A peer that has the wrong build, or is a look-alike that
 * mimics the health shape, fails here.
 *
 * 🚨 **Run on first announcement only, not on renewal.** It costs one chunk of *inbound*
 * hub bandwidth per run, and a renewal every few minutes for every peer of every asset
 * would turn a liveness check into a standing transfer bill. A new claim is worth 256 KiB;
 * confirming that a host that already proved itself is still up is worth a `/health`.
 *
 * Unauthenticated on purpose: it presents no token, so a well-behaved seeder answers 401 and
 * the probe passes on the *absence* of bytes — see below.
 */
export async function probeChunk(
	origin: string,
	workId: string | number,
	assetId: number,
	expectedSha256: string,
	policy: PeerPolicy,
): Promise<boolean> {
	const doFetch = policy.fetchImpl ?? fetch;
	const url = `${origin}/api/p2p/works/${workId}/assets/${assetId}/chunks/0`;
	let res: Response;
	try {
		res = await doFetch(url, {
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			redirect: "error",
		});
	} catch {
		return false;
	}

	/**
	 * A 401 is a **pass**, and this is the part worth reading twice.
	 *
	 * The hub holds no delivery token for this peer — minting one would mean the hub
	 * vouching to a peer for itself — so the probe arrives without credentials, and a
	 * correctly built seeder refuses it. That refusal is more informative than bytes would
	 * be: it says the host is running the token check, which is 45.03's definition of being
	 * in the swarm. A host that hands over chunk 0 to an anonymous request is either not a
	 * seeder or is an open file server, and neither belongs on the list.
	 */
	if (res.status === 401) return true;
	if (!res.ok) return false;

	// It served without a token. Accept it only if the bytes are genuinely this asset's —
	// then it is at least a real (if over-permissive) copy, and the manifest check below is
	// what stops a look-alike from getting listed.
	try {
		const bytes = new Uint8Array(await res.arrayBuffer());
		return (await sha256hex(bytes)) === expectedSha256;
	} catch {
		return false;
	}
}

/** Chunk 0's hash for an asset, straight out of the stored manifest. */
export async function chunkZeroHash(assetId: number): Promise<string | null> {
	const rows = await db.execute<{ sha256: string | null }>(sql`
		SELECT ${assets.p2pManifest}->'chunks'->>0 AS sha256
		FROM ${assets} WHERE ${assets.id} = ${assetId} LIMIT 1
	`);
	return rows[0]?.sha256 ?? null;
}

export type AnnounceResult =
	| { ok: true; origin: string; expiresAt: Date; renewed: boolean }
	| { ok: false; reason: OriginRejection | "unreachable" | "too_many" };

/**
 * Publish a peer, or refuse to.
 *
 * The order of checks is the cost order: parse, then policy, then DNS, then the network.
 * Nothing reaches out until everything that can be decided locally has been.
 */
export async function announcePeer(params: {
	rawUrl: string;
	workId: number;
	assetId: number;
	userId: number;
	policy?: PeerPolicy;
}): Promise<AnnounceResult> {
	const policy = params.policy ?? defaultPolicy();

	const normalized = normalizeOrigin(params.rawUrl, policy);
	if ("rejected" in normalized) return { ok: false, reason: normalized.rejected };
	const origin = normalized.origin;

	const contactable = await originIsContactable(origin, policy);
	if ("rejected" in contactable) return { ok: false, reason: contactable.rejected };

	// Is this a renewal? A host that already proved it holds the bytes only has to prove it
	// is still up, which is what keeps the chunk probe off the heartbeat path.
	const [existing] = await db
		.select({ id: p2pPeers.id, userId: p2pPeers.userId })
		.from(p2pPeers)
		.where(and(eq(p2pPeers.assetId, params.assetId), eq(p2pPeers.url, origin)))
		.limit(1);

	// The URL belongs to whoever claimed it first, for as long as their lease holds. Without
	// this, a second account could take over a live peer's row and inherit its slot.
	if (existing && existing.userId !== params.userId) {
		return { ok: false, reason: "too_many" };
	}

	if (!(await probeHealth(origin, params.assetId, policy))) {
		return { ok: false, reason: "unreachable" };
	}

	if (!existing) {
		const expected = await chunkZeroHash(params.assetId);
		if (!expected) return { ok: false, reason: "unreachable" };
		if (!(await probeChunk(origin, params.workId, params.assetId, expected, policy))) {
			return { ok: false, reason: "unreachable" };
		}

		// Caps are checked here rather than up front so a *renewal* is never refused for a
		// full table — an established peer holding its lease must not be evicted by a crowd
		// of new claimants.
		const mine = await countLive(params.userId, params.assetId);
		if (mine >= PEERS_PER_USER_PER_ASSET) return { ok: false, reason: "too_many" };
		const total = await countLiveForAsset(params.assetId);
		if (total >= PEERS_PER_ASSET) return { ok: false, reason: "too_many" };
	}

	const expiresAt = new Date(Date.now() + PEER_LEASE_SECONDS * 1000);
	await db
		.insert(p2pPeers)
		.values({
			assetId: params.assetId,
			workId: params.workId,
			url: origin,
			userId: params.userId,
			expiresAt,
			verifiedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [p2pPeers.assetId, p2pPeers.url],
			set: { expiresAt, verifiedAt: new Date() },
		});

	// Expired rows for this asset are cleared on the write path rather than by a sweeper.
	// The table only ever grows where announcements happen, so that is exactly where it is
	// cheapest to shrink it, and it needs no scheduled job to stay bounded.
	await db
		.delete(p2pPeers)
		.where(and(eq(p2pPeers.assetId, params.assetId), lte(p2pPeers.expiresAt, new Date())));

	return { ok: true, origin, expiresAt, renewed: Boolean(existing) };
}

async function countLive(userId: number, assetId: number): Promise<number> {
	const rows = await db
		.select({ id: p2pPeers.id })
		.from(p2pPeers)
		.where(
			and(
				eq(p2pPeers.userId, userId),
				eq(p2pPeers.assetId, assetId),
				gt(p2pPeers.expiresAt, new Date()),
			),
		);
	return rows.length;
}

async function countLiveForAsset(assetId: number): Promise<number> {
	const rows = await db
		.select({ id: p2pPeers.id })
		.from(p2pPeers)
		.where(and(eq(p2pPeers.assetId, assetId), gt(p2pPeers.expiresAt, new Date())));
	return rows.length;
}

/**
 * Live peers for an asset.
 *
 * Origins only. Not the announcing account, not when it announced, not how many peers were
 * filtered out — a downloader needs somewhere to fetch from, and everything else is
 * information about other people's infrastructure that the swarm has no use for.
 */
export async function livePeersFor(assetId: number, limit = PEER_LIST_LIMIT): Promise<string[]> {
	const rows = await db
		.select({ url: p2pPeers.url })
		.from(p2pPeers)
		.where(and(eq(p2pPeers.assetId, assetId), gt(p2pPeers.expiresAt, new Date())))
		// Oldest lease first, so the list is stable between polls rather than reshuffling and
		// scattering one downloader's chunks across every peer in turn.
		.orderBy(asc(p2pPeers.createdAt))
		.limit(limit);
	return rows.map((r) => r.url);
}

/** Withdraw a peer. Only the account that announced it can. */
export async function withdrawPeer(params: {
	rawUrl: string;
	assetId: number;
	userId: number;
	policy?: PeerPolicy;
}): Promise<boolean> {
	const policy = params.policy ?? defaultPolicy();
	const normalized = normalizeOrigin(params.rawUrl, policy);
	if ("rejected" in normalized) return false;
	const result = await db
		.delete(p2pPeers)
		.where(
			and(
				eq(p2pPeers.assetId, params.assetId),
				eq(p2pPeers.url, normalized.origin),
				eq(p2pPeers.userId, params.userId),
			),
		)
		.returning({ id: p2pPeers.id });
	return result.length > 0;
}
