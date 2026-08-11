// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The shared P2P manifest module — chunk arithmetic, and the hand-rolled incremental hash.
 *
 * `Sha256Stream` is the reason this file exists. Hand-writing a hash is normally the wrong
 * move; the browser leaves no choice, because `crypto.subtle.digest` is one-shot and the
 * only way to use a one-shot digest on a multi-gigabyte download is to hold the whole file
 * — which is the exact thing streaming to OPFS exists to avoid.
 *
 * What makes that acceptable is this suite: every assertion below pins the implementation
 * against `crypto.subtle`, the platform's own SHA-256, rather than against a constant
 * copied out of the implementation. A test that restated the code's own arithmetic would
 * agree with it no matter how wrong it was.
 */
import { describe, expect, it } from "bun:test";
import {
	CHUNK_SIZE,
	chunkRange,
	type Manifest,
	Sha256Stream,
	sha256hex,
	totalChunks,
	verifyChunk,
	verifyFile,
} from "./p2p";

function bytes(n: number, seed = 1): Uint8Array {
	const out = new Uint8Array(n);
	let state = seed >>> 0;
	for (let i = 0; i < n; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (state >> 16) & 0xff;
	}
	return out;
}

describe("Sha256Stream", () => {
	it("matches crypto.subtle on the empty input", async () => {
		expect(new Sha256Stream().digest()).toBe(await sha256hex(new Uint8Array(0)));
	});

	it("matches the published vector for 'abc'", async () => {
		// FIPS 180-4's own test vector — an anchor outside this codebase entirely, so a
		// shared misunderstanding between implementation and platform still gets caught.
		const abc = new TextEncoder().encode("abc");
		expect(new Sha256Stream().update(abc).digest()).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("matches crypto.subtle across every padding boundary", async () => {
		// 55/56 and 119/120 are where the length field stops fitting in the final block and
		// an extra compression round is needed. Off-by-one here is the classic SHA bug and
		// it is invisible at every other length.
		for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 121, 127, 128, 129]) {
			const data = bytes(n, n);
			expect(new Sha256Stream().update(data).digest()).toBe(await sha256hex(data));
		}
	});

	it("is independent of how the input is split across update() calls", async () => {
		// The property that actually matters for the download engine: chunks arrive in
		// pieces of whatever size the network produced, and the digest must not care.
		const data = bytes(5000, 7);
		const expected = await sha256hex(data);

		for (const split of [[5000], [1, 4999], [64, 64, 4872], [1000, 1000, 1000, 1000, 1000]]) {
			const stream = new Sha256Stream();
			let at = 0;
			for (const size of split) {
				stream.update(data.subarray(at, at + size));
				at += size;
			}
			expect(stream.digest()).toBe(expected);
		}
	});

	it("matches crypto.subtle over a realistic multi-chunk file", async () => {
		const data = bytes(CHUNK_SIZE * 2 + 1234, 42);
		const stream = new Sha256Stream();
		for (let at = 0; at < data.length; at += CHUNK_SIZE) {
			stream.update(data.subarray(at, Math.min(at + CHUNK_SIZE, data.length)));
		}
		expect(stream.digest()).toBe(await sha256hex(data));
	});

	it("matches crypto.subtle on randomised feeds", async () => {
		for (let trial = 0; trial < 20; trial++) {
			const size = 1 + Math.floor(Math.random() * 3000);
			const data = bytes(size, trial + 100);
			const stream = new Sha256Stream();
			let at = 0;
			while (at < size) {
				const take = 1 + Math.floor(Math.random() * 200);
				stream.update(data.subarray(at, Math.min(at + take, size)));
				at += take;
			}
			expect(stream.digest()).toBe(await sha256hex(data));
		}
	});
});

describe("chunk arithmetic", () => {
	it("gives the last chunk the remainder, not the chunk size", () => {
		const assetSize = CHUNK_SIZE * 2 + 1000;
		expect(totalChunks(assetSize, CHUNK_SIZE)).toBe(3);
		expect(chunkRange(0, CHUNK_SIZE, assetSize)).toEqual({ offset: 0, size: CHUNK_SIZE });
		expect(chunkRange(2, CHUNK_SIZE, assetSize)).toEqual({ offset: CHUNK_SIZE * 2, size: 1000 });
	});

	it("handles a file that is an exact multiple of the chunk size", () => {
		const assetSize = CHUNK_SIZE * 3;
		expect(totalChunks(assetSize, CHUNK_SIZE)).toBe(3);
		expect(chunkRange(2, CHUNK_SIZE, assetSize)).toEqual({
			offset: CHUNK_SIZE * 2,
			size: CHUNK_SIZE,
		});
	});

	it("covers the whole file with no gap and no overlap", async () => {
		const assetSize = CHUNK_SIZE * 4 + 77;
		let covered = 0;
		let expectedOffset = 0;
		for (let i = 0; i < totalChunks(assetSize, CHUNK_SIZE); i++) {
			const { offset, size } = chunkRange(i, CHUNK_SIZE, assetSize);
			expect(offset).toBe(expectedOffset);
			covered += size;
			expectedOffset = offset + size;
		}
		expect(covered).toBe(assetSize);
	});
});

describe("verification", () => {
	const manifest = (chunks: string[], assetSha256 = ""): Manifest => ({
		specVersion: 1,
		workId: 1,
		workPublicId: "1",
		assetId: 1,
		assetFilename: "f.zip",
		assetMimeType: "application/zip",
		assetSize: 0,
		assetSha256,
		chunkSize: CHUNK_SIZE,
		chunks,
	});

	it("accepts a chunk whose hash matches and rejects one byte of drift", async () => {
		const data = bytes(1000, 3);
		const m = manifest([await sha256hex(data)]);
		expect(await verifyChunk(data, m, 0)).toBe(true);

		const tampered = data.slice();
		tampered[500] ^= 0x01;
		expect(await verifyChunk(tampered, m, 0)).toBe(false);
	});

	it("rejects an index outside the manifest rather than throwing", async () => {
		const m = manifest([await sha256hex(bytes(10))]);
		expect(await verifyChunk(bytes(10), m, 1)).toBe(false);
		expect(await verifyChunk(bytes(10), m, -1)).toBe(false);
	});

	it("checks the whole file against assetSha256", async () => {
		const data = bytes(2048, 9);
		const m = manifest([], await sha256hex(data));
		expect(await verifyFile(data, m)).toBe(true);
		expect(await verifyFile(bytes(2048, 10), m)).toBe(false);
	});
});
