// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `anthersp2p seed` — serve chunks of a Work you hold, to anyone the hub has vouched for.
 *
 * This is the first peer that can actually serve. Until it existed the swarm had no members:
 * the browser client asked `{t:"want"}` over a data channel and nothing anywhere answered,
 * so every byte came from the hub and the "P2P backend" was a verified download protocol
 * with one host.
 *
 * ── Why HTTP, and not WebRTC ────────────────────────────────────────────────────────
 *
 * WebRTC exists to get through NAT. A host that can accept an inbound connection — a VPS, a
 * seedbox, a box behind the outbound tunnel 42.07 already specifies for creator origins —
 * does not need hole-punching, and serving over HTTPS costs no new protocol, no native
 * module, and no TURN relay. TURN matters more than it looks: a TURN-relayed connection is
 * bytes **Anthers pays for**, which would quietly falsify 45.01 § 6's "swarm-served bytes
 * are free to both sides".
 *
 * WebRTC remains the answer for peers that *cannot* accept inbound — ordinary users behind
 * NAT — which 45.01 classes as "as soon as viable" rather than a launch requirement. This
 * serves the population that is a launch requirement: Anthers, and creators hosting their
 * own catalog.
 *
 * ── The URL shape is the hub's, deliberately ────────────────────────────────────────
 *
 * A seeder answers `GET /api/p2p/works/:workId/assets/:assetId/chunks/:index` with a Bearer
 * token — byte-for-byte the hub's own interface. So a client pointed at a peer is the hub
 * client with a different origin, and there is genuinely one download architecture rather
 * than one plus a peer dialect. It is also what makes this double as the origin daemon
 * milestones 2–3 need.
 *
 * ── Both sides check ────────────────────────────────────────────────────────────────
 *
 * The hub gates introduction; this independently verifies the presented token against the
 * hub's public key, fetched once over TLS. That is 45.03's boundary argument made real —
 * the swarm is *defined* by token verification, and a peer that doesn't verify isn't in it.
 * The verifier is `@anthers/shared/p2p-token`, the same code the hub runs, because two
 * implementations of one check is how the permissive one goes unnoticed.
 *
 * ── It refuses to start rather than serve the wrong bytes ───────────────────────────
 *
 * On boot it fetches the hub's manifest for the asset and verifies the local file against
 * it — size, every chunk hash, and the end-to-end digest. A seeder pointed at a stale build
 * or the wrong file would otherwise hand out bytes that fail every downloader's hash check,
 * looking to them like a hostile peer. Failing loudly at startup is the difference between
 * a misconfiguration and a mystery.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	chunkRange,
	type Manifest,
	Sha256Stream,
	sha256hex,
	totalChunks,
} from "@anthers/shared/p2p";
import { bearerFromHeader, verifyForAsset } from "@anthers/shared/p2p-token";
import { fetchManifest } from "./pull.js";

export interface SeedOptions {
	baseUrl: string;
	/** A session token, used ONCE at boot to fetch the manifest. Not needed to serve. */
	token: string;
	workId: string;
	assetId: number;
	filePath: string;
	port?: number;
	/** Skip the boot-time file verification. Documented as a foot-gun, not a convenience. */
	skipVerify?: boolean;
	fetchImpl?: typeof fetch;
	onLog?: (line: string) => void;
}

export interface Seeder {
	port: number;
	manifest: Manifest;
	stop(): void;
	/** Chunks served since boot — the peer-side half of 45.01 § 6's accounting. */
	served(): { chunks: number; bytes: number };
}

export class SeedError extends Error {}

/** Read one chunk off disk. Returns null past the end or on a short read. */
function readChunk(fd: number, offset: number, size: number): Uint8Array | null {
	const buf = Buffer.allocUnsafe(size);
	let read = 0;
	try {
		read = readSync(fd, buf, 0, size, offset);
	} catch {
		return null;
	}
	return read === size ? new Uint8Array(buf) : null;
}

/**
 * Verify the local file really is the asset the manifest describes.
 *
 * Streams a chunk at a time — a seeder is expected to hold multi-gigabyte files and must not
 * need multi-gigabyte memory to check one. Checks every chunk hash rather than only the
 * end-to-end digest, because a per-chunk failure names the corrupt region and the whole-file
 * hash only says "somewhere".
 */
export async function verifyLocalFile(
	fd: number,
	manifest: Manifest,
	onLog?: (line: string) => void,
): Promise<void> {
	const chunkSize = manifest.chunkSize;
	const count = totalChunks(manifest.assetSize, chunkSize);
	const digest = new Sha256Stream();

	for (let i = 0; i < count; i++) {
		const { offset, size } = chunkRange(i, chunkSize, manifest.assetSize);
		const bytes = readChunk(fd, offset, size);
		if (!bytes) {
			throw new SeedError(
				`Local file is short at chunk ${i} — expected ${manifest.assetSize} bytes total.`,
			);
		}
		if ((await sha256hex(bytes)) !== manifest.chunks[i]) {
			throw new SeedError(
				`Local file does not match the manifest at chunk ${i} (offset ${offset}). ` +
					"This is a different build or a corrupt copy; serving it would fail every downloader.",
			);
		}
		digest.update(bytes);
		if (count > 200 && i > 0 && i % Math.floor(count / 10) === 0) {
			onLog?.(`  verifying… ${Math.round((i / count) * 100)}%`);
		}
	}

	if (digest.digest() !== manifest.assetSha256) {
		throw new SeedError("Local file failed the end-to-end check against the manifest.");
	}
}

/**
 * Start seeding. Resolves once the file is verified and the server is listening.
 *
 * The session token is spent at boot and never again: serving authorizes on the *delivery*
 * token the downloader presents, which the hub minted. A seeder therefore holds no standing
 * credential it could leak beyond its own session, and needs no account of its own.
 */
export async function startSeeder(opts: SeedOptions): Promise<Seeder> {
	const log = opts.onLog ?? (() => {});
	const doFetch = opts.fetchImpl ?? fetch;

	const { manifest } = await fetchManifest({
		baseUrl: opts.baseUrl,
		token: opts.token,
		workId: opts.workId,
		assetId: opts.assetId,
		fetchImpl: opts.fetchImpl,
	});

	const pubRes = await doFetch(`${opts.baseUrl}/api/p2p/pubkey`);
	if (!pubRes.ok) throw new SeedError(`Could not fetch the hub's public key (${pubRes.status}).`);
	const { publicKey } = (await pubRes.json()) as { publicKey: string };
	if (!publicKey) throw new SeedError("The hub returned no public key.");

	const stat = statSync(opts.filePath);
	if (stat.size !== manifest.assetSize) {
		throw new SeedError(
			`Local file is ${stat.size} bytes; the manifest describes ${manifest.assetSize}.`,
		);
	}

	const fd = openSync(opts.filePath, "r");
	try {
		if (opts.skipVerify) {
			log("  ⚠ skipping local verification — a mismatched file will fail every downloader");
		} else {
			log(`  verifying ${manifest.chunks.length} chunks against the manifest…`);
			await verifyLocalFile(fd, manifest, log);
			log("  local file matches the manifest ✓");
		}
	} catch (err) {
		closeSync(fd);
		throw err;
	}

	const chunkSize = manifest.chunkSize;
	const count = totalChunks(manifest.assetSize, chunkSize);
	let servedChunks = 0;
	let servedBytes = 0;

	const expectedPath = `/api/p2p/works/${opts.workId}/assets/${opts.assetId}/chunks/`;

	const server = Bun.serve({
		port: opts.port ?? 8080,
		async fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === "/health") {
				return Response.json({
					status: "ok",
					workId: opts.workId,
					assetId: opts.assetId,
					chunks: count,
					served: { chunks: servedChunks, bytes: servedBytes },
				});
			}

			if (!url.pathname.startsWith(expectedPath)) {
				return new Response("Not found", { status: 404 });
			}

			const index = Number(url.pathname.slice(expectedPath.length));
			if (!Number.isInteger(index) || index < 0 || index >= count) {
				return new Response("Not found", { status: 404 });
			}

			// Both sides check. Same verifier the hub runs, against the hub's public key —
			// and `verifyForAsset` rather than a bare signature check, so a token minted for
			// a different asset cannot open this one.
			const token = bearerFromHeader(req.headers.get("Authorization"));
			if (!token) return new Response("Token required", { status: 401 });
			const payload = await verifyForAsset(token, publicKey, opts.assetId);
			if (!payload) return new Response("Invalid, expired, or wrong-asset token", { status: 401 });

			const { offset, size } = chunkRange(index, chunkSize, manifest.assetSize);
			const bytes = readChunk(fd, offset, size);
			if (!bytes) return new Response("Chunk unavailable", { status: 404 });

			// Re-hash before serving. The file was verified at boot, but it can be replaced
			// underneath a long-running seeder, and handing a downloader bytes that fail its
			// check makes this peer look hostile rather than stale.
			const hash = await sha256hex(bytes);
			if (hash !== manifest.chunks[index]) {
				return new Response("Chunk no longer matches the manifest", { status: 409 });
			}

			servedChunks++;
			servedBytes += size;

			return new Response(bytes as BodyInit, {
				status: 200,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(size),
					"X-Chunk-Index": String(index),
					"X-Chunk-Sha256": hash,
					"Cache-Control": "no-store",
					// The downloader is a browser on another origin, so it cannot read this
					// response without CORS. No credentials: the delivery token is a header
					// the client sets deliberately, not ambient authority.
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Expose-Headers": "X-Chunk-Index, X-Chunk-Sha256",
				},
			});
		},
	});

	return {
		port: server.port ?? opts.port ?? 8080,
		manifest,
		stop() {
			server.stop(true);
			closeSync(fd);
		},
		served: () => ({ chunks: servedChunks, bytes: servedBytes }),
	};
}
