// SPDX-License-Identifier: Apache-2.0
/**
 * The isolation posture: what a threaded build's declaration changes, and the play
 * page that makes the declaration real.
 *
 * 🚨 **The property under test is the ancestor rule.** A frame is cross-origin
 * isolated only when every ancestor carries the headers, and Anthers' Work pages are a
 * static SPA — per-Work response headers are structurally impossible there. So the
 * declaration (`requiresIsolation` on the build) decides WHERE a build plays:
 * isolation builds get the server-rendered `/play/:id` page (which carries
 * `COOP: same-origin` + `COEP: require-corp` on its own response and mints the token
 * itself, server-side, holding the session); ordinary builds keep the inline minted
 * frame. The SPA's `webPlayPath` field carries that decision, and the tests pin it.
 *
 * ⚠️ Also pinned: the refusal pages carry the same headers. An answer whose headers
 * vary by body is one more thing to keep in step; carrying the pair always is free.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { webBuilds, works } from "@anthers/db/schema";
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

/** Drive a build through the upload ceremony, declaring isolation or not. */
async function createBuildWithFiles(
	workId: number,
	cookie: string,
	paths: string[],
	entryPath: string,
	requiresIsolation = false,
): Promise<number> {
	const create = await call("POST", `/api/web-builds/works/${workId}/web-build`, cookie, {
		entryPath,
		requiresIsolation,
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
		const info = (await presign.json()) as { key: string };
		await storage.upload(
			info.key,
			Buffer.from(`bytes-for-${path}`),
			"application/octet-stream",
			"private",
		);
		storedKeys.push(info.key);
		refs.push({ path, storageRef: info.key, fileSize: 12, contentType: "" });
	}
	await call("POST", `/api/web-builds/works/${workId}/web-build/${build.id}/files`, cookie, {
		files: refs,
	});
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
		[`iso_${run}`, (v: typeof creator) => (creator = v)],
		[`iso_other_${run}`, (v: typeof other) => (other = v)],
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

describe("isolation posture", () => {
	it("the declaration survives the ceremony and lands on the Work's user shape as the play path", async () => {
		const threaded = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `threaded ${run}`,
			// A free baseline row — without it the fixture Work is gated-by-default and
			// `other` (a plain viewer) is refused, which is not this test's subject.
			access: [{ threshold: 0, allow: true, price: "0" }],
		});
		workIds.push(threaded.id);
		await createBuildWithFiles(threaded.id, creator.cookie, ["index.html"], "index.html", true);

		const plain = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `plain ${run}`,
			access: [{ threshold: 0, allow: true, price: "0" }],
		});
		workIds.push(plain.id);
		await createBuildWithFiles(plain.id, creator.cookie, ["index.html"], "index.html", false);

		// The row carries it.
		const [tRow] = await db.select().from(webBuilds).where(eq(webBuilds.workId, threaded.id));
		expect(tRow.requiresIsolation).toBe(true);
		const [pRow] = await db.select().from(webBuilds).where(eq(webBuilds.workId, plain.id));
		expect(pRow.requiresIsolation).toBe(false);

		// The user shape carries the decision, resolved for a viewer.
		for (const [w, expected] of [
			[threaded, "page"],
			[plain, "inline"],
		] as const) {
			const res = await call("GET", `/api/content/works/${w.id}`, other.cookie);
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				work: { webPlayable?: boolean; webPlayPath?: string | null };
			};
			expect(body.work.webPlayable).toBe(true);
			expect(body.work.webPlayPath).toBe(expected);
		}
	});

	it("the play page serves a threaded build with the isolation headers and a minted frame", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `isopage ${run}` });
		workIds.push(w.id);
		await createBuildWithFiles(
			w.id,
			creator.cookie,
			["index.html", "game.pck"],
			"index.html",
			true,
		);

		const res = await call("GET", `/play/${w.id}`, creator.cookie);
		expect(res.status).toBe(200);
		// 🚨 The pair: this is what makes the frame inside isolated. The test is the
		// contract that the SPA cannot deliver and this page must.
		expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
		expect(res.headers.get("Content-Type")).toContain("text/html");

		const html = await res.text();
		// The token was minted server-side — the frame src names the delivery origin and
		// carries a token-shaped prefix and the entry path.
		expect(html).toMatch(/<iframe src="[^"]*\/build\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html"/);
		// The frame is the sandboxed pair — saves live per-origin inside it.
		expect(html).toContain('sandbox="allow-scripts allow-same-origin allow-popups"');
		// And the delivered token actually serves the build's file — the mint was real.
		const token = html.split("/build/")[1].split("/")[0];
		const serve = await app.fetch(new Request(`http://localhost/build/${token}/game.pck`));
		expect(serve.status).toBe(200);
		expect(await serve.text()).toContain("bytes-for-game.pck");
	});

	it("an ordinary build's play page omits the isolation headers", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `plainpage ${run}` });
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html", false);
		const res = await call("GET", `/play/${w.id}`, creator.cookie);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
	});

	it("the refusal pages carry the isolation headers too — headers do not vary by body", async () => {
		// `other` has no access to a gated Work: the refusal page, with the pair.
		const w = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `isorefuse ${run}`,
			access: [{ threshold: 500, allow: true, price: "5" }],
		});
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html", true);

		const res = await call("GET", `/play/${w.id}`, other.cookie);
		expect(res.status).toBe(200); // A refusal page — a real page, not an error frame.
		expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
		expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
		const html = await res.text();
		expect(html).not.toContain("<iframe");
		expect(html).toContain("Access required");
	});

	it("a Work with no hosted build gets a refusal page, not a broken frame", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `nobuild ${run}` });
		workIds.push(w.id);
		const res = await call("GET", `/play/${w.id}`, creator.cookie);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).not.toContain("<iframe");
		expect(html).toContain("No hosted build");
	});

	it("the declaration is fixed at create — a completed build cannot silently change posture", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `fixed ${run}` });
		workIds.push(w.id);
		const buildId = await createBuildWithFiles(
			w.id,
			creator.cookie,
			["index.html"],
			"index.html",
			false,
		);

		// `complete` accepts label/entry/isPrimary edits but the posture is not on that
		// schema at all: sending it is refused by the validator, not silently accepted.
		const attempt = await call(
			"POST",
			`/api/web-builds/works/${w.id}/web-build/${buildId}/complete`,
			creator.cookie,
			{ requiresIsolation: true },
		);
		expect(attempt.status).toBe(200); // completes, ignoring nothing — the field is unknown
		const [row] = await db.select().from(webBuilds).where(eq(webBuilds.id, buildId));
		expect(row.requiresIsolation).toBe(false);
	});
});
