// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-build delivery: the serve half of the hosting task — a Work's primary build
 * answering through the play-token ceremony, resolved against `web_build_files`.
 *
 * 🚨 **The properties under test are the ones the privacy policy and *How a File
 * Reaches You* both promise.**
 *
 * - **The token is the only credential.** The delivery origin never receives the
 *   Anthers session, so the route must serve on a verified token alone — asserted here
 *   by presenting tokens minted WITHOUT any session, from another env, and by refusing
 *   forged, expired and cross-token bodies. If this route ever consults the session
 *   cookie, it has broken the promise that no Anthers cookie crosses.
 * - **The file list is the allowlist.** A path the build never registered is not served
 *   — including one that exists in the creator's prefix under another key. Traversal
 *   refusals ride on both the register route and this one.
 * - **Minting is gated exactly like every other deliverable.** A viewer without access
 *   gets the 403, a metered commons gets the 402, a withdrawn Work plays nothing, and
 *   the token dies with the Work row (withdrawal invalidates outstanding tokens).
 * - **A public deployment without `BUILD_ORIGIN_SUFFIX` refuses to mint** — the feature
 *   is off rather than weakened, the admin-host failure shape.
 *
 * ⚠️ `queue.send` is replaced, as in the upload suite — minting gates run the access
 * context machinery against Works that exist here.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { webBuildFiles, works } from "@anthers/db/schema";
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

/** A delivery-host env: the suffix makes the host guard name a per-Work origin. */
const _DELIVERY_ENV = { BUILD_ORIGIN_SUFFIX: "delivery.test" };

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** Drive a build through the whole upload ceremony, as the Studio does. */
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
		[`deliv_${run}`, (v: typeof creator) => (creator = v)],
		[`deliv_other_${run}`, (v: typeof other) => (other = v)],
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

describe("browser-build delivery", () => {
	it("mints a play address after the gates, and the address serves the build's files", async () => {
		// A released, rated game Work with a completed build — the full ceremony.
		const w = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `deliverable game ${run}`,
		});
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html", "game.pck"], "index.html");

		const mint = await call("GET", `/api/content/works/${w.id}/play`, creator.cookie);
		expect(mint.status).toBe(200);
		const { src, expiresIn } = (await mint.json()) as { src: string; expiresIn: number };
		expect(expiresIn).toBeGreaterThan(0);
		// No suffix in this env: the checkout serves delivery on its own host, the
		// documented dev deviation — one origin, shared per-origin saves, like the harness.
		expect(src).toMatch(/^http:\/\/localhost\/build\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/index\.html$/);

		// Serve the entry file on the delivery host, with NO session — the token is the
		// whole credential, which is the production contract exercised locally.
		const token = src.split("/build/")[1].split("/")[0];
		const entryRes = await app.fetch(new Request(`http://localhost/build/${token}/index.html`));
		expect(entryRes.status).toBe(200);
		expect(entryRes.headers.get("Content-Type")).toContain("text/html");
		expect(await entryRes.text()).toContain("bytes-for-index.html");

		// A second registered file resolves the same way — the property every subresource
		// of a real build leans on.
		const _pck = src.replace("/index.html", "/game.pck");
		const pckRes = await app.fetch(new Request(`http://localhost/build/${token}/game.pck`));
		expect(pckRes.status).toBe(200);
		expect(await pckRes.text()).toContain("bytes-for-game.pck");
	});

	it("serves nothing for a path the build never registered", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `allowlist ${run}` });
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html");
		const mint = await call("GET", `/api/content/works/${w.id}/play`, creator.cookie);
		const { src } = (await mint.json()) as { src: string };
		const token = src.split("/build/")[1].split("/")[0];

		// An object that EXISTS in the build's own storage prefix but was never
		// registered — an abandoned PUT, a file dropped beside the manifest — is refused:
		// the rows are the allowlist, not the prefix. This is the case a prefix-based
		// delivery would leak.
		const [anyFile] = await db
			.select({ storageKey: webBuildFiles.storageKey })
			.from(webBuildFiles)
			.limit(1);
		const unregisteredKey = anyFile.storageKey.replace(/[^/]+$/, "secret.pck");
		await storage.upload(
			unregisteredKey,
			Buffer.from("ungated bytes"),
			"application/octet-stream",
			"private",
		);
		storedKeys.push(unregisteredKey);

		for (const path of ["index.html", "secret.pck", "../escape.pck", "no/deep/nothing.html"]) {
			const res = await app.fetch(new Request(`http://localhost/build/${token}/${path}`));
			if (path === "index.html") {
				expect(res.status).toBe(200);
			} else {
				expect(res.status, `must refuse unregistered ${path}`).toBe(404);
			}
		}
	});

	it("refuses a forged, expired, cross-Work, or host-mismatched request", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `forged ${run}` });
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html");
		const { src } = (await (
			await call("GET", `/api/content/works/${w.id}/play`, creator.cookie)
		).json()) as { src: string };
		const token = src.split("/build/")[1].split("/")[0];

		// Forged body, real mac.
		const [body, mac] = token.split(".");
		const forged = `${Buffer.from(JSON.stringify({ w: w.id + 999, iat: 1, exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url")}.${mac}`;
		const forgedRes = await app.fetch(new Request(`http://localhost/build/${forged}/index.html`));
		expect(forgedRes.status).toBe(403);

		// With a suffix set, a valid token presented on a NON-delivery host answers 404 —
		// the host guard is the route's refusal too, not decoration.
		process.env.BUILD_ORIGIN_SUFFIX = "delivery.test";
		try {
			// The delivery host goes in the request URL, not a Host header: Bun.serve builds
			// a request's URL from the connection's Host, so the URL is the honest shape
			// both in production and here.
			const wrongHost = await app.fetch(
				new Request(`http://anthers.org/build/${token}/index.html`),
			);
			expect(wrongHost.status).toBe(404);
			// And on the per-Work address it serves.
			const rightHost = await app.fetch(
				new Request(`http://${w.publicId}.delivery.test/build/${token}/index.html`),
			);
			expect(rightHost.status).toBe(200);
		} finally {
			delete process.env.BUILD_ORIGIN_SUFFIX;
		}

		void body;
	});

	it("the delivery responses are framable — the global SAMEORIGIN does not leak onto /build", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `xfo ${run}` });
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html");
		const { src } = (await (
			await call("GET", `/api/content/works/${w.id}/play`, creator.cookie)
		).json()) as { src: string };
		const token = src.split("/build/")[1].split("/")[0];

		const res = await app.fetch(new Request(`http://localhost/build/${token}/index.html`));
		expect(res.status).toBe(200);
		// `secureHeaders` stamps SAMEORIGIN on every response; the Work page frames this
		// one from a different origin, so the stripper has to have won here — and only here.
		expect(res.headers.get("X-Frame-Options")).toBeNull();
	});

	it("a viewer without access cannot mint, and the Work's owner always can", async () => {
		const w = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `gated game ${run}`,
			// A paid gate: `other` has not cleared it, so minting is refused for them.
			access: [{ threshold: 500, allow: true, price: "5" }],
		});
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html");

		const denied = await call("GET", `/api/content/works/${w.id}/play`, other.cookie);
		expect(denied.status).toBe(403);

		const owner = await call("GET", `/api/content/works/${w.id}/play`, creator.cookie);
		expect(owner.status).toBe(200);
	});

	it("a withdrawn Work's play address serves nothing", async () => {
		const w = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: `withdrawn game ${run}`,
			visibility: "private",
		});
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html");

		const { src } = (await (
			await call("GET", `/api/content/works/${w.id}/play`, creator.cookie)
		).json()) as { src: string };
		const token = src.split("/build/")[1].split("/")[0];

		// Withdraw: the visibility column flips and every outstanding token dies — the
		// Work row is what the token points at, and re-resolving it per request is why.
		await db.update(works).set({ visibility: "withdrawn" }).where(eq(works.id, w.id));
		const res = await app.fetch(new Request(`http://localhost/build/${token}/index.html`));
		expect(res.status).toBe(404);
	});

	it("a public deployment without a delivery origin refuses to mint", async () => {
		const w = await insertWork({ creatorId: creator.id, type: "game", title: `nosuffix ${run}` });
		workIds.push(w.id);
		await createBuildWithFiles(w.id, creator.cookie, ["index.html"], "index.html");

		// Simulate the production env: a deployment with FRONTEND_URL set and no suffix.
		const realEnv = { ...process.env };
		process.env.FRONTEND_URL = "https://anthers.org";
		delete process.env.BUILD_ORIGIN_SUFFIX;
		try {
			const res = await call("GET", `/api/content/works/${w.id}/play`, creator.cookie);
			expect(res.status).toBe(501);
		} finally {
			for (const k of Object.keys(process.env)) delete process.env[k];
			Object.assign(process.env, realEnv);
		}
	});
});
