// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery manifest — per 45.04 P2P Manifest Spec.
 *
 * The manifest is the map that tells the swarm what chunks make up a given downloadable
 * asset. It is content-addressed: each chunk's identity is its SHA-256 hash, not its
 * position. The array index gives the chunk's position in the reassembled file; the hash
 * is what a peer verifies against.
 *
 * Chunk size is fixed at 256 KiB (262144 bytes). WebRTC data channels may fragment a
 * logical chunk into multiple SCTP messages at the transport layer; that is a transport
 * concern, not a manifest concern — the manifest defines the unit of verification.
 *
 * This is the production manifest builder. The spike's manifest (in spike-p2p/chunking.ts)
 * used offset+size per chunk; the production format uses content-addressed hashes only,
 * per the spec. A third party can build a conformant puller from 45.04 alone.
 */

export const CHUNK_SIZE = 256 * 1024; // 256 KiB

export interface Manifest {
	/** The manifest format version (per 45.04). Currently 1. */
	specVersion: 1;
	/** The Work's numeric database ID (used by the hub for token verification). */
	workId: number;
	/** The Work's durable public identifier (used in URLs). */
	workPublicId: string;
	/** The asset's numeric database ID (used by the hub for token + chunk lookup). */
	assetId: number;
	/** The original filename of the asset. */
	assetFilename: string;
	/** Total file size in bytes. */
	assetSize: number;
	/** The asset's MIME type. */
	assetMimeType: string;
	/** SHA-256 hash of the complete file (end-to-end verification). */
	assetSha256: string;
	/** The logical chunk size in bytes. All chunks except the last are this size. */
	chunkSize: number;
	/** Ordered array of SHA-256 hashes, one per chunk. Index = position, value = hash. */
	chunks: string[];
}

/** Compute SHA-256 of a byte array, return hex. */
export async function sha256hex(data: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Build a manifest for a file in storage.
 *
 * Reads the whole file, chunks it into 256 KiB pieces, computes the SHA-256 of each
 * chunk and of the complete file, and returns the manifest. The seeder calls this once
 * (on first request for a given asset) and caches the result.
 */
export async function buildManifest(params: {
	workId: number;
	workPublicId: string;
	assetId: number;
	assetFilename: string;
	assetSize: number;
	assetMimeType: string;
	bytes: Uint8Array;
}): Promise<Manifest> {
	const { workId, workPublicId, assetId, assetFilename, assetSize, assetMimeType, bytes } = params;

	const chunks: string[] = [];
	const fileSha256 = await sha256hex(bytes);

	for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
		const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
		chunks.push(await sha256hex(chunk));
	}

	return {
		specVersion: 1,
		workId,
		workPublicId,
		assetId,
		assetFilename,
		assetSize,
		assetMimeType,
		assetSha256: fileSha256,
		chunkSize: CHUNK_SIZE,
		chunks,
	};
}

/**
 * Compute the byte range for a chunk at a given index.
 * All chunks except the last are exactly `chunkSize` bytes; the last chunk may be smaller.
 */
export function chunkRange(
	index: number,
	_totalChunks: number,
	chunkSize: number,
	assetSize: number,
): {
	offset: number;
	size: number;
} {
	const offset = index * chunkSize;
	const size = Math.min(chunkSize, assetSize - offset);
	return { offset, size };
}

/** Verify a chunk's SHA-256 against a manifest. Returns true if the hash matches. */
export async function verifyChunk(
	chunkBytes: Uint8Array,
	manifest: Manifest,
	chunkIndex: number,
): Promise<boolean> {
	if (chunkIndex < 0 || chunkIndex >= manifest.chunks.length) return false;
	const hash = await sha256hex(chunkBytes);
	return hash === manifest.chunks[chunkIndex];
}

/** Verify a reassembled file's SHA-256 against a manifest. */
export async function verifyFile(fileBytes: Uint8Array, manifest: Manifest): Promise<boolean> {
	const hash = await sha256hex(fileBytes);
	return hash === manifest.assetSha256;
}
