// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery — the production hub-hosted seeder (per 45.04 + 45.05).
 *
 * This suite covers the three things that have to work for the P2P download path to be
 * trustworthy:
 *
 * 1. The manifest endpoint re-resolves access (the private-by-default delivery rule,
 *    restated for P2P in 40.03). A denied viewer gets 403, no manifest, no token.
 * 2. The token gates chunk access — a valid token gets bytes, an invalid/expired/wrong-
 *    asset token gets 401/403. No token, no chunks.
 * 3. The manifest is content-addressed and verifiable — chunks hash-check, reassembly
 *    produces the original file, the end-to-end SHA-256 matches.
 *
 * The token uses Ed25519 asymmetric signing (45.05), so the test bootstraps a keypair
 * at setup. The public key endpoint is also tested — peers need it to verify tokens.
 *
 * Works and assets are inserted directly (same pattern as delivery-access.test.ts)
 * because the upload route queues a transcode and pg-boss isn't running in the test
 * process. The asset bytes are written directly to storage.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, users, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { generateKeyPair, _setPrivateKeyForTest, _resetKeyCache } from "../p2p/token";
import { buildManifest, chunkRange, verifyChunk, verifyFile, CHUNK_SIZE } from "../p2p/manifest";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string) {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `p2p_${id}`;
const viewerName = `p2p_viewer_${id}`;
const deniedName = `p2p_denied_${id}`;

/** A deterministic test file — 1 MiB of pseudo-random bytes (small enough to be fast, big enough to chunk). */
const FILE_SIZE = 1024 * 1024;
const STORAGE_KEY = `test/p2p-${id}/test-file.zip`;

function generateTestBytes(size: number): Uint8Array {
	const bytes = new Uint8Array(size);
	let state = 0x12345678;
	for (let i = 0; i < size; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		bytes[i] = (state >> 16) & 0xff;
	}
	return bytes;
}

describe("P2P delivery", () => {
	let creatorCookie: string;
	let viewerCookie: string;
	let deniedCookie: string;
	let creatorId: number;
	let workId: number;
	let assetId: number;
	let testBytes: Uint8Array;
	let manifestFromServer: any;
	let token: string;

	beforeAll(async () => {
		// Bootstrap the Ed25519 signing key for the hub
		const kp = await generateKeyPair();
		_setPrivateKeyForTest(kp.privateKeyB64);

		// Clean up any prior test data
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName}, ${deniedName})`);

		// Sign up three users
		creatorCookie = await signUp(creatorName);
		viewerCookie = await signUp(viewerName);
		deniedCookie = await signUp(deniedName);

		// Get the creator's ID
		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName))
			.limit(1);
		creatorId = creator.id;

		// Create a free, downloadable Work (everyone allowed at threshold 0, price 0)
		const work = await insertWork({
			creatorId,
			type: "game",
			title: "P2P Test Game",
			downloadEnabled: true,
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		workId = work.id;

		// Write a test file to storage
		testBytes = generateTestBytes(FILE_SIZE);
		await storage.upload(STORAGE_KEY, testBytes, "application/zip", "private");

		// Insert an asset row pointing at the stored file
		const [asset] = await db
			.insert(assets)
			.values({
				workId,
				file: STORAGE_KEY,
				filename: "test-game.zip",
				fileSize: FILE_SIZE,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			})
			.returning();
		assetId = asset.id;

		// Fetch the manifest + token as the entitled viewer
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		manifestFromServer = body.manifest;
		token = body.token;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// Clean up storage
		try {
			await storage.delete(STORAGE_KEY);
		} catch {}
		// Reset the key cache so other test suites aren't affected
		_resetKeyCache();
	});

	// ── Public key endpoint ──────────────────────────────────────────────────────

	it("serves the hub's Ed25519 public key", async () => {
		const res = await req("/api/p2p/pubkey");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.algorithm).toBe("Ed25519");
		expect(body.keyId).toBe(1);
		expect(body.publicKey).toBeTruthy();
		// Ed25519 public key is 32 bytes → 43 base64url chars
		expect(body.publicKey.length).toBe(43);
	});

	// ── Manifest format (per 45.04) ──────────────────────────────────────────────

	it("returns a content-addressed manifest with the right shape", () => {
		expect(manifestFromServer.specVersion).toBe(1);
		expect(manifestFromServer.workId).toBe(workId);
		expect(manifestFromServer.assetId).toBe(assetId);
		expect(manifestFromServer.assetFilename).toBe("test-game.zip");
		expect(manifestFromServer.assetSize).toBe(FILE_SIZE);
		expect(manifestFromServer.assetMimeType).toBe("application/zip");
		expect(manifestFromServer.chunkSize).toBe(CHUNK_SIZE);
		expect(manifestFromServer.assetSha256).toBeTruthy();
		// Chunks: array of hex SHA-256 strings
		expect(Array.isArray(manifestFromServer.chunks)).toBe(true);
		expect(manifestFromServer.chunks.length).toBe(Math.ceil(FILE_SIZE / CHUNK_SIZE));
		for (const hash of manifestFromServer.chunks) {
			expect(hash).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("the manifest's assetSha256 matches the actual file", async () => {
		const hash = await crypto.subtle.digest("SHA-256", testBytes as BufferSource);
		const hex = Array.from(new Uint8Array(hash))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		expect(manifestFromServer.assetSha256).toBe(hex);
	});

	// ── Access control (the private-by-default delivery rule) ────────────────────

	it("denies the manifest to a viewer when the Work is locked", async () => {
		// Create a locked Work
		const lockedWork = await insertWork({
			creatorId,
			type: "game",
			title: "Locked Game",
			downloadEnabled: true,
			anthersAccess: [{ threshold: 0, allow: false, price: "0" }],
		});
		const [lockedAsset] = await db
			.insert(assets)
			.values({
				workId: lockedWork.id,
				file: STORAGE_KEY,
				filename: "locked.zip",
				fileSize: FILE_SIZE,
				mimeType: "application/zip",
			})
			.returning();

		// Denied viewer (signed-in but no access)
		const denied = await req(`/api/p2p/works/${lockedWork.id}/assets/${lockedAsset.id}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: deniedCookie },
		});
		expect(denied.status).toBe(403);
		const body = await denied.json();
		expect(body.error).toBeTruthy();
		expect(body.token).toBeUndefined();
		expect(body.manifest).toBeUndefined();

		// Anonymous viewer
		const anon = await req(`/api/p2p/works/${lockedWork.id}/assets/${lockedAsset.id}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
		});
		expect(anon.status).toBe(403);
	});

	it("grants the manifest to the Work's creator (owner bypass)", async () => {
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.manifest).toBeTruthy();
		expect(body.token).toBeTruthy();
	});

	// ── Token verification (per 45.05) ───────────────────────────────────────────

	it("serves a chunk to a valid token", async () => {
		const chunkIndex = 0;
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/${chunkIndex}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
		expect(res.headers.get("X-Chunk-Sha256")).toBe(manifestFromServer.chunks[chunkIndex]);

		const chunkBytes = new Uint8Array(await res.arrayBuffer());
		const { offset, size } = chunkRange(
			chunkIndex,
			manifestFromServer.chunks.length,
			CHUNK_SIZE,
			FILE_SIZE,
		);
		expect(chunkBytes.length).toBe(size);

		// Verify the chunk matches the original file bytes
		expect(chunkBytes).toEqual(testBytes.subarray(offset, offset + size));

		// Verify the per-chunk hash
		expect(await verifyChunk(chunkBytes, manifestFromServer, chunkIndex)).toBe(true);
	});

	it("rejects a chunk request with no token (401)", async () => {
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/0`);
		expect(res.status).toBe(401);
	});

	it("rejects a chunk request with an invalid token (401)", async () => {
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/0`, {
			headers: { Authorization: "Bearer not-a-valid-token" },
		});
		expect(res.status).toBe(401);
	});

	it("rejects a chunk request with a tampered token (401)", async () => {
		// Tamper with the signature
		const [payload, sig] = token.split(".");
		const tamperedSig = sig.slice(0, -4) + "AAAA";
		const tampered = `${payload}.${tamperedSig}`;
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/0`, {
			headers: { Authorization: `Bearer ${tampered}` },
		});
		expect(res.status).toBe(401);
	});

	it("rejects a token scoped to a different asset (403)", async () => {
		// The token is scoped to assetId; requesting a chunk for a different asset should 403.
		// We need a second asset on the same Work to test this.
		const [otherAsset] = await db
			.insert(assets)
			.values({
				workId,
				file: STORAGE_KEY,
				filename: "other.zip",
				fileSize: FILE_SIZE,
				mimeType: "application/zip",
			})
			.returning();

		const res = await req(`/api/p2p/works/${workId}/assets/${otherAsset.id}/chunks/0`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(403);
	});

	it("returns 404 for a chunk index out of range", async () => {
		const outOfRange = manifestFromServer.chunks.length + 10;
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/${outOfRange}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(404);
	});

	// ── End-to-end reassembly ─────────────────────────────────────────────────────

	it("reassembles all chunks into the original file (end-to-end verification)", async () => {
		const numChunks = manifestFromServer.chunks.length;
		const reassembled = new Uint8Array(FILE_SIZE);

		for (let i = 0; i < numChunks; i++) {
			const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/${i}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			expect(res.status).toBe(200);
			const chunkBytes = new Uint8Array(await res.arrayBuffer());
			const { offset } = chunkRange(i, numChunks, CHUNK_SIZE, FILE_SIZE);
			reassembled.set(chunkBytes, offset);
		}

		// End-to-end hash verification
		expect(await verifyFile(reassembled, manifestFromServer)).toBe(true);
		// Byte-for-byte match with the original
		expect(reassembled).toEqual(testBytes);
	});

	// ── Bandwidth accounting ──────────────────────────────────────────────────────

	it("tracks hub-served bytes in the bandwidth report", async () => {
		// The previous tests served some chunks; the report should show them
		const res = await req("/api/p2p/bandwidth-report");
		expect(res.status).toBe(200);
		const report = await res.json();
		expect(report[assetId]).toBeTruthy();
		expect(report[assetId].filename).toBe("test-game.zip");
		expect(report[assetId].hubBytesServed).toBeGreaterThan(0);
		expect(report[assetId].fileSize).toBe(FILE_SIZE);
	});
});