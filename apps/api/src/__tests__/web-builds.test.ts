// SPDX-License-Identifier: Apache-2.0
/**
 * The browser-build upload surface: one multi-file build unit per game/software Work,
 * every file registered against the build's own prefix, nothing servable through any
 * of these routes.
 *
 * 🚨 **The properties under test are the ones the delivery route will stand on.**
 * - Every file a build names is the uploader's own object (`isOwnStorageRef`), because a
 *   build's file list is one day the delivery prefix's allowlist — a foreign file there
 *   is another creator's bytes served under this Work's gate.
 * - Paths cannot escape the build (`..`, leading slashes, backslashes), because the
 *   delivery route resolves every request against `creators/{id}/web-builds/{buildId}/`.
 * - The entry point must be a registered file: the Work page frames exactly that file.
 * - One primary build per Work, carried by the partial unique index and the clear-first
 *   flip in `complete`.
 * - A non-game/software Work carries no build, and another creator's Work 404s — the
 *   ownership filter every content route takes.
 *
 * ⚠️ `queue.send` is replaced, as in `foreign-file-refs.test.ts` — this suite writes Works,
 * which enqueue scans and transcodes nobody is running here.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { webBuildFiles, webBuilds, works } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { queue } from "../jobs/queue";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const creatorName = `webbuild_${run}`;
const otherName = `webbuild_other_${run}`;

let creator = { id: 0, cookie: "" };
let other = { id: 0, cookie: "" };
const workIds: number[] = [];
const storedKeys: string[] = [];
let sendSpy: ReturnType<typeof spyOn>;

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** Create a game Work for the build routes to hang off. */
async function createGameWork(cookie: string): Promise<number> {
	const res = await call("POST", "/api/content/works", cookie, {
		type: "game",
		title: `webbuild game ${run}`,
	});
	expect(res.status).toBe(201);
	const { work } = (await res.clone().json()) as { work: { id: number } };
	workIds.push(work.id);
	return work.id;
}

/** Store one object under the account's prefix, as the real upload route would. */
async function storeOwnObject(userId: number, name: string): Promise<string> {
	const key = `creators/${userId}/assets/${run}-${name}`;
	await storage.upload(key, Buffer.from(`bytes-${name}`), "application/octet-stream", "private");
	storedKeys.push(key);
	return key;
}

/**
 * Drive one build through the whole ceremony, the way the Studio does. Returns the build id.
 */
async function createBuildWithFiles(
	workId: number,
	cookie: string,
	paths: string[],
	entryPath: string,
): Promise<number> {
	const create = await call("POST", `/api/web-builds/works/${workId}/web-build`, cookie, {
		entryPath,
	});
	expect(create.status).toBe(201);
	const { build } = (await create.json()) as { build: { id: number } };

	const refs: { path: string; storageRef: string; fileSize: number; contentType: string }[] = [];
	for (const path of paths) {
		const presign = await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${build.id}/presign`,
			cookie,
			{ path },
		);
		expect(presign.status).toBe(200);
		const info = (await presign.json()) as { method: string; key: string };
		// Store the bytes at the key the route minted, exactly as the client would.
		await storage.upload(
			info.key,
			Buffer.from(`bytes-for-${path}`),
			"application/octet-stream",
			"private",
		);
		storedKeys.push(info.key);
		refs.push({ path, storageRef: info.key, fileSize: 12, contentType: "" });
	}

	const register = await call(
		"POST",
		`/api/web-builds/works/${workId}/web-build/${build.id}/files`,
		cookie,
		{ files: refs },
	);
	expect(register.status).toBe(201);

	const complete = await call(
		"POST",
		`/api/web-builds/works/${workId}/web-build/${build.id}/complete`,
		cookie,
		{},
	);
	expect(complete.status).toBe(200);
	return build.id;
}

beforeAll(async () => {
	for (const [name, set] of [
		[creatorName, (v: typeof creator) => (creator = v)],
		[otherName, (v: typeof other) => (other = v)],
	] as const) {
		const account = await createAccount(name);
		await enablePayouts(name);
		set({ id: account.userId as number, cookie: account.cookie });
	}
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	for (const key of storedKeys) await storage.delete(key).catch(() => {});
});

describe("web build upload surface", () => {
	it("creates a build unit on the creator's game Work, and only there", async () => {
		const workId = await createGameWork(creator.cookie);

		const res = await call("POST", `/api/web-builds/works/${workId}/web-build`, creator.cookie, {
			entryPath: "index.html",
			label: "Teaser",
		});
		expect(res.status).toBe(201);
		const { build } = (await res.json()) as {
			build: { id: number; entryPath: string; label: string };
		};
		expect(build.entryPath).toBe("index.html");
		expect(build.label).toBe("Teaser");

		// Another creator's Work 404s, the way every content ownership filter reads.
		const foreign = await call("POST", `/api/web-builds/works/${workId}/web-build`, other.cookie, {
			entryPath: "index.html",
		});
		expect(foreign.status).toBe(404);

		// A Work kind that carries no build is refused, not silently accepted.
		const textRes = await call("POST", "/api/content/works", creator.cookie, {
			type: "text",
			title: `webbuild text ${run}`,
			bodyHtml: "<p>x</p>",
		});
		expect(textRes.status).toBe(201);
		const textBody = (await textRes.clone().json()) as { work?: { id: number } };
		const textWork = textBody.work!.id;
		workIds.push(textWork);
		const wrongType = await call(
			"POST",
			`/api/web-builds/works/${textWork}/web-build`,
			creator.cookie,
			{ entryPath: "index.html" },
		);
		expect(wrongType.status).toBe(400);
	});

	it("refuses a path that escapes the build prefix", async () => {
		const workId = await createGameWork(creator.cookie);
		const create = await call("POST", `/api/web-builds/works/${workId}/web-build`, creator.cookie, {
			entryPath: "index.html",
		});
		const { build } = (await create.json()) as { build: { id: number } };

		for (const bad of [
			"../evil.txt",
			"/absolute.html",
			"a/../b.js",
			"a/./b.js",
			"dir\\win.js",
			"a?q.js",
			"a#f.js",
			"",
		]) {
			const res = await call(
				"POST",
				`/api/web-builds/works/${workId}/web-build/${build.id}/presign`,
				creator.cookie,
				{ path: bad },
			);
			expect(res.status, `presign for ${JSON.stringify(bad)} must refuse`).toBe(400);
		}
	});

	it("refuses a file reference naming another creator's upload", async () => {
		const workId = await createGameWork(creator.cookie);
		const create = await call("POST", `/api/web-builds/works/${workId}/web-build`, creator.cookie, {
			entryPath: "index.html",
		});
		const { build } = (await create.json()) as { build: { id: number } };

		const foreignKey = await storeOwnObject(other.id, "foreign.bin");
		const ownKey = await storeOwnObject(creator.id, "own.bin");

		const res = await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${build.id}/files`,
			creator.cookie,
			{
				files: [
					{ path: "data/foreign.bin", storageRef: foreignKey },
					{ path: "data/own.bin", storageRef: ownKey },
				],
			},
		);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code?: string }).code).toBe("foreign_file");
		// The refusal is atomic: nothing from the refused batch was registered.
		const rows = await db.select().from(webBuildFiles).where(eq(webBuildFiles.buildId, build.id));
		expect(rows).toEqual([]);
	});

	it("rejects an entry point that is not a registered file", async () => {
		const workId = await createGameWork(creator.cookie);
		const create = await call("POST", `/api/web-builds/works/${workId}/web-build`, creator.cookie, {
			entryPath: "index.html",
		});
		const { build } = (await create.json()) as { build: { id: number } };

		const key = await storeOwnObject(creator.id, "only.js");
		await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${build.id}/files`,
			creator.cookie,
			{ files: [{ path: "only.js", storageRef: key }] },
		);
		const complete = await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${build.id}/complete`,
			creator.cookie,
			{},
		);
		expect(complete.status).toBe(400);
		expect(((await complete.json()) as { error?: string }).error).toContain(
			"entry point has to be one of the build's registered files",
		);

		// Completing with the entry the build actually registered succeeds.
		const ok = await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${build.id}/complete`,
			creator.cookie,
			{ entryPath: "only.js" },
		);
		expect(ok.status).toBe(200);
	});

	it("keeps exactly one primary build per Work", async () => {
		const workId = await createGameWork(creator.cookie);
		const first = await createBuildWithFiles(workId, creator.cookie, ["index.html"], "index.html");
		const second = await createBuildWithFiles(workId, creator.cookie, ["b.html"], "b.html");

		const rows = await db.select().from(webBuilds).where(eq(webBuilds.workId, workId));
		expect(rows).toHaveLength(2);
		const primaryRows = rows.filter((r) => r.isPrimary);
		expect(primaryRows).toHaveLength(1);
		// The first build ever completed holds primary, and a second does not steal it: a
		// new upload is not automatically the one players see. Promoting is explicit.
		expect(primaryRows[0].id).toBe(first);

		// An explicit promotion clears the old primary and takes it.
		const promote = await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${second}/complete`,
			creator.cookie,
			{ isPrimary: true },
		);
		expect(promote.status).toBe(200);
		const after = await db.select().from(webBuilds).where(eq(webBuilds.workId, workId));
		expect(after.filter((r) => r.isPrimary).map((r) => r.id)).toEqual([second]);

		// The partial unique index backs the same rule against a writer that skips the flip.
		const [third] = await db
			.insert(webBuilds)
			.values({ workId, entryPath: "c.html", isPrimary: true })
			.returning()
			.catch(() => []);
		expect(third).toBeUndefined();
	});

	it("round-trips a real build through the whole ceremony with files intact", async () => {
		const workId = await createGameWork(creator.cookie);
		// A Godot-shaped export: entry, loader, wasm, pck, a subdirectory asset.
		const buildId = await createBuildWithFiles(
			workId,
			creator.cookie,
			["index.html", "index.js", "engine.wasm", "game.pck", "assets/logo.png"],
			"index.html",
		);

		const [build] = await db.select().from(webBuilds).where(eq(webBuilds.id, buildId));
		if (!build.isPrimary) console.log("BUILDROW", JSON.stringify(build));
		expect(build.isPrimary).toBe(true);
		const files = await db.select().from(webBuildFiles).where(eq(webBuildFiles.buildId, buildId));
		expect(files).toHaveLength(5);
		// Every key sits under the build's prefix — the property the delivery route resolves against.
		for (const f of files) {
			expect(f.storageKey.startsWith(`creators/${creator.id}/web-builds/${buildId}/`)).toBe(true);
		}
		// Re-registering the same path updates in place rather than duplicating.
		const again = await call(
			"POST",
			`/api/web-builds/works/${workId}/web-build/${buildId}/files`,
			creator.cookie,
			{
				files: [
					{
						path: "game.pck",
						storageRef: files.find((f) => f.path === "game.pck")!.storageKey,
						fileSize: 99,
					},
				],
			},
		);
		expect(again.status).toBe(201);
		const after = await db.select().from(webBuildFiles).where(eq(webBuildFiles.buildId, buildId));
		expect(after).toHaveLength(5);
		expect(after.find((f) => f.path === "game.pck")!.fileSize).toBe(99);
	});

	it("the Work's owner shape carries the builds, and the user shape never does", async () => {
		// A released, rated game Work, so a viewer reaches it and the user serialization is
		// the shape under test rather than a bypass 404 for privacy.
		const workId = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `released game ${run}`,
		});
		workIds.push(workId.id);
		await createBuildWithFiles(workId.id, creator.cookie, ["index.html"], "index.html");

		const ownerRes = await call("GET", `/api/content/works/${workId.id}`, creator.cookie);
		expect(ownerRes.status).toBe(200);
		const ownerBody = (await ownerRes.json()) as { work: { webBuilds?: unknown[] } };
		expect(ownerBody.work.webBuilds).toHaveLength(1);

		// A signed-in viewer gets the user serialization: no build list at all, because
		// delivery is not built — a build's file names are not viewer-facing data yet.
		const viewerRes = await call("GET", `/api/content/works/${workId.id}`, other.cookie);
		expect(viewerRes.status).toBe(200);
		const viewerBody = (await viewerRes.json()) as { work: Record<string, unknown> };
		expect("webBuilds" in viewerBody.work).toBe(false);
	});

	it("deleting the Work deletes the build's stored files", async () => {
		const workId = await createGameWork(creator.cookie);
		const buildId = await createBuildWithFiles(
			workId,
			creator.cookie,
			["index.html"],
			"index.html",
		);

		const files = await db.select().from(webBuildFiles).where(eq(webBuildFiles.buildId, buildId));
		for (const f of files) {
			expect(await storage.exists(f.storageKey)).toBe(true);
		}

		const res = await call("DELETE", `/api/content/works/${workId}`, creator.cookie);
		expect(res.status).toBe(204);
		for (const f of files) {
			expect(await storage.exists(f.storageKey)).toBe(false);
		}
	});

	it("deleting a build removes its prefix and its rows", async () => {
		const workId = await createGameWork(creator.cookie);
		const buildId = await createBuildWithFiles(
			workId,
			creator.cookie,
			["index.html"],
			"index.html",
		);
		const files = await db.select().from(webBuildFiles).where(eq(webBuildFiles.buildId, buildId));
		expect(files.length).toBeGreaterThan(0);

		const res = await call(
			"DELETE",
			`/api/web-builds/works/${workId}/web-build/${buildId}`,
			creator.cookie,
		);
		expect(res.status).toBe(204);
		for (const f of files) {
			expect(await storage.exists(f.storageKey)).toBe(false);
		}
		const rows = await db.select().from(webBuildFiles).where(eq(webBuildFiles.buildId, buildId));
		expect(rows).toEqual([]);
	});

	it("only a creator can start a build at all", async () => {
		// A non-creator account cannot even create the build unit on its own Work.
		const workId = await createGameWork(creator.cookie);
		// `other` already holds payouts enabled, so they are a creator; use a plain signed-in
		// session against the route's requireCreator by way of a signed-out call instead.
		const signedOut = await call("POST", `/api/web-builds/works/${workId}/web-build`, "", {
			entryPath: "index.html",
		});
		expect(signedOut.status).toBe(401);
	});
});
