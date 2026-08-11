// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The swarm, end to end — a real download whose bytes come from a peer.
 *
 * Everything else in this repo tests one side. This is the first test where a **real seeder
 * process serves a real puller over real HTTP**, with only the hub stubbed — and it is the
 * first time in the P2P lane that two parties have traded bytes at all. Until the seeder
 * existed, the swarm had no members and every byte came from the hub.
 *
 * What it establishes, and why each half matters:
 *
 * - **The manifest and token come from the hub; the bytes come from the peer.** That split
 *   is the architecture. Only the hub can check entitlement and only the hub can sign, so
 *   the peer never sees a credential it could have forged, and the client verifies every
 *   chunk against the hub's manifest no matter who served it.
 * - **The peer serves the hub's own URL shape**, so the client change is an origin swap and
 *   nothing else. If this needed a peer dialect there would be two download architectures,
 *   which is exactly what 45.01 § 3 says there must not be.
 * - **A hostile peer cannot poison the file**, because the manifest is the authority and the
 *   client hashes before writing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkRange, type Manifest, sha256hex, totalChunks } from "@anthers/shared/p2p";
import { pullAsset, VerificationError } from "./pull";
import { type Seeder, startSeeder } from "./seed";

const CHUNK = 1024;
const HUB = "https://hub.test";

let dir: string;
let priv: CryptoKey;
let publicKeyB64: string;
const running: Seeder[] = [];

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "anthersp2p-swarm-"));
	const kp = (await crypto.subtle.generateKey("Ed25519", true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	priv = kp.privateKey;
	publicKeyB64 = Buffer.from(
		new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)),
	).toString("base64url");
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

/** A genuinely signed delivery token, exactly as the hub would mint one. */
async function mintToken(): Promise<string> {
	const payloadB64 = Buffer.from(
		JSON.stringify({ w: 5, a: 12, u: 42, e: Math.floor(Date.now() / 1000) + 900 }),
	).toString("base64url");
	const sig = await crypto.subtle.sign(
		"Ed25519",
		priv,
		new TextEncoder().encode(payloadB64) as BufferSource,
	);
	return `${payloadB64}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

/**
 * The hub: mints tokens and serves manifests, and **refuses to serve a single chunk**.
 *
 * That refusal is the assertion. If the puller silently fell back to the hub the test would
 * still pass with a green tick and prove nothing about the peer, so the stub throws on any
 * chunk request rather than answering one.
 */
function hubStub(manifest: Manifest): typeof fetch {
	const realFetch = globalThis.fetch;
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		// Anything not addressed to the hub is a PEER, and goes over a real socket to the
		// real seeder. Stubbing that too would make this an elaborate way to test the stub.
		if (!url.startsWith(HUB)) return realFetch(input, init);
		if (url.endsWith("/manifest")) {
			return new Response(JSON.stringify({ manifest, token: await mintToken() }), { status: 200 });
		}
		if (url.endsWith("/pubkey")) {
			return new Response(JSON.stringify({ keyId: 1, publicKey: publicKeyB64 }), { status: 200 });
		}
		if (url.includes("/chunks/")) {
			throw new Error("the hub was asked for a chunk — the peer should have served it");
		}
		throw new Error(`unexpected hub fetch ${url}`);
	}) as typeof fetch;
}

async function startPeer(file: Uint8Array, onDisk?: Uint8Array): Promise<Seeder> {
	const path = join(dir, "seeded.zip");
	writeFileSync(path, onDisk ?? file);
	const s = await startSeeder({
		baseUrl: HUB,
		token: "creator-session",
		workId: "5",
		assetId: 12,
		filePath: path,
		port: 0,
		fetchImpl: hubStub(await makeManifest(file)),
		skipVerify: onDisk !== undefined,
	});
	running.push(s);
	return s;
}

describe("a download served by a peer", () => {
	it("pulls every byte from the peer and verifies against the hub's manifest", async () => {
		const file = bytes(CHUNK * 5 + 123, 1);
		const peer = await startPeer(file);
		const out = join(dir, "downloaded.zip");

		const result = await pullAsset({
			baseUrl: HUB,
			chunkBaseUrl: `http://localhost:${peer.port}`,
			token: "viewer-session",
			workId: "5",
			assetId: 12,
			outputPath: out,
			fetchImpl: hubStub(await makeManifest(file)),
		});

		// Byte-exact, verified end to end by the puller itself.
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
		expect(result.bytesWritten).toBe(file.length);

		// And the peer really carried it — every chunk, not a subset.
		expect(peer.served().chunks).toBe(totalChunks(file.length, CHUNK));
		expect(peer.served().bytes).toBe(file.length);
	});

	it("works with concurrency, which is where positioned writes earn their keep", async () => {
		const file = bytes(CHUNK * 12, 2);
		const peer = await startPeer(file);
		const out = join(dir, "concurrent.zip");

		await pullAsset({
			baseUrl: HUB,
			chunkBaseUrl: `http://localhost:${peer.port}`,
			token: "viewer-session",
			workId: "5",
			assetId: 12,
			outputPath: out,
			concurrency: 8,
			fetchImpl: hubStub(await makeManifest(file)),
		});

		expect(new Uint8Array(readFileSync(out))).toEqual(file);
		expect(peer.served().chunks).toBe(12);
	});

	it("resumes from a peer, fetching only the chunks it is missing", async () => {
		const file = bytes(CHUNK * 6, 3);
		const peer = await startPeer(file);
		const out = join(dir, "partial.zip");

		const partial = new Uint8Array(file.length);
		partial.set(file.subarray(0, CHUNK * 4), 0);
		writeFileSync(out, partial);

		const result = await pullAsset({
			baseUrl: HUB,
			chunkBaseUrl: `http://localhost:${peer.port}`,
			token: "viewer-session",
			workId: "5",
			assetId: 12,
			outputPath: out,
			resume: true,
			fetchImpl: hubStub(await makeManifest(file)),
		});

		expect(result.chunksSkipped).toBe(4);
		expect(peer.served().chunks).toBe(2);
		expect(new Uint8Array(readFileSync(out))).toEqual(file);
	});
});

describe("the peer is not trusted", () => {
	/**
	 * A deliberately dishonest peer — NOT our seeder.
	 *
	 * The first draft of this test tampered with the seeder's own file and expected the
	 * client to catch it. The client never got the chance: the seeder re-hashes before
	 * serving and answered 409, so the download failed for the right reason by the wrong
	 * route and proved nothing about client-side distrust. Our seeder is honest by
	 * construction, which is exactly why testing "the client does not trust a peer" needs a
	 * peer that isn't ours.
	 */
	function hostilePeer(file: Uint8Array, corruptIndex: number) {
		return Bun.serve({
			port: 0,
			fetch(req) {
				const m = new URL(req.url).pathname.match(/\/chunks\/(\d+)$/);
				if (!m) return new Response("no", { status: 404 });
				const i = Number(m[1]);
				const { offset, size } = chunkRange(i, CHUNK, file.length);
				const slice = file.slice(offset, offset + size);
				if (i === corruptIndex) slice[0] ^= 0xff;
				return new Response(slice.buffer as ArrayBuffer, { status: 200 });
			},
		});
	}

	it("rejects bytes from a peer that lies, and never writes them", async () => {
		// The whole trust model in one test: a peer supplies bytes, the hub's manifest
		// decides whether they are the file. Nothing the peer does can make them accepted.
		const file = bytes(CHUNK * 3, 4);
		const liar = hostilePeer(file, 1);
		const out = join(dir, "poisoned.zip");
		try {
			await expect(
				pullAsset({
					baseUrl: HUB,
					chunkBaseUrl: `http://localhost:${liar.port}`,
					token: "viewer-session",
					workId: "5",
					assetId: 12,
					outputPath: out,
					concurrency: 1,
					fetchImpl: hubStub(await makeManifest(file)),
				}),
			).rejects.toBeInstanceOf(VerificationError);

			// The corrupt chunk must not be on disk — verification happens before the write.
			const written = new Uint8Array(readFileSync(out));
			const { offset, size } = chunkRange(1, CHUNK, file.length);
			expect(written.subarray(offset, offset + size).every((b) => b === 0)).toBe(true);
		} finally {
			liar.stop(true);
		}
	});

	it("fails the download rather than completing it when a peer serves a stale chunk", async () => {
		// Our own seeder's 409, seen from the client side. A peer whose file changed under it
		// stops the download loudly instead of quietly handing over a wrong file.
		const file = bytes(CHUNK * 3, 5);
		const peer = await startPeer(file);
		const replaced = new Uint8Array(file);
		replaced[CHUNK + 9] ^= 0xff;
		writeFileSync(join(dir, "seeded.zip"), replaced);

		await expect(
			pullAsset({
				baseUrl: HUB,
				chunkBaseUrl: `http://localhost:${peer.port}`,
				token: "viewer-session",
				workId: "5",
				assetId: 12,
				outputPath: join(dir, "stale.zip"),
				concurrency: 1,
				fetchImpl: hubStub(await makeManifest(file)),
			}),
		).rejects.toThrow(/HTTP 409/);
	});

	it("gets nothing from a peer without presenting the hub's token", async () => {
		// Restates from the client side what seed.test.ts asserts from the server side: the
		// peer is not an open file server that happens to be reachable.
		const file = bytes(CHUNK * 2, 6);
		const peer = await startPeer(file);
		const res = await fetch(`http://localhost:${peer.port}/api/p2p/works/5/assets/12/chunks/0`);
		expect(res.status).toBe(401);
		expect(peer.served().chunks).toBe(0);
	});
});
