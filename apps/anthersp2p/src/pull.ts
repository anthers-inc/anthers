// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `anthersp2p` puller — download an asset over the authenticated P2P protocol.
 *
 * This is the **open-client guarantee** made executable: the thing that turns "you can pull
 * your bytes without our permission" from a value statement into a property someone can
 * read the source and confirm. It talks to two published endpoints and verifies against a
 * published manifest format ([[45.04]]), and it imports nothing from `apps/api`.
 *
 * ── Why this re-implements the pull loop instead of reusing the browser engine ──────
 *
 * `packages/web-shared/src/lib/p2p/download.ts` does the same job for a browser tab, and
 * sharing it would look like the obvious de-duplication. It is the wrong seam. That engine
 * resolves its API origin through `apiBaseUrl()`, which reads `location` and returns `""`
 * off the web — and its whole sink layer exists to work around a browser's lack of a
 * filesystem, which is not a problem this process has.
 *
 * What must NOT be re-implemented is the **manifest format and its verification**, and that
 * is exactly what `@anthers/shared/p2p` holds: chunk layout, per-chunk hashing, the
 * incremental end-to-end digest. Two pull strategies are fine. Two definitions of what a
 * chunk is are not. This file is also the proof that the shared module is a real spec
 * surface rather than an internal convenience — if it were not, this CLI could not exist
 * outside the API.
 *
 * ── Verification is the point, not a nicety ─────────────────────────────────────────
 *
 * Every chunk is hashed and compared before it is written, and the finished file is checked
 * against `assetSha256`. A CLI that downloads without verifying would be a worse `curl`;
 * verifying is the entire reason the manifest exists.
 */

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import {
	CHUNK_SIZE,
	chunkRange,
	type Manifest,
	Sha256Stream,
	sha256hex,
	totalChunks,
} from "@anthers/shared/p2p";

export interface PullOptions {
	/** Hub origin, e.g. "https://anthers.org". No trailing slash. */
	baseUrl: string;
	/** A session token — the same opaque `sessions` row the desktop app carries. */
	token: string;
	workId: string;
	assetId: number;
	/** Where to write. The file is created or resumed in place. */
	outputPath: string;
	concurrency?: number;
	/** Re-verify existing bytes and skip chunks that already match. */
	resume?: boolean;
	onProgress?: (done: number, total: number, skipped: number) => void;
	fetchImpl?: typeof fetch;
}

export interface PullResult {
	manifest: Manifest;
	bytesWritten: number;
	chunksSkipped: number;
}

export class VerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VerificationError";
	}
}

export class AccessDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AccessDeniedError";
	}
}

/**
 * Fetch the manifest and mint a delivery token.
 *
 * This is the access check. A viewer without entitlement gets 403 here and never learns a
 * chunk URL — the same private-by-default rule the browser path follows, which is why a CLI
 * being "open" costs the access model nothing.
 */
export async function fetchManifest(
	opts: Pick<PullOptions, "baseUrl" | "token" | "workId" | "assetId" | "fetchImpl">,
): Promise<{ manifest: Manifest; token: string }> {
	const doFetch = opts.fetchImpl ?? fetch;
	const url = `${opts.baseUrl}/api/p2p/works/${opts.workId}/assets/${opts.assetId}/manifest`;
	const res = await doFetch(url, {
		method: "POST",
		headers: { Authorization: `Bearer ${opts.token}` },
	});
	if (res.status === 401) throw new AccessDeniedError("Not signed in — check your token.");
	if (res.status === 403) throw new AccessDeniedError("You don't have access to this asset.");
	if (!res.ok) throw new Error(`Could not fetch the manifest (HTTP ${res.status}).`);
	return (await res.json()) as { manifest: Manifest; token: string };
}

/** Seconds of token life below which it is re-minted rather than risked. */
const RENEW_MARGIN_SECONDS = 120;

function tokenExpiry(token: string): number {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8")) as {
			e?: number;
		};
		return typeof payload.e === "number" ? payload.e : 0;
	} catch {
		return 0;
	}
}

/**
 * Pull an asset to disk, verifying as it goes.
 *
 * Writes are positioned, so chunks may complete in any order — the file is opened once and
 * each chunk written at its own offset rather than appended. That is what makes resume and
 * concurrency possible at all, and it means a partial download on disk is a *prefix-correct*
 * file only by accident; the manifest is the authority on what is complete.
 */
export async function pullAsset(opts: PullOptions): Promise<PullResult> {
	const doFetch = opts.fetchImpl ?? fetch;
	const concurrency = opts.concurrency ?? 4;

	let { manifest, token } = await fetchManifest(opts);
	let expiresAt = tokenExpiry(token);

	const chunkSize = manifest.chunkSize || CHUNK_SIZE;
	const count = totalChunks(manifest.assetSize, chunkSize);
	if (count !== manifest.chunks.length) {
		throw new VerificationError(
			`Manifest is inconsistent: ${manifest.chunks.length} hashes for ${count} chunks.`,
		);
	}

	// "r+" needs the file to exist; fall back to creating it. Opening once and writing at
	// offsets is what lets chunks land out of order.
	let fd: number;
	try {
		fd = openSync(opts.outputPath, "r+");
	} catch {
		fd = openSync(opts.outputPath, "w+");
	}

	let bytesWritten = 0;
	let chunksSkipped = 0;
	const present = new Array<boolean>(count).fill(false);

	try {
		// Resume: hash what is already on disk and skip chunks that already match. This is
		// what makes an interrupted 20 GiB download cost minutes rather than starting over,
		// and it is safe precisely because every chunk is content-addressed.
		if (opts.resume) {
			for (let i = 0; i < count; i++) {
				const { offset, size } = chunkRange(i, chunkSize, manifest.assetSize);
				const buf = Buffer.allocUnsafe(size);
				let read = 0;
				try {
					read = readSync(fd, buf, 0, size, offset);
				} catch {
					read = 0;
				}
				if (read !== size) continue;
				if ((await sha256hex(new Uint8Array(buf))) === manifest.chunks[i]) {
					present[i] = true;
					chunksSkipped++;
				}
			}
		}

		let next = 0;
		let completed = chunksSkipped;

		const ensureToken = async (): Promise<void> => {
			if (expiresAt - Date.now() / 1000 > RENEW_MARGIN_SECONDS) return;
			const renewed = await fetchManifest(opts);
			// The manifest is immutable per asset version (45.04). A changed content hash
			// means the asset was replaced mid-download, and continuing would splice two
			// different files together.
			if (renewed.manifest.assetSha256 !== manifest.assetSha256) {
				throw new VerificationError("The asset changed while downloading. Start again.");
			}
			token = renewed.token;
			expiresAt = tokenExpiry(token);
			manifest = renewed.manifest;
		};

		const worker = async (): Promise<void> => {
			while (true) {
				const index = next++;
				if (index >= count) return;
				if (present[index]) continue;

				const { offset, size } = chunkRange(index, chunkSize, manifest.assetSize);
				await ensureToken();

				const url = `${opts.baseUrl}/api/p2p/works/${opts.workId}/assets/${opts.assetId}/chunks/${index}`;
				const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
				if (res.status === 401) {
					// The clock-based renewal missed. Re-mint once and retry this chunk.
					expiresAt = 0;
					await ensureToken();
					next = Math.min(next, index);
					continue;
				}
				if (!res.ok) throw new Error(`Chunk ${index} unavailable (HTTP ${res.status}).`);

				const bytes = new Uint8Array(await res.arrayBuffer());
				if (bytes.length !== size) {
					throw new VerificationError(`Chunk ${index} is ${bytes.length} bytes, expected ${size}.`);
				}
				// Verify BEFORE writing. Once a bad chunk is on disk it is indistinguishable
				// from a good one without re-hashing the whole file.
				if ((await sha256hex(bytes)) !== manifest.chunks[index]) {
					throw new VerificationError(`Chunk ${index} failed its hash check.`);
				}

				writeSync(fd, bytes, 0, size, offset);
				bytesWritten += size;
				present[index] = true;
				completed++;
				opts.onProgress?.(completed, count, chunksSkipped);
			}
		};

		await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));

		// End-to-end verification, read back one chunk at a time so a multi-gigabyte file is
		// never resident. Per-chunk hashes prove each piece; only this proves the whole.
		const digest = new Sha256Stream();
		for (let i = 0; i < count; i++) {
			const { offset, size } = chunkRange(i, chunkSize, manifest.assetSize);
			const buf = Buffer.allocUnsafe(size);
			const read = readSync(fd, buf, 0, size, offset);
			if (read !== size) {
				throw new VerificationError(`Short read verifying chunk ${i}: ${read} of ${size}.`);
			}
			digest.update(new Uint8Array(buf));
		}
		if (digest.digest() !== manifest.assetSha256) {
			throw new VerificationError("The finished file failed its end-to-end check.");
		}

		return { manifest, bytesWritten, chunksSkipped };
	} finally {
		closeSync(fd);
	}
}
