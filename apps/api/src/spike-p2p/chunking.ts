// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Chunking + manifest for the P2P delivery spike.
 *
 * The manifest is a minimal JSON object: the asset's storage key, the total file hash,
 * and an array of chunks (offset, size, sha256). The seeder reads chunks from storage on
 * demand; the client fetches them, verifies each chunk's hash, reassembles, and verifies
 * the total file hash.
 *
 * This is a proof-of-concept manifest, not the published spec from milestone 1. The real
 * spec will carry Work identity, asset identity, and a content-addressed chunk scheme.
 * For the spike, fixed-size chunks with per-chunk SHA-256 is enough to prove reassembly.
 */

export const CHUNK_SIZE = 256 * 1024; // 256 KiB — small enough to parallelize, large enough to avoid per-request overhead

export interface ChunkSpec {
	index: number;
	offset: number;
	size: number;
	sha256: string;
}

export interface Manifest {
	version: 1;
	workId: number;
	assetId: number;
	storageKey: string;
	filename: string;
	fileSize: number;
	mimeType: string;
	fileSha256: string;
	chunkSize: number;
	chunks: ChunkSpec[];
}

/** Compute SHA-256 of a byte array, return hex. */
export async function sha256hex(data: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Build a manifest for a file in storage. Reads the whole file, chunks it, hashes each
 * chunk and the whole file, returns the manifest. The seeder uses this once at startup
 * (or on first request) to build the in-memory chunk map.
 */
export async function buildManifest(params: {
	workId: number;
	assetId: number;
	storageKey: string;
	filename: string;
	fileSize: number;
	mimeType: string;
	bytes: Uint8Array;
}): Promise<Manifest> {
	const { workId, assetId, storageKey, filename, fileSize, mimeType, bytes } = params;

	const chunks: ChunkSpec[] = [];
	const fileHasher = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	const fileSha256 = Array.from(new Uint8Array(fileHasher))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_SIZE, index++) {
		const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
		const sha256 = await sha256hex(chunk);
		chunks.push({ index, offset, size: chunk.length, sha256 });
	}

	return {
		version: 1,
		workId,
		assetId,
		storageKey,
		filename,
		fileSize,
		mimeType,
		fileSha256,
		chunkSize: CHUNK_SIZE,
		chunks,
	};
}
