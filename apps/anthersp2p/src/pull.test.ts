// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The `anthersp2p` puller.
 *
 * These run against a stubbed hub and a real temp directory, because the thing worth
 * testing is what ends up on disk. A puller that reports success and leaves a corrupt file
 * is worse than one that fails, so most of this suite is about refusing bad bytes rather
 * than accepting good ones.
 *
 * Nothing here stubs verification: every manifest is built with the real `sha256hex` from
 * `@anthers/shared/p2p`, so "the download succeeded" means the bytes genuinely composed to
 * the file the manifest describes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkRange, type Manifest, sha256hex, totalChunks } from "@anthers/shared/p2p";
import { AccessDeniedError, pullAsset, VerificationError } from "./pull";

const CHUNK = 1024;
const BASE = "https://hub.test";
const TOKEN = "session-token";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "anthersp2p-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function bytes(n: number, seed = 1): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(n);
	let state = seed >>> 0;
	for (let i = 0; i < n; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (state >> 16) & 0xff;
	}
	return out;
}

async function makeManifest(file: Uint8Array): Promise<Manifest> {
	const chunks: string[] = [];
	for (let i = 0; i < totalChunks(file.length, CHUNK); i++) {
		const { offset, size } = chunkRange(i, CHUNK, file.length);
		chunks.push(await sha256hex(file.subarray(offset, offset + size)));
	}
	return {
		specVersion: 1,
		workId: 3,
		workPublicId: "3",
		assetId: 8,
		assetFilename: "game.zip",
		assetMimeType: "application/zip",
		assetSize: file.length,
		assetSha256: await sha256hex(file),
		chunkSize: CHUNK,
		chunks,
	};
}

function makeToken(ttl = 900): string {
	const payload = { w: 3, a: 8, u: 1, e: Math.floor(Date.now() / 1000) + ttl };
	return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

interface StubOpts {
	manifest: Manifest;
	file: Uint8Array;
	manifestStatus?: number;
	/** Chunk indexes served with a flipped byte. */
	corrupt?: number[];
	/** Chunk indexes served truncated. */
	short?: number[];
	tokens?: string[];
	renewedManifest?: Manifest;
	log?: { manifestCalls: number; chunkCalls: number[] };
}

function stub(opts: StubOpts): typeof fetch {
	const tokens = opts.tokens ?? [makeToken()];
	const log = opts.log ?? { manifestCalls: 0, chunkCalls: [] };
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/manifest")) {
			if (opts.manifestStatus && opts.manifestStatus !== 200) {
				return new Response("no", { status: opts.manifestStatus });
			}
			const manifest =
				log.manifestCalls > 0 && opts.renewedManifest ? opts.renewedManifest : opts.manifest;
			const token = tokens[Math.min(log.manifestCalls, tokens.length - 1)];
			log.manifestCalls++;
			return new Response(JSON.stringify({ manifest, token }), { status: 200 });
		}
		const m = url.match(/\/chunks\/(\d+)$/);
		if (m) {
			const i = Number(m[1]);
			log.chunkCalls.push(i);
			const { offset, size } = chunkRange(i, CHUNK, opts.file.length);
			let slice = opts.file.slice(offset, offset + size);
			if (opts.corrupt?.includes(i)) slice[0] ^= 0xff;
			if (opts.short?.includes(i)) slice = slice.slice(0, size - 1);
			return new Response(slice.buffer as ArrayBuffer, { status: 200 });
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as typeof fetch;
}

const base = (out: string) => ({
	baseUrl: BASE,
	token: TOKEN,
	workId: "3",
	assetId: 8,
	outputPath: out,
});

describe("pulling an asset", () => {
	it("writes a byte-exact file and verifies it end to end", async () => {
		const file = bytes(CHUNK * 3 + 250, 1);
		const manifest = await makeManifest(file);
		const out = join(dir, "game.zip");

		const result = await pullAsset({ ...base(out), fetchImpl: stub({ manifest, file }) });

		expect(new Uint8Array(readFileSync(out))).toEqual(file);
		expect(result.bytesWritten).toBe(file.length);
		expect(result.chunksSkipped).toBe(0);
	});

	it("handles a file that is an exact multiple of the chunk size", async () => {
		const file = bytes(CHUNK * 2, 2);
		const out = join(dir, "exact.bin");
		await pullAsset({
			...base(out),
			fetchImpl: stub({ manifest: await makeManifest(file), file }),
		});
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
	});

	it("handles a file smaller than one chunk", async () => {
		const file = bytes(300, 3);
		const out = join(dir, "small.bin");
		await pullAsset({
			...base(out),
			fetchImpl: stub({ manifest: await makeManifest(file), file }),
		});
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
	});

	it("writes chunks at their own offsets, so concurrency cannot scramble the file", async () => {
		// Positioned writes are what make out-of-order completion safe. With appends, a
		// concurrency above 1 would interleave and the end-to-end hash would catch it —
		// but only after the whole download.
		const file = bytes(CHUNK * 8, 4);
		const out = join(dir, "concurrent.bin");
		await pullAsset({
			...base(out),
			concurrency: 8,
			fetchImpl: stub({ manifest: await makeManifest(file), file }),
		});
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
	});
});

/**
 * 🚨 These assert the MESSAGE, not just `VerificationError`.
 *
 * Every guard in the puller throws the same type, so a test that only checks the type
 * passes when the guard it names is deleted — the *next* guard catches the same bad input
 * for a different reason and throws the same class. Verified by sabotage: with the length
 * check, the chunk-count check and the asset-changed check each removed in turn, all three
 * type-only assertions stayed green. Same family as the tautological-money-test lesson:
 * an assertion both the working and broken code satisfy is not coverage.
 */
describe("refusing bad bytes", () => {
	it("rejects a chunk whose hash does not match, before writing it", async () => {
		const file = bytes(CHUNK * 3, 5);
		const out = join(dir, "corrupt.bin");
		await expect(
			pullAsset({
				...base(out),
				concurrency: 1,
				fetchImpl: stub({ manifest: await makeManifest(file), file, corrupt: [1] }),
			}),
		).rejects.toBeInstanceOf(VerificationError);

		// Chunk 1's bad bytes must not be on disk.
		const written = new Uint8Array(readFileSync(out));
		const { offset, size } = chunkRange(1, CHUNK, file.length);
		expect(written.subarray(offset, offset + size)).not.toEqual(
			file.subarray(offset, offset + size),
		);
		expect(written.subarray(offset, offset + size).every((b) => b === 0)).toBe(true);
	});

	it("rejects a short chunk rather than padding it", async () => {
		const file = bytes(CHUNK * 2, 6);
		await expect(
			pullAsset({
				...base(join(dir, "short.bin")),
				concurrency: 1,
				fetchImpl: stub({ manifest: await makeManifest(file), file, short: [0] }),
			}),
			// The size mismatch names itself in the failure. Since sources fail over, the
			// outer error is "nobody could serve chunk 0" — which on its own would be a
			// worse message than the one this replaced, so the reason rides along with it.
		).rejects.toThrow(/sent \d+ bytes, expected \d+/);
	});

	it("rejects a manifest whose chunk count disagrees with its own size", async () => {
		const file = bytes(CHUNK * 3, 7);
		const manifest = await makeManifest(file);
		manifest.chunks = manifest.chunks.slice(0, 2);
		await expect(
			pullAsset({ ...base(join(dir, "bad.bin")), fetchImpl: stub({ manifest, file }) }),
		).rejects.toThrow(/Manifest is inconsistent/);
	});

	it("catches a file whose chunks all pass but do not compose", async () => {
		// Every per-chunk hash is correct for the bytes served; only assetSha256 disagrees.
		// This is the failure the end-to-end check exists for, and per-chunk verification
		// alone would hand over a file that is not the one described.
		const file = bytes(CHUNK * 2, 8);
		const manifest = await makeManifest(file);
		manifest.assetSha256 = await sha256hex(bytes(16, 99));
		await expect(
			pullAsset({ ...base(join(dir, "nocompose.bin")), fetchImpl: stub({ manifest, file }) }),
		).rejects.toBeInstanceOf(VerificationError);
	});

	it("stops if the asset is replaced mid-download", async () => {
		const file = bytes(CHUNK * 3, 9);
		await expect(
			pullAsset({
				...base(join(dir, "changed.bin")),
				fetchImpl: stub({
					manifest: await makeManifest(file),
					file,
					tokens: [makeToken(30), makeToken(900)],
					renewedManifest: await makeManifest(bytes(CHUNK * 3, 10)),
				}),
			}),
		).rejects.toThrow(/changed while downloading/);
	});
});

describe("resume", () => {
	it("skips chunks already on disk and fetches only what is missing", async () => {
		// The property that makes an interrupted 20 GiB download cost minutes rather than
		// starting over, and it is safe precisely because chunks are content-addressed.
		const file = bytes(CHUNK * 4, 11);
		const manifest = await makeManifest(file);
		const out = join(dir, "partial.bin");

		// Lay down a file with the first two chunks correct and the rest zeroed.
		const partial = new Uint8Array(file.length);
		partial.set(file.subarray(0, CHUNK * 2), 0);
		writeFileSync(out, partial);

		const log = { manifestCalls: 0, chunkCalls: [] as number[] };
		const result = await pullAsset({
			...base(out),
			resume: true,
			concurrency: 1,
			fetchImpl: stub({ manifest, file, log }),
		});

		expect(result.chunksSkipped).toBe(2);
		expect(log.chunkCalls.sort((a, b) => a - b)).toEqual([2, 3]);
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
	});

	it("re-fetches a chunk on disk that fails its hash", async () => {
		// Resume trusts hashes, never file length — a truncated or tampered partial must not
		// be mistaken for progress.
		const file = bytes(CHUNK * 3, 12);
		const out = join(dir, "tampered.bin");
		const partial = new Uint8Array(file);
		partial[CHUNK + 5] ^= 0xff; // corrupt chunk 1
		writeFileSync(out, partial);

		const log = { manifestCalls: 0, chunkCalls: [] as number[] };
		const result = await pullAsset({
			...base(out),
			resume: true,
			fetchImpl: stub({ manifest: await makeManifest(file), file, log }),
		});

		expect(result.chunksSkipped).toBe(2);
		expect(log.chunkCalls).toEqual([1]);
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
	});

	it("without --resume, re-fetches everything even when the file is already correct", async () => {
		const file = bytes(CHUNK * 2, 13);
		const out = join(dir, "complete.bin");
		writeFileSync(out, file);

		const log = { manifestCalls: 0, chunkCalls: [] as number[] };
		const result = await pullAsset({
			...base(out),
			fetchImpl: stub({ manifest: await makeManifest(file), file, log }),
		});
		expect(result.chunksSkipped).toBe(0);
		expect(log.chunkCalls.length).toBe(2);
	});
});

describe("access", () => {
	it("reports a denial distinctly, and writes nothing", async () => {
		const file = bytes(CHUNK, 14);
		const out = join(dir, "denied.bin");
		await expect(
			pullAsset({
				...base(out),
				fetchImpl: stub({ manifest: await makeManifest(file), file, manifestStatus: 403 }),
			}),
		).rejects.toBeInstanceOf(AccessDeniedError);
		expect(existsSync(out)).toBe(false);
	});

	it("distinguishes not-signed-in from not-entitled", async () => {
		const file = bytes(CHUNK, 15);
		await expect(
			pullAsset({
				...base(join(dir, "unauth.bin")),
				fetchImpl: stub({ manifest: await makeManifest(file), file, manifestStatus: 401 }),
			}),
		).rejects.toThrow(/signed in/i);
	});
});

describe("the token", () => {
	it("re-mints before expiry rather than waiting to be rejected", async () => {
		const file = bytes(CHUNK * 2, 16);
		const log = { manifestCalls: 0, chunkCalls: [] as number[] };
		await pullAsset({
			...base(join(dir, "renew.bin")),
			fetchImpl: stub({
				manifest: await makeManifest(file),
				file,
				tokens: [makeToken(30), makeToken(900)],
				log,
			}),
		});
		expect(log.manifestCalls).toBeGreaterThan(1);
	});

	it("does not re-mint a token with plenty of life", async () => {
		const file = bytes(CHUNK * 2, 17);
		const log = { manifestCalls: 0, chunkCalls: [] as number[] };
		await pullAsset({
			...base(join(dir, "norenew.bin")),
			fetchImpl: stub({ manifest: await makeManifest(file), file, tokens: [makeToken(900)], log }),
		});
		expect(log.manifestCalls).toBe(1);
	});
});
