// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `anthersp2p seed` — the first peer that can actually serve.
 *
 * Two things here are load-bearing and everything else is plumbing:
 *
 * 1. **It verifies the token itself.** 45.03's argument is that the swarm is *defined* by
 *    token verification, and a peer that serves without checking isn't in it — so a seeder
 *    that hands bytes to an unsigned, expired, or wrong-asset token is not a bug, it is the
 *    boundary argument failing.
 * 2. **It refuses to serve bytes that aren't the asset.** A seeder pointed at a stale build
 *    looks to every downloader like a hostile peer, so it fails at boot instead.
 *
 * A real Ed25519 keypair is generated per suite and tokens are signed with it, so the
 * signature checks exercise the genuine `crypto.subtle` path rather than a stub that could
 * agree with anything.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkRange, type Manifest, sha256hex, totalChunks } from "@anthers/shared/p2p";
import { SeedError, type Seeder, startSeeder } from "./seed";

const CHUNK = 1024;
const HUB = "https://hub.test";

let dir: string;
let priv: CryptoKey;
let publicKeyB64: string;
const running: Seeder[] = [];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "anthersp2p-seed-"));
	const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	priv = (kp as CryptoKeyPair).privateKey;
	const raw = await crypto.subtle.exportKey("raw", (kp as CryptoKeyPair).publicKey);
	publicKeyB64 = Buffer.from(new Uint8Array(raw)).toString("base64url");
});

afterEach(() => {
	for (const s of running.splice(0)) s.stop();
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
		workId: 5,
		workPublicId: "5",
		assetId: 12,
		assetFilename: "game.zip",
		assetMimeType: "application/zip",
		assetSize: file.length,
		assetSha256: await sha256hex(file),
		chunkSize: CHUNK,
		chunks,
	};
}

/** Sign a real token with the suite's key — the seeder verifies these for real. */
async function mint(over: Partial<{ w: number; a: number; u: number; e: number }> = {}) {
	const payload = {
		w: 5,
		a: 12,
		u: 42,
		e: Math.floor(Date.now() / 1000) + 900,
		...over,
	};
	const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
	const sig = await crypto.subtle.sign(
		"Ed25519",
		priv,
		new TextEncoder().encode(payloadB64) as BufferSource,
	);
	return `${payloadB64}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

function hubStub(manifest: Manifest): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/manifest")) {
			return new Response(JSON.stringify({ manifest, token: "unused" }), { status: 200 });
		}
		if (url.endsWith("/pubkey")) {
			return new Response(JSON.stringify({ keyId: 1, publicKey: publicKeyB64 }), { status: 200 });
		}
		throw new Error(`unexpected hub fetch ${url}`);
	}) as typeof fetch;
}

async function seed(file: Uint8Array, opts: { onDisk?: Uint8Array } = {}): Promise<Seeder> {
	const manifest = await makeManifest(file);
	const path = join(dir, "local.zip");
	writeFileSync(path, opts.onDisk ?? file);
	const s = await startSeeder({
		baseUrl: HUB,
		token: "session",
		workId: "5",
		assetId: 12,
		filePath: path,
		port: 0, // ephemeral — parallel suites must not fight over a fixed port
		fetchImpl: hubStub(manifest),
	});
	running.push(s);
	return s;
}

const chunkUrl = (s: Seeder, i: number) =>
	`http://localhost:${s.port}/api/p2p/works/5/assets/12/chunks/${i}`;

describe("serving chunks", () => {
	it("serves a verified chunk to a valid token", async () => {
		const file = bytes(CHUNK * 3, 1);
		const s = await seed(file);
		const res = await fetch(chunkUrl(s, 1), {
			headers: { Authorization: `Bearer ${await mint()}` },
		});

		expect(res.status).toBe(200);
		const got = new Uint8Array(await res.arrayBuffer());
		expect(got).toEqual(file.subarray(CHUNK, CHUNK * 2));
		expect(res.headers.get("X-Chunk-Sha256")).toBe(await sha256hex(got));
		expect(s.served()).toEqual({ chunks: 1, bytes: CHUNK });
	});

	it("serves the short final chunk at its real size", async () => {
		const file = bytes(CHUNK * 2 + 300, 2);
		const s = await seed(file);
		const res = await fetch(chunkUrl(s, 2), {
			headers: { Authorization: `Bearer ${await mint()}` },
		});
		expect(res.status).toBe(200);
		expect((await res.arrayBuffer()).byteLength).toBe(300);
	});

	it("reassembles into the original file, chunk by chunk", async () => {
		// The end-to-end property: a downloader pointed at this peer gets the asset.
		const file = bytes(CHUNK * 4 + 77, 3);
		const s = await seed(file);
		const token = await mint();
		const out = new Uint8Array(file.length);
		for (let i = 0; i < totalChunks(file.length, CHUNK); i++) {
			const res = await fetch(chunkUrl(s, i), { headers: { Authorization: `Bearer ${token}` } });
			const { offset } = chunkRange(i, CHUNK, file.length);
			out.set(new Uint8Array(await res.arrayBuffer()), offset);
		}
		expect(out).toEqual(file);
		expect(await sha256hex(out)).toBe((await makeManifest(file)).assetSha256);
	});

	it("answers /health without a token", async () => {
		const s = await seed(bytes(CHUNK, 4));
		const res = await fetch(`http://localhost:${s.port}/health`);
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("ok");
	});
});

/**
 * 🚨 The boundary argument, made testable.
 *
 * 45.03 rests on the swarm being *defined* by token verification — a peer that serves
 * without checking is not in it, and the legal framing that distinguishes this from open
 * BitTorrent stops holding. Each of these is that claim.
 */
describe("both sides check", () => {
	it("refuses a request with no token", async () => {
		const s = await seed(bytes(CHUNK * 2, 5));
		expect((await fetch(chunkUrl(s, 0))).status).toBe(401);
		expect(s.served().chunks).toBe(0);
	});

	it("refuses a token that is not a token", async () => {
		const s = await seed(bytes(CHUNK * 2, 6));
		const res = await fetch(chunkUrl(s, 0), { headers: { Authorization: "Bearer garbage" } });
		expect(res.status).toBe(401);
	});

	it("refuses a token signed by the wrong key", async () => {
		// The case that matters most: a peer that verified only the *shape* of a token would
		// serve anything, and this is what proves the signature is actually checked.
		const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
		const payloadB64 = Buffer.from(
			JSON.stringify({ w: 5, a: 12, u: 42, e: Math.floor(Date.now() / 1000) + 900 }),
		).toString("base64url");
		const sig = await crypto.subtle.sign(
			"Ed25519",
			(other as CryptoKeyPair).privateKey,
			new TextEncoder().encode(payloadB64) as BufferSource,
		);
		const forged = `${payloadB64}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;

		const s = await seed(bytes(CHUNK * 2, 7));
		const res = await fetch(chunkUrl(s, 0), { headers: { Authorization: `Bearer ${forged}` } });
		expect(res.status).toBe(401);
		expect(s.served().chunks).toBe(0);
	});

	it("refuses a tampered payload", async () => {
		const s = await seed(bytes(CHUNK * 2, 8));
		const token = await mint();
		const [, sig] = token.split(".");
		const swapped = Buffer.from(
			JSON.stringify({ w: 5, a: 12, u: 999, e: Math.floor(Date.now() / 1000) + 9000 }),
		).toString("base64url");
		const res = await fetch(chunkUrl(s, 0), {
			headers: { Authorization: `Bearer ${swapped}.${sig}` },
		});
		expect(res.status).toBe(401);
	});

	it("refuses an expired token", async () => {
		const s = await seed(bytes(CHUNK * 2, 9));
		const res = await fetch(chunkUrl(s, 0), {
			headers: { Authorization: `Bearer ${await mint({ e: Math.floor(Date.now() / 1000) - 60 })}` },
		});
		expect(res.status).toBe(401);
	});

	it("refuses a token minted for a different asset", async () => {
		// The token is scoped to one asset, and that scope only exists if someone compares it.
		const s = await seed(bytes(CHUNK * 2, 10));
		const res = await fetch(chunkUrl(s, 0), {
			headers: { Authorization: `Bearer ${await mint({ a: 999 })}` },
		});
		expect(res.status).toBe(401);
		expect(s.served().chunks).toBe(0);
	});

	it("does not serve anything outside its own asset's chunk path", async () => {
		const s = await seed(bytes(CHUNK * 2, 11));
		const token = `Bearer ${await mint()}`;
		for (const path of [
			"/api/p2p/works/5/assets/99/chunks/0",
			"/api/p2p/works/9/assets/12/chunks/0",
			"/etc/passwd",
			"/api/p2p/works/5/assets/12/chunks/../../../secret",
		]) {
			const res = await fetch(`http://localhost:${s.port}${path}`, {
				headers: { Authorization: token },
			});
			expect(res.status).toBe(404);
		}
	});

	it("refuses a chunk index outside the manifest", async () => {
		const s = await seed(bytes(CHUNK * 2, 12));
		const token = `Bearer ${await mint()}`;
		for (const i of [2, 99, -1]) {
			const res = await fetch(chunkUrl(s, i), { headers: { Authorization: token } });
			expect(res.status).toBe(404);
		}
	});
});

describe("refusing to serve the wrong bytes", () => {
	it("will not start when the local file does not match the manifest", async () => {
		// A seeder pointed at a stale build looks like a hostile peer to every downloader —
		// their hash checks fail and they drop it. Failing at boot is the difference between
		// a misconfiguration and a mystery.
		const file = bytes(CHUNK * 3, 13);
		const wrong = new Uint8Array(file);
		wrong[CHUNK + 10] ^= 0xff;
		await expect(seed(file, { onDisk: wrong })).rejects.toBeInstanceOf(SeedError);
	});

	it("names the chunk that disagrees, not just 'mismatch'", async () => {
		const file = bytes(CHUNK * 3, 14);
		const wrong = new Uint8Array(file);
		wrong[CHUNK * 2 + 3] ^= 0xff;
		await expect(seed(file, { onDisk: wrong })).rejects.toThrow(/at chunk 2/);
	});

	it("will not start when the local file is the wrong size", async () => {
		const file = bytes(CHUNK * 3, 15);
		await expect(seed(file, { onDisk: bytes(CHUNK * 2, 15) })).rejects.toThrow(
			/bytes; the manifest/,
		);
	});

	it("stops serving a chunk that stopped matching, without needing a restart", async () => {
		// The boot check proves the file was right when the process started; a seeder runs
		// for weeks and the file can be replaced under it — a rebuild written to the same
		// path, a bad sync, a partial copy. Serving those bytes would fail the downloader's
		// hash check and read to them as a hostile peer rather than a stale one.
		//
		// Verified by sabotage: removing the serve-time re-hash broke nothing until this
		// test existed, because every other case here has a file that never changes.
		const file = bytes(CHUNK * 3, 16);
		const s = await seed(file);
		const token = `Bearer ${await mint()}`;

		expect((await fetch(chunkUrl(s, 1), { headers: { Authorization: token } })).status).toBe(200);

		// Rewrite in place, so the seeder's already-open descriptor sees the new bytes.
		const replaced = new Uint8Array(file);
		replaced[CHUNK + 20] ^= 0xff;
		writeFileSync(join(dir, "local.zip"), replaced);

		const res = await fetch(chunkUrl(s, 1), { headers: { Authorization: token } });
		expect(res.status).toBe(409);

		// Untouched chunks keep working — one bad region must not take the whole peer down.
		expect((await fetch(chunkUrl(s, 0), { headers: { Authorization: token } })).status).toBe(200);
	});
});
