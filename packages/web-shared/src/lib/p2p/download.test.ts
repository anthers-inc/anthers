// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The browser P2P download engine.
 *
 * Runs in Bun with no browser, no OPFS and no WebRTC — which is the whole reason the sink
 * and the chunk sources are interfaces. The parts worth testing are the decisions
 * (scheduling, verification, failover, token renewal), and none of them need a real
 * network or a real disk to be wrong.
 *
 * `fetch` and the manifest endpoint are stubbed at the module boundary. What is NOT
 * stubbed is verification: every chunk in these tests is hashed by the real `verifyChunk`
 * against a real manifest built by the real `sha256hex`, so a test that says "the download
 * succeeded" is asserting that the bytes actually composed to the right file.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { CHUNK_SIZE, chunkRange, type Manifest, sha256hex, totalChunks } from "@anthers/shared/p2p";
import {
	AccessError,
	type ChunkSource,
	downloadAsset,
	IntegrityError,
	tokenExpiry,
} from "./download";
import { MemorySink } from "./sink";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────

/** A small chunk size keeps the fixtures fast while still exercising multi-chunk paths. */
const TEST_CHUNK = 1024;

// Annotated `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: bare widens to
// `Uint8Array<ArrayBufferLike>`, which no longer compares against the `Uint8Array<ArrayBuffer>`
// that `new Uint8Array(await blob.arrayBuffer())` produces on the other side of the
// byte-for-byte assertions. Same gotcha as `apps/api/src/__tests__/p2p-delivery.test.ts`.
function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(n);
	let state = seed >>> 0;
	for (let i = 0; i < n; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (state >> 16) & 0xff;
	}
	return out;
}

async function makeManifest(file: Uint8Array, chunkSize = TEST_CHUNK): Promise<Manifest> {
	const chunks: string[] = [];
	for (let i = 0; i < totalChunks(file.length, chunkSize); i++) {
		const { offset, size } = chunkRange(i, chunkSize, file.length);
		chunks.push(await sha256hex(file.subarray(offset, offset + size)));
	}
	return {
		specVersion: 1,
		workId: 7,
		workPublicId: "7",
		assetId: 9,
		assetFilename: "game.zip",
		assetMimeType: "application/zip",
		assetSize: file.length,
		assetSha256: await sha256hex(file),
		chunkSize,
		chunks,
	};
}

/** Build a token whose payload carries a real expiry, since the engine reads it. */
function makeToken(expiresInSeconds = 900): string {
	const payload = { w: 7, a: 9, u: 1, e: Math.floor(Date.now() / 1000) + expiresInSeconds };
	const b64 = btoa(JSON.stringify(payload))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	return `${b64}.signature-not-checked-by-the-client`;
}

/** A peer that serves from a byte array, with knobs for the failure modes that matter. */
function fakePeer(
	id: string,
	file: Uint8Array,
	chunkSize: number,
	opts: { corruptIndexes?: number[]; missingIndexes?: number[]; failAll?: boolean } = {},
): ChunkSource & { served: number[]; healthy: boolean } {
	return {
		id,
		healthy: true,
		served: [] as number[],
		async fetchChunk(index) {
			if (opts.failAll) return null;
			if (opts.missingIndexes?.includes(index)) return null;
			const { offset, size } = chunkRange(index, chunkSize, file.length);
			this.served.push(index);
			const slice = file.slice(offset, offset + size);
			if (opts.corruptIndexes?.includes(index)) slice[0] ^= 0xff;
			return slice;
		},
		markPoisoned() {
			this.healthy = false;
		},
	};
}

/**
 * Read a finished download's bytes, asserting a blob came back.
 *
 * `blob` is nullable because `FileSystemSink` writes straight to the user's chosen file
 * and has nothing to hand over. Every test here uses `MemorySink`, which always produces
 * one — so a null is a real failure, not a case to tolerate.
 */
async function readResult(result: { blob: Blob | null }): Promise<Uint8Array<ArrayBuffer>> {
	expect(result.blob).not.toBeNull();
	return new Uint8Array(await (result.blob as Blob).arrayBuffer());
}

// ── Network stubbing ─────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
let manifestCalls = 0;
let hubChunkCalls: number[] = [];

interface StubOptions {
	manifest: Manifest;
	file: Uint8Array;
	/** Status for the manifest endpoint. */
	manifestStatus?: number;
	/** Tokens handed out, in order; the last repeats. */
	tokens?: string[];
	/** Chunk indexes the hub answers 401 for, once each. */
	hubUnauthorizedOnce?: Set<number>;
	/** Chunk indexes the hub refuses outright. */
	hubMissing?: number[];
	/** A second manifest served on renewal — for the asset-changed case. */
	renewedManifest?: Manifest;
}

function stubNetwork(opts: StubOptions): void {
	manifestCalls = 0;
	hubChunkCalls = [];
	const tokens = opts.tokens ?? [makeToken()];

	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();

		if (url.includes("/manifest")) {
			const status = opts.manifestStatus ?? 200;
			if (status !== 200) return new Response("no", { status });
			const manifest =
				manifestCalls > 0 && opts.renewedManifest ? opts.renewedManifest : opts.manifest;
			const token = tokens[Math.min(manifestCalls, tokens.length - 1)];
			manifestCalls++;
			return new Response(JSON.stringify({ manifest, token }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}

		const match = url.match(/\/chunks\/(\d+)$/);
		if (match) {
			const index = Number(match[1]);
			hubChunkCalls.push(index);
			if (opts.hubUnauthorizedOnce?.has(index)) {
				opts.hubUnauthorizedOnce.delete(index);
				return new Response("expired", { status: 401 });
			}
			if (opts.hubMissing?.includes(index)) return new Response("gone", { status: 404 });
			const { offset, size } = chunkRange(index, opts.manifest.chunkSize, opts.file.length);
			return new Response(opts.file.slice(offset, offset + size).buffer as ArrayBuffer, {
				status: 200,
			});
		}

		throw new Error(`unexpected fetch: ${url}`);
	}) as typeof fetch;
}

beforeEach(() => {
	manifestCalls = 0;
	hubChunkCalls = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

// ── Tests ────────────────────────────────────────────────────────────────────────────

describe("the hub-only floor", () => {
	it("downloads and verifies an asset with no peers at all", async () => {
		// The supported floor: an empty swarm still produces the file.
		const file = bytes(TEST_CHUNK * 3 + 500, 1);
		const manifest = await makeManifest(file);
		stubNetwork({ manifest, file });

		const sink = new MemorySink(file.length);
		const result = await downloadAsset({ workId: 7, assetId: 9, sink });

		expect(await readResult(result)).toEqual(file);
		expect(result.hubBytes).toBe(file.length);
		expect(result.peerBytes).toBe(0);
		expect(hubChunkCalls.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
	});

	it("handles a file that is an exact multiple of the chunk size", async () => {
		const file = bytes(TEST_CHUNK * 2, 2);
		const manifest = await makeManifest(file);
		stubNetwork({ manifest, file });
		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
		});
		expect(await readResult(result)).toEqual(file);
	});

	it("handles a file smaller than one chunk", async () => {
		const file = bytes(300, 3);
		const manifest = await makeManifest(file);
		stubNetwork({ manifest, file });
		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
		});
		expect(await readResult(result)).toEqual(file);
	});

	it("reports progress that ends at the full size", async () => {
		const file = bytes(TEST_CHUNK * 4, 4);
		stubNetwork({ manifest: await makeManifest(file), file });
		const seen: number[] = [];
		await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			onProgress: (p) => seen.push(p.receivedBytes),
		});
		expect(seen.length).toBe(4);
		expect(Math.max(...seen)).toBe(file.length);
	});
});

describe("verification", () => {
	it("rejects a file whose chunks pass individually but do not compose", async () => {
		// The reason the end-to-end hash exists. Every per-chunk hash here is correct for
		// the bytes served; only `assetSha256` disagrees, so per-chunk checking alone would
		// hand over a file that is not the one the manifest describes.
		const file = bytes(TEST_CHUNK * 2, 5);
		const manifest = await makeManifest(file);
		manifest.assetSha256 = await sha256hex(bytes(16, 99));
		stubNetwork({ manifest, file });

		await expect(
			downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) }),
		).rejects.toThrow(IntegrityError);
	});

	it("refuses a manifest whose chunk count disagrees with its own size", async () => {
		const file = bytes(TEST_CHUNK * 3, 6);
		const manifest = await makeManifest(file);
		manifest.chunks = manifest.chunks.slice(0, 2);
		stubNetwork({ manifest, file });

		await expect(
			downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) }),
		).rejects.toThrow(IntegrityError);
	});

	it("drops a peer that serves bytes failing the hash, and completes from the hub", async () => {
		// The swarm's core safety property: a peer is a machine Anthers does not control.
		const file = bytes(TEST_CHUNK * 3, 7);
		const manifest = await makeManifest(file);
		stubNetwork({ manifest, file });

		const liar = fakePeer("liar", file, TEST_CHUNK, { corruptIndexes: [0, 1, 2] });
		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			peers: [liar],
			concurrency: 1,
		});

		expect(liar.healthy).toBe(false);
		expect(await readResult(result)).toEqual(file);
		// Poisoned on its first bad chunk, so it is not consulted for the rest.
		expect(liar.served).toEqual([0]);
		expect(result.peerBytes).toBe(0);
	});

	it("does not write a chunk that fails verification", async () => {
		const file = bytes(TEST_CHUNK * 2, 8);
		const manifest = await makeManifest(file);
		stubNetwork({ manifest, file });

		const writes: number[] = [];
		const sink = new MemorySink(file.length);
		const spy = {
			...sink,
			write: async (o: number, b: Uint8Array) => {
				writes.push(o);
				return sink.write(o, b);
			},
			finish: () => sink.finish(),
			abort: () => sink.abort(),
		};

		const liar = fakePeer("liar", file, TEST_CHUNK, { corruptIndexes: [0] });
		await downloadAsset({ workId: 7, assetId: 9, sink: spy, peers: [liar], concurrency: 1 });
		// Four writes would mean the corrupt chunk was written and then overwritten.
		expect(writes.length).toBe(2);
	});
});

describe("peers and failover", () => {
	it("prefers a healthy peer over the hub, and counts the bytes separately", async () => {
		const file = bytes(TEST_CHUNK * 3, 9);
		stubNetwork({ manifest: await makeManifest(file), file });

		const peer = fakePeer("peer-1", file, TEST_CHUNK);
		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			peers: [peer],
		});

		expect(result.peerBytes).toBe(file.length);
		expect(result.hubBytes).toBe(0);
		expect(hubChunkCalls).toEqual([]);
		expect(await readResult(result)).toEqual(file);
	});

	it("falls back to the hub for chunks a peer does not have", async () => {
		// The realistic swarm case — a peer part-way through its own download.
		const file = bytes(TEST_CHUNK * 4, 10);
		stubNetwork({ manifest: await makeManifest(file), file });

		const partial = fakePeer("partial", file, TEST_CHUNK, { missingIndexes: [1, 3] });
		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			peers: [partial],
		});

		expect(hubChunkCalls.sort((a, b) => a - b)).toEqual([1, 3]);
		expect(await readResult(result)).toEqual(file);
		expect(result.hubBytes).toBe(TEST_CHUNK * 2);
		expect(result.peerBytes).toBe(TEST_CHUNK * 2);
	});

	it("completes from the hub when every peer is useless", async () => {
		const file = bytes(TEST_CHUNK * 2, 11);
		stubNetwork({ manifest: await makeManifest(file), file });
		const dead = fakePeer("dead", file, TEST_CHUNK, { failAll: true });

		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			peers: [dead],
		});
		expect(await readResult(result)).toEqual(file);
		expect(result.hubBytes).toBe(file.length);
	});

	it("fails loudly when no source can supply a chunk", async () => {
		const file = bytes(TEST_CHUNK * 2, 12);
		stubNetwork({ manifest: await makeManifest(file), file, hubMissing: [1] });

		await expect(
			downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) }),
		).rejects.toThrow(/chunk 1/);
	});
});

describe("memory bounds", () => {
	it("will not run more than a window ahead of the slowest chunk", async () => {
		// The digest can only advance in order, so a chunk held up at the cursor strands
		// every chunk completed after it. Without a window the other workers race on and
		// every one of those stays in memory — on a 20 GiB asset, the whole-file buffer
		// reintroduced by the back door, on the path that exists to avoid it.
		//
		// Chunk 0 is held open here while the rest of the download tries to proceed; the
		// assertion is that the engine stops asking for new chunks rather than running to
		// the end of the file.
		const file = bytes(TEST_CHUNK * 300, 40);
		const manifest = await makeManifest(file);
		stubNetwork({ manifest, file });

		let releaseChunkZero: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseChunkZero = resolve;
		});

		const requested: number[] = [];
		const slowPeer: ChunkSource = {
			id: "slow",
			healthy: true,
			async fetchChunk(index) {
				requested.push(index);
				if (index === 0) await gate;
				const { offset, size } = chunkRange(index, TEST_CHUNK, file.length);
				return file.slice(offset, offset + size);
			},
		};

		const run = downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			peers: [slowPeer],
			concurrency: 8,
		});

		// Give the workers ample time to run away if nothing is stopping them.
		await new Promise((resolve) => setTimeout(resolve, 250));
		const highWater = Math.max(...requested);
		expect(highWater).toBeLessThan(80); // the 64-chunk window, plus in-flight slack
		expect(requested.length).toBeLessThan(80);

		releaseChunkZero();
		const result = await run;
		expect(await readResult(result)).toEqual(file);
	});
});

describe("the token", () => {
	it("reads an expiry out of a real token payload", () => {
		const token = makeToken(600);
		const delta = tokenExpiry(token) - Math.floor(Date.now() / 1000);
		expect(delta).toBeGreaterThan(590);
		expect(delta).toBeLessThanOrEqual(600);
	});

	it("treats an unreadable token as expired rather than trusting it", () => {
		expect(tokenExpiry("garbage")).toBe(0);
		expect(tokenExpiry("")).toBe(0);
	});

	it("renews before expiry rather than waiting to be rejected", async () => {
		// A token inside the renewal margin must be replaced before the first chunk, not
		// after a 401 — the 401 path is the backstop, not the plan.
		const file = bytes(TEST_CHUNK * 2, 13);
		stubNetwork({
			manifest: await makeManifest(file),
			file,
			tokens: [makeToken(30), makeToken(900)],
		});

		await downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) });
		expect(manifestCalls).toBeGreaterThan(1);
	});

	it("does not renew when the token has plenty of life", async () => {
		const file = bytes(TEST_CHUNK * 2, 14);
		stubNetwork({ manifest: await makeManifest(file), file, tokens: [makeToken(900)] });
		await downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) });
		expect(manifestCalls).toBe(1);
	});

	it("recovers from a 401 mid-download by re-minting once", async () => {
		const file = bytes(TEST_CHUNK * 3, 15);
		stubNetwork({
			manifest: await makeManifest(file),
			file,
			tokens: [makeToken(900), makeToken(900)],
			hubUnauthorizedOnce: new Set([1]),
		});

		const result = await downloadAsset({
			workId: 7,
			assetId: 9,
			sink: new MemorySink(file.length),
			concurrency: 1,
		});
		expect(manifestCalls).toBe(2);
		expect(await readResult(result)).toEqual(file);
	});

	it("stops when the asset changes underneath the download", async () => {
		// A renewal returning a different assetSha256 means the file was replaced. Carrying
		// on would splice two files together and hand over something that never existed.
		const file = bytes(TEST_CHUNK * 3, 16);
		const manifest = await makeManifest(file);
		const replaced = await makeManifest(bytes(TEST_CHUNK * 3, 17));

		stubNetwork({
			manifest,
			file,
			tokens: [makeToken(30), makeToken(900)],
			renewedManifest: replaced,
		});

		await expect(
			downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) }),
		).rejects.toThrow(IntegrityError);
	});
});

describe("access", () => {
	it("surfaces a denial from the manifest endpoint without fetching a chunk", async () => {
		const file = bytes(TEST_CHUNK, 18);
		stubNetwork({ manifest: await makeManifest(file), file, manifestStatus: 403 });

		// The TYPE, not the wording — callers branch on `AccessError` to show an unlock
		// prompt rather than a retry, and a message match would keep passing if the class
		// stopped being thrown.
		await expect(
			downloadAsset({ workId: 7, assetId: 9, sink: new MemorySink(file.length) }),
		).rejects.toBeInstanceOf(AccessError);
		expect(hubChunkCalls).toEqual([]);
	});
});

describe("cleanup", () => {
	it("aborts the sink when the download fails, rather than leaving a partial file", async () => {
		const file = bytes(TEST_CHUNK * 2, 19);
		stubNetwork({ manifest: await makeManifest(file), file, hubMissing: [1] });

		const sink = new MemorySink(file.length);
		const aborted = mock(() => Promise.resolve());
		await expect(
			downloadAsset({
				workId: 7,
				assetId: 9,
				sink: {
					...sink,
					abort: aborted,
					write: (o, b) => sink.write(o, b),
					finish: () => sink.finish(),
				},
			}),
		).rejects.toThrow();
		expect(aborted).toHaveBeenCalled();
	});
});
