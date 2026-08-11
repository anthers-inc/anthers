// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The P2P manifest format and its verification arithmetic — per 45.04, and shared.
 *
 * This module exists because the manifest has exactly two readers and they run in
 * different worlds: the **hub** builds one (Bun, `node:crypto`, a storage service) and the
 * **client** verifies one (a browser tab, Web Crypto, no filesystem). They must agree on
 * the format, on where every chunk begins and ends, and on what makes a chunk valid — and
 * "must agree" plus "two implementations" is how a format drifts.
 *
 * So the pure half lives here: the type, the arithmetic, the hashing. The hub keeps its
 * streaming builder (which needs an incremental hasher `crypto.subtle` cannot provide) and
 * imports the rest; the browser client imports all of it. A change to the chunk layout is
 * then a change to one file, and both sides get it.
 *
 * **Browser-safe, and that is a constraint rather than a happy accident.** Nothing here may
 * import `decimal.js`, `node:crypto`, or anything else that would follow it into the SPA
 * bundle — this is the same rule that keeps `fees.ts` out of the browser. `crypto.subtle`
 * is the one primitive used, and it is present in Bun, in browsers, and in Web Workers.
 */

/**
 * The logical chunk size: 256 KiB.
 *
 * WebRTC data channels may fragment a logical chunk into several SCTP messages at the
 * transport layer. That is a transport concern — the manifest defines the unit of
 * *verification*, not the unit of transmission, and a peer reassembles before it hashes.
 */
export const CHUNK_SIZE = 256 * 1024;

/**
 * The identity half of a manifest: which Work and which asset this describes.
 *
 * Kept separate from the content half because the two have different lifetimes. Identity is
 * composed from the live rows on every request, so a rename shows up immediately; content is
 * hashed once and is immutable per asset version. 45.04 requires both — manifests immutable
 * in their content, and the hub always serving the current one.
 */
export interface ManifestSubject {
	/** The Work's numeric database ID (used by the hub for token verification). */
	workId: number;
	/** The Work's durable public identifier (used in URLs). */
	workPublicId: string;
	/** The asset's numeric database ID (used by the hub for token + chunk lookup). */
	assetId: number;
	/** The original filename of the asset. */
	assetFilename: string;
	/** The asset's MIME type. */
	assetMimeType: string;
}

/** The immutable half — what is hashed once and stored on the asset row. */
export interface ManifestContent {
	/** Total file size in bytes, as found in storage — never as the database claims. */
	assetSize: number;
	/** SHA-256 hash of the complete file (end-to-end verification). */
	assetSha256: string;
	/** The logical chunk size in bytes. All chunks except the last are this size. */
	chunkSize: number;
	/** Ordered array of SHA-256 hashes, one per chunk. Index = position, value = hash. */
	chunks: string[];
}

export interface Manifest extends ManifestSubject, ManifestContent {
	/** The manifest format version (per 45.04). Currently 1. */
	specVersion: 1;
}

/** Compute SHA-256 of a byte array, return hex. */
export async function sha256hex(data: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** How many chunks a file of this size is cut into. */
export function totalChunks(assetSize: number, chunkSize: number): number {
	return Math.ceil(assetSize / chunkSize);
}

/**
 * The byte range for one chunk. All chunks except the last are exactly `chunkSize`; the
 * last is whatever remains.
 *
 * The final chunk is where an inclusive-vs-exclusive range error hides, because it is the
 * only one whose size is not the constant — and a wrong final size surfaces as a hash
 * mismatch on the last chunk of an otherwise healthy download, which reads like corruption
 * rather than arithmetic.
 */
export function chunkRange(
	index: number,
	chunkSize: number,
	assetSize: number,
): { offset: number; size: number } {
	const offset = index * chunkSize;
	return { offset, size: Math.min(chunkSize, assetSize - offset) };
}

/** Verify a chunk's SHA-256 against a manifest. */
export async function verifyChunk(
	chunkBytes: Uint8Array,
	manifest: Pick<Manifest, "chunks">,
	chunkIndex: number,
): Promise<boolean> {
	if (chunkIndex < 0 || chunkIndex >= manifest.chunks.length) return false;
	return (await sha256hex(chunkBytes)) === manifest.chunks[chunkIndex];
}

/**
 * Verify a reassembled file's SHA-256 against a manifest.
 *
 * Takes the whole file in memory, so it is for tests and for small assets. A browser
 * client streaming a multi-gigabyte download to disk must not call this — it uses
 * `Sha256Stream` below, because the whole point of streaming to OPFS is never holding the
 * file, and a one-shot digest at the end would undo it in a single line.
 */
export async function verifyFile(
	fileBytes: Uint8Array,
	manifest: Pick<Manifest, "assetSha256">,
): Promise<boolean> {
	return (await sha256hex(fileBytes)) === manifest.assetSha256;
}

/**
 * Incremental SHA-256, because the browser has no such thing.
 *
 * `crypto.subtle.digest` is one-shot: it takes the entire message and returns the hash.
 * There is no `update()`. That is fine on the hub, which reaches for `node:crypto`'s
 * `createHash` — and it is the whole problem in a browser tab streaming a multi-gigabyte
 * download to disk, where the only way to use a one-shot digest is to hold the file you
 * were at pains not to hold.
 *
 * So: FIPS 180-4 SHA-256, ~70 lines, no dependency. Hand-rolling a hash is normally a bad
 * idea and this is the narrow case where it is not — the algorithm is fully specified,
 * frozen, and has published test vectors, and `p2p.test.ts` pins this implementation
 * against `crypto.subtle` across empty input, every block-boundary length either side of
 * 55/56/64/119/120, and randomised multi-chunk feeds. If it ever disagrees with the
 * platform digest by one byte, that test fails.
 *
 * Note it is used ONLY for the end-to-end check. Per-chunk hashes go through
 * `crypto.subtle` via `sha256hex`, because a chunk is small and already in memory.
 */
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256Stream {
	private readonly h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	]);
	private readonly block = new Uint8Array(64);
	private blockLen = 0;
	private totalLen = 0;
	private readonly w = new Uint32Array(64);

	/** Feed more bytes. Call as many times as you like, in order. */
	update(data: Uint8Array): this {
		this.totalLen += data.length;
		let offset = 0;
		while (offset < data.length) {
			const take = Math.min(64 - this.blockLen, data.length - offset);
			this.block.set(data.subarray(offset, offset + take), this.blockLen);
			this.blockLen += take;
			offset += take;
			if (this.blockLen === 64) {
				this.compress(this.block);
				this.blockLen = 0;
			}
		}
		return this;
	}

	/** Finish and return the hex digest. The instance must not be reused afterwards. */
	digest(): string {
		// Padding: a 0x80 byte, zeroes, then the message length in bits as a 64-bit BE integer.
		const bitLen = this.totalLen * 8;
		this.block[this.blockLen++] = 0x80;
		if (this.blockLen > 56) {
			this.block.fill(0, this.blockLen);
			this.compress(this.block);
			this.blockLen = 0;
		}
		this.block.fill(0, this.blockLen);
		const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
		// Split across two 32-bit writes: a JS number cannot hold a 64-bit bit-count exactly,
		// and `setBigUint64` would drag BigInt in for no benefit at these sizes.
		view.setUint32(56, Math.floor(bitLen / 0x100000000), false);
		view.setUint32(60, bitLen >>> 0, false);
		this.compress(this.block);

		let out = "";
		for (let i = 0; i < 8; i++) out += this.h[i].toString(16).padStart(8, "0");
		return out;
	}

	private compress(block: Uint8Array): void {
		const w = this.w;
		for (let i = 0; i < 16; i++) {
			const j = i * 4;
			w[i] = ((block[j] << 24) | (block[j + 1] << 16) | (block[j + 2] << 8) | block[j + 3]) >>> 0;
		}
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15];
			const b = w[i - 2];
			const s0 = (((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3)) >>> 0;
			const s1 = (((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10)) >>> 0;
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
		}

		let [a, b, c, d, e, f, g, h] = this.h;
		for (let i = 0; i < 64; i++) {
			const S1 =
				(((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
			const ch = ((e & f) ^ (~e & g)) >>> 0;
			const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
			const S0 =
				(((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
			const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
			const t2 = (S0 + maj) >>> 0;
			h = g;
			g = f;
			f = e;
			e = (d + t1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) >>> 0;
		}
		this.h[0] = (this.h[0] + a) >>> 0;
		this.h[1] = (this.h[1] + b) >>> 0;
		this.h[2] = (this.h[2] + c) >>> 0;
		this.h[3] = (this.h[3] + d) >>> 0;
		this.h[4] = (this.h[4] + e) >>> 0;
		this.h[5] = (this.h[5] + f) >>> 0;
		this.h[6] = (this.h[6] + g) >>> 0;
		this.h[7] = (this.h[7] + h) >>> 0;
	}
}
