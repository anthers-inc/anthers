// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The browser P2P download client — milestone 10, hub-only first.
 *
 * A signed-in, entitled viewer asks for a Work's asset; this pulls it chunk by chunk,
 * verifies every chunk against the manifest and the finished file against `assetSha256`,
 * and hands back a Blob. The hub is the floor: with no peers at all, every chunk comes
 * from `/api/p2p/works/:id/assets/:assetId/chunks/:index` and the download simply works.
 * Peers are an optimisation layered on top, never a requirement.
 *
 * ── The shape, and why it is this shape ─────────────────────────────────────────────
 *
 * Everything that makes a decision is in here, and everything environmental is behind a
 * seam: bytes go through a `DownloadSink`, chunks come from `ChunkSource`s. That is what
 * makes the interesting half — scheduling, verification, token renewal, peer failover —
 * testable in Bun with no browser, no OPFS and no WebRTC, which is the only way these
 * paths get exercised at all. The same instinct as the signaling relay's `PeerRegistry`.
 *
 * ── Verification is not optional and not deferred ───────────────────────────────────
 *
 * Every chunk is hashed as it arrives and compared against `manifest.chunks[i]`, before it
 * is written. This matters far more here than on the CDN path: a chunk from a peer came
 * from a machine Anthers does not control, and the manifest is the only thing standing
 * between the swarm and a corrupted — or substituted — file. A peer that returns bytes
 * failing the hash is dropped and the chunk is refetched elsewhere.
 *
 * The end-to-end `assetSha256` is checked too, and **hashed incrementally as chunks are
 * written in order**, never by reading the finished file back. Reading it back would mean
 * holding a multi-gigabyte file in memory to verify that we successfully avoided holding
 * it in memory.
 *
 * ── The token is short-lived, and renewal is the client's job ───────────────────────
 *
 * A P2P token lives 15 minutes (45.05) and a large download does not. The client watches
 * the clock and re-mints from the manifest endpoint before expiry — and that endpoint
 * re-resolves access, so a revoked entitlement stops the download rather than merely
 * failing a chunk. A 401 mid-flight triggers the same renewal once, then gives up.
 */

import {
	CHUNK_SIZE,
	chunkRange,
	type Manifest,
	Sha256Stream,
	totalChunks,
	verifyChunk,
} from "@anthers/shared/p2p";
import { apiBaseUrl, apiFetch } from "../rpc.js";
import type { DownloadSink } from "./sink.js";

/** Renew this many seconds before the token actually lapses. */
const RENEW_MARGIN_SECONDS = 120;

/** How many chunks are in flight at once. */
const DEFAULT_CONCURRENCY = 4;

export interface ManifestResponse {
	manifest: Manifest;
	token: string;
}

/** A place chunks can be pulled from — the hub, or a peer. */
export interface ChunkSource {
	/** For logging and for reporting which sources carried the download. */
	readonly id: string;
	/** True while this source is usable. A source that fails verification goes false. */
	readonly healthy: boolean;
	/** Fetch one chunk. Returning null means "I can't serve this" — not an error. */
	fetchChunk(index: number, token: string): Promise<Uint8Array | null>;
	/** Called when this source hands back bytes that fail the manifest's hash. */
	markPoisoned?(): void;
}

export interface DownloadProgress {
	receivedBytes: number;
	totalBytes: number;
	chunksDone: number;
	chunksTotal: number;
	/** Bytes served by the hub, versus by peers — the 45.01 § 6 accounting split. */
	hubBytes: number;
	peerBytes: number;
}

export interface DownloadOptions {
	workId: number | string;
	assetId: number;
	sink: DownloadSink;
	/** Peer sources, if a swarm is available. Hub-only when empty — the supported floor. */
	peers?: ChunkSource[];
	concurrency?: number;
	onProgress?: (p: DownloadProgress) => void;
	signal?: AbortSignal;
}

export interface DownloadResult {
	manifest: Manifest;
	blob: Blob;
	hubBytes: number;
	peerBytes: number;
}

/** Raised when the bytes do not match what the manifest says they should be. */
export class IntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntegrityError";
	}
}

/** Raised when access is refused — at the start, or on a renewal mid-download. */
export class AccessError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccessError";
	}
}

/**
 * Fetch the manifest and mint a token. This is the access check: a denied viewer gets 403
 * here and never learns a chunk URL, which is the P2P form of the private-by-default
 * delivery rule (40.03, restated in 45.05).
 */
export async function fetchManifest(
	workId: number | string,
	assetId: number,
): Promise<ManifestResponse> {
	const res = await apiFetch(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
		method: "POST",
	});
	if (res.status === 403) throw new AccessError("You don't have access to this download.");
	if (!res.ok) throw new Error(`Could not start the download (${res.status}).`);
	return (await res.json()) as ManifestResponse;
}

/** Read the expiry out of a token without verifying it — the client cannot verify anyway. */
export function tokenExpiry(token: string): number {
	try {
		const [payloadB64] = token.split(".");
		const json = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
		const payload = JSON.parse(json) as { e?: number };
		return typeof payload.e === "number" ? payload.e : 0;
	} catch {
		// A token we cannot read is one we should renew immediately rather than trust.
		return 0;
	}
}

/**
 * The hub as a chunk source — always present, always the fallback.
 *
 * Never hand-rolls an API base URL: `apiBaseUrl()` is the one place that logic lives, and
 * seven per-file copies of it have been found and removed in this repo. The symptom is
 * always "works in dev, wrong origin in prod".
 */
export function hubSource(workId: number | string, assetId: number): ChunkSource {
	return {
		id: "hub",
		healthy: true,
		async fetchChunk(index, token) {
			const url = `${apiBaseUrl()}/api/p2p/works/${workId}/assets/${assetId}/chunks/${index}`;
			const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
			if (res.status === 401) throw new TokenExpired();
			if (!res.ok) return null;
			return new Uint8Array(await res.arrayBuffer());
		},
	};
}

/** Internal signal that the token lapsed mid-flight and the caller should renew once. */
class TokenExpired extends Error {}

/**
 * Pull an asset, verify it, and hand back the finished file.
 *
 * Chunks are fetched with bounded concurrency and may complete out of order, which the
 * sink accepts. The end-to-end hash cannot be computed out of order, so completed chunks
 * are drained **in index order** into the running digest as they become contiguous — the
 * one place ordering matters, and it costs a small window of held chunks rather than the
 * whole file.
 */
export async function downloadAsset(options: DownloadOptions): Promise<DownloadResult> {
	const { workId, assetId, sink, signal } = options;
	const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

	let { manifest, token } = await fetchManifest(workId, assetId);
	let expiresAt = tokenExpiry(token);

	const chunkCount = totalChunks(manifest.assetSize, manifest.chunkSize || CHUNK_SIZE);
	if (chunkCount !== manifest.chunks.length) {
		throw new IntegrityError(
			`Manifest is inconsistent: ${manifest.chunks.length} hashes for ${chunkCount} chunks.`,
		);
	}

	const hub = hubSource(workId, assetId);
	const peers = options.peers ?? [];
	const progress: DownloadProgress = {
		receivedBytes: 0,
		totalBytes: manifest.assetSize,
		chunksDone: 0,
		chunksTotal: chunkCount,
		hubBytes: 0,
		peerBytes: 0,
	};

	/** Renew before the token lapses. The endpoint re-resolves access, so this also revokes. */
	const ensureToken = async (): Promise<void> => {
		if (expiresAt - Date.now() / 1000 > RENEW_MARGIN_SECONDS) return;
		const renewed = await fetchManifest(workId, assetId);
		token = renewed.token;
		expiresAt = tokenExpiry(token);
		// The manifest is immutable per asset version (45.04), so a renewal that changes the
		// content hash means the asset was replaced underneath the download. Continuing would
		// splice two different files together and hand over something that never existed.
		if (renewed.manifest.assetSha256 !== manifest.assetSha256) {
			throw new IntegrityError("The file changed while it was downloading. Start again.");
		}
		manifest = renewed.manifest;
	};

	// The end-to-end digest, fed in index order as chunks become contiguous.
	//
	// `held` is the only thing this keeps in memory, and it holds ONLY chunks that have
	// arrived ahead of the digest cursor — bounded by how far out of order the workers can
	// get, which is bounded by `concurrency`. Four chunks, not four gigabytes. Anything
	// that accumulates per-chunk state without a bound like that has quietly reintroduced
	// the whole-file buffer this design exists to avoid.
	const digest = new Sha256Stream();
	const held = new Map<number, Uint8Array>();
	let digestCursor = 0;

	const drainInOrder = (): void => {
		while (held.has(digestCursor)) {
			const bytes = held.get(digestCursor) as Uint8Array;
			held.delete(digestCursor);
			digest.update(bytes);
			digestCursor++;
		}
	};

	const fetchOne = async (index: number): Promise<void> => {
		const { offset, size } = chunkRange(index, manifest.chunkSize, manifest.assetSize);
		const candidates: ChunkSource[] = [...peers.filter((p) => p.healthy), hub];

		for (const source of candidates) {
			if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
			await ensureToken();

			let bytes: Uint8Array | null;
			try {
				bytes = await source.fetchChunk(index, token);
			} catch (err) {
				if (err instanceof TokenExpired) {
					// The clock-based renewal missed — renew once and retry this source.
					expiresAt = 0;
					await ensureToken();
					bytes = await source.fetchChunk(index, token).catch(() => null);
				} else {
					bytes = null;
				}
			}

			if (!bytes || bytes.length !== size) continue;

			// Verify BEFORE writing. A peer is a machine Anthers does not control, and the
			// manifest is the only thing between the swarm and a substituted file.
			if (!(await verifyChunk(bytes, manifest, index))) {
				source.markPoisoned?.();
				continue;
			}

			await sink.write(offset, bytes);
			held.set(index, bytes);
			drainInOrder();

			progress.receivedBytes += size;
			progress.chunksDone++;
			if (source.id === "hub") progress.hubBytes += size;
			else progress.peerBytes += size;
			options.onProgress?.({ ...progress });
			return;
		}

		throw new Error(`No source could supply chunk ${index}.`);
	};

	// Bounded concurrency over a shared index cursor — simpler than batching, and it keeps
	// every worker busy instead of waiting on the slowest member of a batch.
	//
	// 🚨 **The window is what keeps `held` bounded, and without it this leaks.** Workers
	// race ahead independently, but the digest can only advance in order, so one slow chunk
	// at the cursor lets every other worker run on — and every chunk they complete stays in
	// `held` waiting for it. On a 20 GiB asset that is 81,920 chunks of nowhere to go: the
	// whole-file buffer, reintroduced by the back door, on exactly the path that exists to
	// avoid it. So a worker will not start a chunk more than `WINDOW` ahead of the cursor.
	// `held` is therefore capped at WINDOW × chunkSize — 16 MiB at these numbers — however
	// slow any one chunk turns out to be.
	const WINDOW = 64;
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, chunkCount) }, async () => {
		while (true) {
			const index = next++;
			if (index >= chunkCount) return;
			while (index - digestCursor >= WINDOW) {
				if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await fetchOne(index);
		}
	});

	try {
		await Promise.all(workers);
	} catch (err) {
		await sink.abort();
		throw err;
	}

	// End-to-end verification. Every chunk verified individually still does not prove the
	// file: a manifest whose chunk list is internally consistent but describes the wrong
	// composition would pass all of them. This is the check that the pieces make the whole.
	drainInOrder();
	if (held.size > 0 || digestCursor !== chunkCount) {
		await sink.abort();
		throw new IntegrityError("The download finished with chunks missing from the digest.");
	}
	if (digest.digest() !== manifest.assetSha256) {
		await sink.abort();
		throw new IntegrityError("The downloaded file failed its end-to-end check.");
	}

	const blob = await sink.finish();
	return { manifest, blob, hubBytes: progress.hubBytes, peerBytes: progress.peerBytes };
}

/**
 * Hand a finished download to the browser as an ordinary file save.
 *
 * `showSaveFilePicker` would write straight to a location the user chose, and is
 * Chromium-only — Firefox and Safari have not shipped it and are not marked as intending
 * to. So everyone gets the blob-URL route, which costs a second copy on disk while the
 * browser writes it out. That cost does not disappear on Chromium, it just arrives later,
 * which is why Desktop is the right answer for large Works rather than a fallback.
 */
export function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	// Revoked on the next tick: revoking synchronously can beat the download starting.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
