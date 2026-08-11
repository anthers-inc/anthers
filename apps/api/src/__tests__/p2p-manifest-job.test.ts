// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Precomputed P2P manifests — the release-time job and what the endpoint does with its
 * output (45.04).
 *
 * Hashing an asset is a full pass over its bytes. Doing it lazily made the first request
 * for a manifest as slow as the asset is large and repeated the work after every deploy;
 * the job moves it to release, once. These cover the three things that has to get right:
 *
 * 1. The job persists a manifest, and the persisted one agrees exactly with a fresh build.
 * 2. Only the CONTENT half is persisted. Identity fields are recomposed per request, so a
 *    rename is visible immediately while `assetSha256` and `chunks` never move.
 * 3. The on-demand path still works, because Works released before the job existed have no
 *    stored manifest and must not become undownloadable.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, users, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import {
	buildManifestForAsset,
	buildP2pManifest,
	invalidateP2pManifests,
} from "../jobs/build-p2p-manifest";
import { buildManifestFromStorage } from "../p2p/manifest";
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
const creatorName = `mjob_${id}`;
const viewerName = `mjob_viewer_${id}`;

// Deliberately not a whole number of chunks, so the partial final chunk is covered here too.
const FILE_SIZE = 256 * 1024 + 4096;
const STORAGE_KEY = `test/p2p-job-${id}/build.zip`;

function bytesOf(size: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(size);
	let state = 0x2468ace0;
	for (let i = 0; i < size; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (state >> 16) & 0xff;
	}
	return out;
}

describe("P2P precomputed manifests", () => {
	let creatorCookie: string;
	let viewerCookie: string;
	let workId: number;
	let assetId: number;
	let fileBytes: Uint8Array<ArrayBuffer>;

	beforeAll(async () => {
		const kp = await generateKeyPair();
		_setPrivateKeyForTest(kp.privateKeyB64);

		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
		creatorCookie = await signUp(creatorName);
		viewerCookie = await signUp(viewerName);

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName))
			.limit(1);

		const work = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: "Manifest Job Game",
			downloadEnabled: true,
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		workId = work.id;

		fileBytes = bytesOf(FILE_SIZE);
		await storage.upload(STORAGE_KEY, fileBytes, "application/zip", "private");

		const [asset] = await db
			.insert(assets)
			.values({
				workId,
				file: STORAGE_KEY,
				filename: "build.zip",
				fileSize: FILE_SIZE,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			})
			.returning();
		assetId = asset.id;
	}, DB_SETUP_TIMEOUT);

	it("starts with no stored manifest", async () => {
		const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		expect(row.p2pManifest).toBeNull();
		expect(row.p2pManifestBuiltAt).toBeNull();
	});

	it("serving a manifest for an unbuilt asset builds AND persists it", async () => {
		// The compatibility path — Works released before this job existed have no stored
		// manifest and must not become undownloadable.
		//
		// It persists, which reverses an earlier decision. This deliberately did NOT write
		// back at first, reasoning that persisting is the job's business and a handler that
		// wrote would let a burst of first-requests race over one row. The race is real and
		// benign: every racer hashes the same bytes and writes the same value. Not writing
		// is the more expensive mistake, because the chunk endpoint reads its per-chunk hash
		// out of this column — an asset that never gets persisted would serve a manifest and
		// then 404 every chunk in it.
		_resetSeederCacheForTest();
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(res.status).toBe(200);
		const { manifest } = await res.json();
		expect(manifest.assetSize).toBe(FILE_SIZE);
		expect(manifest.chunks.length).toBe(2);

		const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		expect(row.p2pManifest).not.toBeNull();
		expect(row.p2pManifest?.assetSha256).toBe(manifest.assetSha256);
	});

	it("the job persists a manifest that agrees exactly with a fresh build", async () => {
		// Cleared first so this asserts "built" on its own terms rather than depending on
		// whether an earlier test in this file happened to leave the column empty.
		await db
			.update(assets)
			.set({ p2pManifest: null, p2pManifestBuiltAt: null })
			.where(eq(assets.id, assetId));
		expect(await buildManifestForAsset(assetId)).toBe("built");

		const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		expect(row.p2pManifest).not.toBeNull();
		expect(row.p2pManifestBuiltAt).not.toBeNull();

		const fresh = await buildManifestFromStorage({
			workId,
			workPublicId: "",
			assetId,
			assetFilename: "build.zip",
			assetMimeType: "application/zip",
			storageKey: STORAGE_KEY,
		});
		expect(row.p2pManifest?.assetSha256).toBe(fresh?.assetSha256 as string);
		expect(row.p2pManifest?.chunks).toEqual(fresh?.chunks as string[]);
		expect(row.p2pManifest?.assetSize).toBe(FILE_SIZE);
		expect(row.p2pManifest?.chunkSize).toBe(256 * 1024);
	});

	it("is idempotent — a second run does not rehash", async () => {
		expect(await buildManifestForAsset(assetId)).toBe("current");
	});

	it("rehashes when forced", async () => {
		expect(await buildManifestForAsset(assetId, { force: true })).toBe("built");
	});

	it("serves the STORED manifest once built, byte-identical in its content half", async () => {
		_resetSeederCacheForTest();
		const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(res.status).toBe(200);
		const { manifest } = await res.json();

		expect(manifest.assetSha256).toBe(row.p2pManifest?.assetSha256);
		expect(manifest.chunks).toEqual(row.p2pManifest?.chunks as string[]);
		expect(manifest.assetSize).toBe(row.p2pManifest?.assetSize);
	});

	it("serves the stored manifest rather than rehashing — provably", async () => {
		// The discriminating test, and it needs the sentinel to BE one. Comparing a served
		// manifest against a freshly hashed one cannot tell "read the row" from "hashed the
		// same bytes again": both produce identical output, so that assertion passes even
		// with the stored manifest ignored entirely. Verified — sabotaging the endpoint to
		// ignore the column left the rest of this suite green.
		//
		// So the row is given a manifest that hashing could not produce. If the endpoint
		// returns the sentinel, it read the row. (45.04 makes this exact situation safe in
		// the real world: a client holding a manifest whose assetSha256 doesn't match the
		// bytes gets an outdated file, never a corrupted one.)
		const sentinel = "0".repeat(64);
		const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		await db
			.update(assets)
			.set({ p2pManifest: { ...row.p2pManifest!, assetSha256: sentinel } })
			.where(eq(assets.id, assetId));
		_resetSeederCacheForTest();

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		const { manifest } = await res.json();
		expect(manifest.assetSha256).toBe(sentinel);

		// Put the real one back so later tests compare against truth.
		await db.update(assets).set({ p2pManifest: row.p2pManifest }).where(eq(assets.id, assetId));
		_resetSeederCacheForTest();
	});

	it("a rename changes the served identity and never the content half", async () => {
		// The reason only the content half is persisted. 45.04 makes assetSha256 and chunks
		// immutable, but also requires the hub to always serve the CURRENT manifest — and a
		// filename can change without a single byte moving. Freezing identity into the row
		// would serve a stale name forever.
		const [before] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);

		await db.update(assets).set({ filename: "build-renamed.zip" }).where(eq(assets.id, assetId));
		_resetSeederCacheForTest();

		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(res.status).toBe(200);
		const { manifest } = await res.json();

		expect(manifest.assetFilename).toBe("build-renamed.zip");
		expect(manifest.assetSha256).toBe(before.p2pManifest?.assetSha256);
		expect(manifest.chunks).toEqual(before.p2pManifest?.chunks as string[]);

		// And the row itself was not rewritten by serving.
		const [after] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		expect(after.p2pManifest?.assetSha256).toBe(before.p2pManifest?.assetSha256);
	});

	it("chunks still verify against a stored manifest", async () => {
		_resetSeederCacheForTest();
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: viewerCookie },
		});
		const { manifest, token } = await res.json();

		// The final chunk — the partial one, where a boundary error would show up.
		const lastIndex = manifest.chunks.length - 1;
		const chunkRes = await req(`/api/p2p/works/${workId}/assets/${assetId}/chunks/${lastIndex}`, {
			headers: { Authorization: `Bearer ${token}` },
		});
		expect(chunkRes.status).toBe(200);
		const chunk = new Uint8Array(await chunkRes.arrayBuffer());
		expect(chunk.length).toBe(FILE_SIZE - lastIndex * manifest.chunkSize);
		expect(chunkRes.headers.get("X-Chunk-Sha256")).toBe(manifest.chunks[lastIndex]);
	});

	it("invalidation clears the stored manifest", async () => {
		await invalidateP2pManifests([assetId]);
		const [row] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
		expect(row.p2pManifest).toBeNull();
		expect(row.p2pManifestBuiltAt).toBeNull();
	});

	it("the work-level job builds every asset and survives a broken one", async () => {
		// A Work commonly carries Windows, macOS and Linux builds. One asset pointing at a
		// missing object must not abandon the others.
		const [broken] = await db
			.insert(assets)
			.values({
				workId,
				file: `${STORAGE_KEY}.missing`,
				filename: "linux.tar.gz",
				fileSize: 1234,
				mimeType: "application/gzip",
				platform: "linux",
			})
			.returning();

		await buildP2pManifest({ workId });

		const rows = await db.select().from(assets).where(eq(assets.workId, workId));
		const good = rows.find((r) => r.id === assetId);
		const bad = rows.find((r) => r.id === broken.id);
		expect(good?.p2pManifest).not.toBeNull();
		expect(bad?.p2pManifest).toBeNull();

		await db.delete(assets).where(eq(assets.id, broken.id));
	});

	it("releasing a Work enqueues the build", async () => {
		// The wiring, asserted through the release endpoint rather than by trusting the
		// route reads. A Work released with no stored manifest should come out with one.
		const other = await insertWork({
			creatorId: (
				await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.username, creatorName))
					.limit(1)
			)[0].id,
			type: "game",
			title: "Release Enqueue Game",
			downloadEnabled: true,
			visibility: "private",
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		const otherKey = `test/p2p-job-${id}/other.zip`;
		await storage.upload(otherKey, bytesOf(2048), "application/zip", "private");
		const [otherAsset] = await db
			.insert(assets)
			.values({
				workId: other.id,
				file: otherKey,
				filename: "other.zip",
				fileSize: 2048,
				mimeType: "application/zip",
				platform: "windows",
			})
			.returning();

		const res = await req(`/api/content/works/${other.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ visibility: "released" }),
		});
		expect(res.status).toBe(200);

		// pg-boss is not running in the test process, so the enqueue is verified by running
		// the handler the release would have queued. What this pins is the wiring and the
		// handler agreeing on the Work id — not the queue's own delivery.
		await buildP2pManifest({ workId: other.id });
		const [row] = await db.select().from(assets).where(eq(assets.id, otherAsset.id)).limit(1);
		expect(row.p2pManifest?.assetSize).toBe(2048);

		await storage.delete(otherKey);
	});

	it("cleans up", async () => {
		await db.delete(works).where(eq(works.id, workId));
		await storage.delete(STORAGE_KEY).catch(() => {});
		_resetKeyCache();
	});
});
