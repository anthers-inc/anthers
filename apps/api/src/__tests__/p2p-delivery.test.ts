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
import { assets, purchases, users, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import {
	buildManifest,
	buildManifestFromStorage,
	CHUNK_SIZE,
	chunkRange,
	type Manifest,
	verifyChunk,
	verifyFile,
} from "../p2p/manifest";
import { _resetSeederCacheForTest } from "../p2p/routes";
import { _resetKeyCache, _setPrivateKeyForTest, generateKeyPair } from "../p2p/token";
import { storage } from "../services/storage/index.js";
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

// Annotated Uint8Array<ArrayBuffer>, not a bare Uint8Array: bare widens to
// Uint8Array<ArrayBufferLike>, which no longer compares against the Uint8Array<ArrayBuffer>
// that `new Uint8Array(await res.arrayBuffer())` produces on the other side of the
// byte-for-byte assertions below.
function generateTestBytes(size: number): Uint8Array<ArrayBuffer> {
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
	let viewerId: number;
	let workId: number;
	let assetId: number;
	let testBytes: Uint8Array<ArrayBuffer>;
	let manifestFromServer: any;
	let token: string;

	beforeAll(async () => {
		// Bootstrap the Ed25519 signing key for the hub
		const kp = await generateKeyPair();
		_setPrivateKeyForTest(kp.privateKeyB64);

		// Clean up any prior test data
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName}, ${deniedName})`,
		);

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

		const [viewer] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, viewerName))
			.limit(1);
		viewerId = viewer.id;

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
		const { offset, size } = chunkRange(chunkIndex, CHUNK_SIZE, FILE_SIZE);
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
			const { offset } = chunkRange(i, CHUNK_SIZE, FILE_SIZE);
			reassembled.set(chunkBytes, offset);
		}

		// End-to-end hash verification
		expect(await verifyFile(reassembled, manifestFromServer)).toBe(true);
		// Byte-for-byte match with the original
		expect(reassembled).toEqual(testBytes);
	});

	// ── Delivery bookkeeping ──────────────────────────────────────────────────────
	//
	// 🚨 `markPurchaseDownloaded` shipped with ZERO callers — no download path had ever
	// stamped `purchases.downloaded_at`, the signed-URL one included. Two things read it and
	// both were silently disabled: the refund cap counts only refunds `WHERE downloaded_at
	// IS NOT NULL` (so the three-per-year limit was unreachable), and `refunds.ts` books the
	// delivery fee only when it is set (so Anthers absorbed the bandwidth on every refund).
	// Now that P2P is the whole download path, this is where the stamp belongs.

	it("stamps a purchase as delivered when the first chunk is served", async () => {
		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId: viewerId,
				creatorId,
				workId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				crfFee: "0.00",
				creatorEarnings: "4.55",
				stripePaymentIntentId: `pi_p2p_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
			})
			.returning();
		expect(purchase.downloadedAt).toBeNull();

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/0`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);

		// The stamp is fire-and-forget so a bookkeeping failure cannot 500 a working
		// download, so give it a moment to land rather than asserting into the race.
		await Bun.sleep(150);
		const [after] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(after.downloadedAt).not.toBeNull();

		await db.delete(purchases).where(eq(purchases.id, purchase.id));
	});

	it("does not re-stamp a purchase that was already delivered", async () => {
		// The column answers "has this been delivered at all", not "how often" — so a second
		// download must not move the date, or the refund window would slide with every pull.
		const stamped = new Date("2026-01-01T00:00:00Z");
		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId: viewerId,
				creatorId,
				workId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				crfFee: "0.00",
				creatorEarnings: "4.55",
				stripePaymentIntentId: `pi_p2p_${crypto.randomUUID().slice(0, 12)}`,
				status: "completed",
				downloadedAt: stamped,
			})
			.returning();

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/0`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);

		await Bun.sleep(150);
		const [after] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(after.downloadedAt?.toISOString()).toBe(stamped.toISOString());

		await db.delete(purchases).where(eq(purchases.id, purchase.id));
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

	// ── The streaming seeder ──────────────────────────────────────────────────────
	//
	// The seeder used to read each asset into memory in full and keep it there for the
	// life of the process. These cover the replacement: ranged reads out of storage, a
	// manifest built by streaming, and the cache-miss rebuild that a bounded cache makes
	// an ordinary event rather than an error.

	it("readRange returns exactly the requested slice", async () => {
		const slice = await storage.readRange(STORAGE_KEY, 1000, 256);
		expect(slice).not.toBeNull();
		expect(slice?.length).toBe(256);
		expect(new Uint8Array(slice as Uint8Array)).toEqual(testBytes.subarray(1000, 1256));
	});

	it("readRange past the end returns what exists, not an error", async () => {
		// The manifest walk relies on this to discover end-of-file: a short read means the
		// last chunk, and an empty read means there is nothing more.
		const tail = await storage.readRange(STORAGE_KEY, FILE_SIZE - 100, CHUNK_SIZE);
		expect(tail?.length).toBe(100);

		const past = await storage.readRange(STORAGE_KEY, FILE_SIZE, CHUNK_SIZE);
		expect(past?.length ?? 0).toBe(0);
	});

	it("readRange returns null for a key that does not exist", async () => {
		expect(await storage.readRange(`${STORAGE_KEY}.nope`, 0, 16)).toBeNull();
	});

	it("the streaming manifest is identical to the in-memory one", async () => {
		// The anti-drift assertion. Both entry points delegate to one loop, and this is
		// what would fail if someone re-implemented either of them separately.
		const subject = {
			workId,
			workPublicId: manifestFromServer.workPublicId,
			assetId,
			assetFilename: "test-game.zip",
			assetMimeType: "application/zip",
		};
		const fromBytes = await buildManifest({ ...subject, bytes: testBytes });
		const fromStorage = await buildManifestFromStorage({ ...subject, storageKey: STORAGE_KEY });
		expect(fromStorage).not.toBeNull();
		expect(fromStorage).toEqual(fromBytes);
		expect(fromStorage?.assetSize).toBe(FILE_SIZE);
	});

	it("returns null rather than an empty manifest for a missing object", async () => {
		// The caller has to be able to tell "no such asset" from "an asset of zero bytes",
		// because only one of them is an error.
		const missing = await buildManifestFromStorage({
			workId,
			workPublicId: manifestFromServer.workPublicId,
			assetId,
			assetFilename: "gone.zip",
			assetMimeType: "application/zip",
			storageKey: `${STORAGE_KEY}.gone`,
		});
		expect(missing).toBeNull();
	});

	it("serves the last chunk of a file that is not a whole number of chunks", async () => {
		// FILE_SIZE is exactly 4 chunks, so the partial-final-chunk path — where an
		// inclusive-vs-exclusive byte range is off by one — is not otherwise exercised.
		const oddSize = CHUNK_SIZE * 2 + 1000;
		const oddBytes = generateTestBytes(oddSize);
		const oddKey = `test/p2p-${id}/odd-size.zip`;
		await storage.upload(oddKey, oddBytes, "application/zip", "private");

		const manifest = await buildManifestFromStorage({
			workId,
			workPublicId: manifestFromServer.workPublicId,
			assetId,
			assetFilename: "odd-size.zip",
			assetMimeType: "application/zip",
			storageKey: oddKey,
		});

		expect(manifest).not.toBeNull();
		expect(manifest?.assetSize).toBe(oddSize);
		expect(manifest?.chunks.length).toBe(3);

		const { offset, size } = chunkRange(2, CHUNK_SIZE, oddSize);
		expect(size).toBe(1000);
		const last = await storage.readRange(oddKey, offset, size);
		expect(last?.length).toBe(1000);
		expect(await verifyChunk(last as Uint8Array, manifest as Manifest, 2)).toBe(true);

		await storage.delete(oddKey);
	});

	it("the manifest reports the size it FINDS, not the size the database claims", async () => {
		// `assets.file_size` is a column and can disagree with the object in storage. A
		// manifest that trusted it would compute a wrong final-chunk size, which surfaces
		// as a hash mismatch on the last chunk of an otherwise healthy download.
		await db.update(assets).set({ fileSize: 999_999_999 }).where(eq(assets.id, assetId));
		_resetSeederCacheForTest();

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.manifest.assetSize).toBe(FILE_SIZE);

		await db.update(assets).set({ fileSize: FILE_SIZE }).where(eq(assets.id, assetId));
	});

	it("rebuilds the manifest and serves a chunk after the cache is dropped", async () => {
		// A restart, a redeploy, or the 65th asset all drop an entry while valid 15-minute
		// tokens are still in flight. This used to 404 — a download the hub had already
		// authorized, failed by a cache miss.
		_resetSeederCacheForTest();

		const chunkIndex = 3;
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/${chunkIndex}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(200);

		const chunkBytes = new Uint8Array(await res.arrayBuffer());
		const { offset, size } = chunkRange(chunkIndex, CHUNK_SIZE, FILE_SIZE);
		expect(chunkBytes).toEqual(testBytes.subarray(offset, offset + size));
		expect(await verifyChunk(chunkBytes, manifestFromServer, chunkIndex)).toBe(true);
	});

	it("still refuses a chunk to a token scoped to another asset after a cache drop", async () => {
		// The rebuild path skips the access re-check by design (the token carries the
		// authorization). That makes the token's own scoping the whole guard, so it has to
		// hold on the rebuild path too — not just on the cached one.
		_resetSeederCacheForTest();

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId + 12345}/chunks/0`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(res.status).toBe(403);
	});
});
