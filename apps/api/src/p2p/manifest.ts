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

import { createHash } from "node:crypto";
import { storage } from "../services/storage/index.js";

export const CHUNK_SIZE = 256 * 1024; // 256 KiB

/**
 * How the walk below knows when to stop, and why it is a count rather than a sentinel.
 *
 * An earlier draft discovered the file's length by reading until it got a short read. That
 * is elegant and wrong: termination then depends on the range reader honouring `offset`,
 * and a reader that ignored it would return a full chunk forever — looping inside a
 * request handler, hashing as it went. That is not hypothetical. Sabotaging `readRange` to
 * ignore its offset, as a check on these tests, hung the suite for 30 seconds with nothing
 * to say why, and a chunk-count ceiling did not help because reaching any defensible
 * ceiling means hashing tens of gigabytes first.
 *
 * Asking storage for the size up front fixes both halves: the loop is bounded by
 * arithmetic rather than by a sentinel, and because every read's expected length is then
 * known exactly, a reader that misbehaves is caught on the first iteration instead of the
 * millionth. The size comes from storage rather than `assets.file_size` deliberately —
 * see `StorageService.size`.
 */
const READ_MISMATCH = (assetId: number, index: number, want: number, got: number) =>
	`Manifest read mismatch for asset ${assetId} chunk ${index}: expected ${want} bytes, got ${got}. ` +
	"The object changed underneath the walk, or the range reader is not honouring its offset.";

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

/** Identity fields a manifest carries about the thing it describes. */
interface ManifestSubject {
	workId: number;
	workPublicId: string;
	assetId: number;
	assetFilename: string;
	assetMimeType: string;
}

/**
 * Hands back up to `length` bytes starting at `offset`. Fewer bytes means end-of-file;
 * null or empty means there is nothing at or past that offset.
 */
type RangeReader = (offset: number, length: number) => Promise<Uint8Array | null>;

/**
 * Build a manifest by walking a file one chunk at a time.
 *
 * This is the only manifest algorithm — the byte-array and storage-backed entry points
 * below both delegate here, so a manifest built in a test and one built by the seeder
 * cannot drift apart.
 *
 * **Memory is O(chunk size), not O(file size), and that is the point.** The previous
 * implementation took the whole file as a `Uint8Array`, which meant the seeder read a
 * complete asset into the API's heap and then held it there forever. Assets here are
 * games; the api component is a 512 MB instance. Streaming keeps a 256 KiB window
 * resident no matter how large the asset is.
 *
 * **`assetSize` comes from the bytes, never from `assets.file_size`.** That column can
 * disagree with the object in storage — the spike's own seed script had to rewrite it by
 * hand — and a manifest whose `assetSize` is wrong produces a wrong final-chunk size in
 * `chunkRange`, which surfaces as a hash mismatch on the last chunk of an otherwise
 * healthy download. Callers pass the size they got from the byte source itself.
 */
async function buildManifestFromReader(
	subject: ManifestSubject,
	assetSize: number,
	read: RangeReader,
): Promise<Manifest> {
	const chunks: string[] = [];
	// Node's incremental hasher, because crypto.subtle.digest is one-shot and a one-shot
	// whole-file digest is exactly the thing this function exists to avoid.
	const fileHash = createHash("sha256");
	const totalChunks = Math.ceil(assetSize / CHUNK_SIZE);

	for (let index = 0; index < totalChunks; index++) {
		const offset = index * CHUNK_SIZE;
		const want = Math.min(CHUNK_SIZE, assetSize - offset);
		const chunk = await read(offset, want);
		if (!chunk || chunk.length !== want) {
			throw new Error(READ_MISMATCH(subject.assetId, index, want, chunk?.length ?? 0));
		}
		fileHash.update(chunk);
		chunks.push(await sha256hex(chunk));
	}

	return {
		specVersion: 1,
		...subject,
		assetSize,
		assetSha256: fileHash.digest("hex"),
		chunkSize: CHUNK_SIZE,
		chunks,
	};
}

/**
 * Build a manifest from bytes already in memory.
 *
 * For callers that legitimately hold the whole file — tests, and any future in-process
 * packaging step. The seeder must NOT use this; it uses `buildManifestFromStorage`.
 */
export async function buildManifest(
	params: ManifestSubject & { bytes: Uint8Array },
): Promise<Manifest> {
	const { bytes, ...subject } = params;
	return buildManifestFromReader(subject, bytes.length, async (offset, length) =>
		bytes.subarray(offset, Math.min(offset + length, bytes.length)),
	);
}

/**
 * Build a manifest by streaming an object out of storage — what the seeder uses.
 *
 * Never holds more than one chunk. Returns null when there is no such object, which the
 * caller should distinguish from a manifest describing an empty one.
 */
export async function buildManifestFromStorage(
	params: ManifestSubject & { storageKey: string },
): Promise<Manifest | null> {
	const { storageKey, ...subject } = params;
	const assetSize = await storage.size(storageKey);
	if (assetSize === null) return null;
	return buildManifestFromReader(subject, assetSize, (offset, length) =>
		storage.readRange(storageKey, offset, length),
	);
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
