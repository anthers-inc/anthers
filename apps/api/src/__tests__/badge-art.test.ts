// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Creator Badge art — the upload, the scan that gates it, and the key that must not escape.
 *
 * 🚨 **Badge art is user-supplied imagery on a surface other people see**, so it is another
 * ingest door for wiki 40.12 — and unlike a Work there is no release gate behind which a
 * queued scan could catch up. It is scanned inline, before the key is ever written to the
 * row, and a match refuses the upload outright.
 *
 * ⚠️ **The storage key never reaches a client.** The object is private and served through
 * an access-checked route; a client holding the key is one URL away from fetching badge art
 * on a path nothing checks, which is precisely the boundary the two-bucket split exists to
 * hold. `hasArt` is the whole of what a client is told, and the leak is asserted directly
 * because a `select()` returning the new column is the easiest possible regression.
 *
 * ⭐ **Uploads are normalized to a square PNG.** That is what makes one shared frame
 * possible across two ladders, and it also means the bytes scanned are exactly the bytes
 * served — an original that differed from what we store would leave the scan describing a
 * file nobody can fetch.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { creatorGates, users } from "@anthers/db/schema";
import { BADGE_ART_PX } from "@anthers/shared/constants";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);
const creatorName = `ba_creator_${RUN}`;
const otherName = `ba_other_${RUN}`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
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

/**
 * A wide, non-square image with real structure in it.
 *
 * 🚨 **Not a flat color, and that is not incidental.** PDQ reports its own confidence and
 * `scanPdqHash` refuses to match below `MIN_PDQ_QUALITY`, because matching on noise
 * produces false positives that quarantine somebody's work. A solid rectangle scores near
 * zero, so a flat fixture is answered `unscannable` without the vendor ever being asked —
 * and the refusal case cannot fire. Found exactly that way.
 */
async function artwork(seed = 7): Promise<File> {
	const [w, h] = [900, 300];
	const raw = Buffer.alloc(w * h * 3);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			// Deterministic per seed, so a test can ask for a *different* picture and get
			// one — a second upload has to produce a different hash to be worth anything.
			raw[i] = (x * 7 + y * 13 + seed * 53) % 256;
			raw[i + 1] = (x * x + y * 3 + seed * 31) % 256;
			raw[i + 2] = ((x ^ y) + seed * 17) % 256;
		}
	}
	const png = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
		.png()
		.toBuffer();
	return new File([new Uint8Array(png)], "badge.png", { type: "image/png" });
}

function upload(gateId: number, cookie: string, file: File) {
	const body = new FormData();
	body.append("file", file);
	return req(`/api/subscriptions/gates/${gateId}/art`, {
		method: "POST",
		headers: { Origin: ORIGIN, Cookie: cookie },
		body,
	});
}

/**
 * Shield answering for whatever it is asked.
 *
 * 🚨 **The credentials are set here, and without them these tests pass for the wrong
 * reason.** `shieldCredentials()` returns null when the environment has none, and
 * `scanStoredImage` then answers `unscannable` without making a request at all — so a stub
 * would sit unconsulted while every upload succeeded and the refusal case silently could
 * not fire. Found exactly that way.
 */
function stubShield(classification: string) {
	const original = globalThis.fetch;
	const priorUser = process.env.ARACHNID_SHIELD_USERNAME;
	const priorPass = process.env.ARACHNID_SHIELD_PASSWORD;
	process.env.ARACHNID_SHIELD_USERNAME = "test";
	process.env.ARACHNID_SHIELD_PASSWORD = "test";
	globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? "{}")) as { hashes?: string[] };
		const scanned: Record<string, { classification: string; match_type: string }> = {};
		for (const h of body.hashes ?? []) scanned[h] = { classification, match_type: "near" };
		return new Response(JSON.stringify({ scanned_hashes: scanned }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	return {
		restore: () => {
			globalThis.fetch = original;
			if (priorUser === undefined) delete process.env.ARACHNID_SHIELD_USERNAME;
			else process.env.ARACHNID_SHIELD_USERNAME = priorUser;
			if (priorPass === undefined) delete process.env.ARACHNID_SHIELD_PASSWORD;
			else process.env.ARACHNID_SHIELD_PASSWORD = priorPass;
		},
	};
}

let creatorCookie: string;
let otherCookie: string;
let gateId = 0;

async function makeGate(cookie: string, label: string): Promise<number> {
	const res = await req("/api/subscriptions/gates", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ threshold: "5.00", label }),
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { gate: { id: number } }).gate.id;
}

describe("Creator Badge art", () => {
	beforeAll(async () => {
		creatorCookie = await signUp(creatorName);
		otherCookie = await signUp(otherName);
		gateId = await makeGate(creatorCookie, `Rung ${RUN}`);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${otherName})`);
	});

	it("🚨 never puts the storage key in a response, only whether art exists", async () => {
		// The easiest regression available: a `select()` on the gates table now returns the
		// new column, and every gate response would carry it.
		const stub = stubShield("no-known-match");
		try {
			expect((await upload(gateId, creatorCookie, await artwork())).status).toBe(201);
		} finally {
			stub.restore();
		}

		const res = await req("/api/subscriptions/gates", { headers: { Cookie: creatorCookie } });
		const text = await res.text();
		expect(text).not.toContain("artKey");
		expect(text).not.toContain("art_key");
		// And the object's own path must not appear either, under any key name.
		expect(text).not.toContain("/badges/");
		expect(JSON.parse(text).gates[0].hasArt).toBe(true);
	});

	it("⭐ normalizes a wide image into the square the shared frame needs", async () => {
		// Anthers' own Badges and a creator's share one round frame, and a frame cannot fit
		// whatever aspect ratio a phone produced.
		const [gate] = await db
			.select({ artKey: creatorGates.artKey })
			.from(creatorGates)
			.where(eq(creatorGates.id, gateId));
		const bytes = await storage.read(gate.artKey!);
		const meta = await sharp(bytes!).metadata();
		expect(meta.width).toBe(BADGE_ART_PX);
		expect(meta.height).toBe(BADGE_ART_PX);
		expect(meta.format).toBe("png");
	});

	it("serves the art it stored, and 404s once it is cleared", async () => {
		const served = await req(`/api/subscriptions/gates/${gateId}/art`);
		expect(served.status).toBe(200);
		expect(served.headers.get("Content-Type")).toBe("image/png");

		expect(
			(
				await req(`/api/subscriptions/gates/${gateId}/art`, {
					method: "DELETE",
					headers: { Origin: ORIGIN, Cookie: creatorCookie },
				})
			).status,
		).toBe(204);

		// ⚠️ 404 rather than a placeholder: the default is the client's to draw, from the
		// brand package's recolor-ready SVG. A raster default served from here would go
		// stale the moment the palette moved.
		expect((await req(`/api/subscriptions/gates/${gateId}/art`)).status).toBe(404);
	});

	it("🚨 refuses art that matches known material, and stores nothing", async () => {
		// The whole reason the scan is inline. There is no release gate behind which a
		// queued scan could catch up, so a match has to stop the upload itself.
		const stub = stubShield("csam");
		try {
			const res = await upload(gateId, creatorCookie, await artwork(21));
			expect(res.status).toBe(422);
			expect((await res.json()).code).toBe("refused");
		} finally {
			stub.restore();
		}

		const [gate] = await db
			.select({ artKey: creatorGates.artKey })
			.from(creatorGates)
			.where(eq(creatorGates.id, gateId));
		expect(gate.artKey, "a refused upload must leave the rung with no art").toBeNull();
	});

	it("🚨 refuses a file that is not a raster image at all", async () => {
		// An SVG is a script-execution surface and cannot be PDQ-hashed without being
		// rasterized first, so it is refused here rather than sanitized. Anthers' own
		// defaults are SVG through @anthers/brand, and the two never mix.
		const svg = new File(
			[new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')],
			"badge.svg",
			{ type: "image/svg+xml" },
		);
		const res = await upload(gateId, creatorCookie, svg);
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("not_an_image");
	});

	it("⭐ stores a background a creator picked from the library", async () => {
		// The middle layer, and the reason it exists: shape, color and emblem are three
		// choices, so a creator who never opens a file picker still gets a badge that is
		// recognizably theirs.
		const res = await req(`/api/subscriptions/gates/${gateId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ artShape: "hexagon", artColor: "amber", artEmblem: "bee" }),
		});
		expect(res.status).toBe(200);
		const { gate } = (await res.json()) as {
			gate: { artShape: string; artColor: string; artEmblem: string };
		};
		expect(gate).toMatchObject({ artShape: "hexagon", artColor: "amber", artEmblem: "bee" });
	});

	it("🚨 refuses a shape, color or emblem the library does not carry", async () => {
		// The server validates against the same list the browser renders from. An id the
		// server accepted and the library does not have renders as nothing, with no error
		// anywhere saying why — so it is refused rather than stored.
		for (const patch of [
			{ artShape: "octagon" },
			{ artColor: "chartreuse" },
			{ artEmblem: "corner-leafy" },
			{ artShape: "../etc/passwd" },
		]) {
			const res = await req(`/api/subscriptions/gates/${gateId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
				body: JSON.stringify(patch),
			});
			expect(res.status, JSON.stringify(patch)).toBe(400);
		}
	});

	it("lets a creator go back to the default by clearing a choice", async () => {
		const res = await req(`/api/subscriptions/gates/${gateId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ artShape: null, artColor: null, artEmblem: null }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).gate.artShape).toBeNull();
	});

	it("refuses to art a rung somebody else owns, without saying it exists", async () => {
		const res = await upload(gateId, otherCookie, await artwork());
		expect(res.status).toBe(404);
	});

	it("⭐ replaces the previous object rather than accumulating them", async () => {
		// A creator iterating on a badge should not quietly spend their storage allowance
		// on every version they discarded.
		const stub = stubShield("no-known-match");
		try {
			expect((await upload(gateId, creatorCookie, await artwork())).status).toBe(201);
			const [first] = await db
				.select({ artKey: creatorGates.artKey })
				.from(creatorGates)
				.where(eq(creatorGates.id, gateId));

			expect((await upload(gateId, creatorCookie, await artwork(99))).status).toBe(201);
			const [second] = await db
				.select({ artKey: creatorGates.artKey })
				.from(creatorGates)
				.where(eq(creatorGates.id, gateId));

			expect(second.artKey).not.toBe(first.artKey);
			expect(await storage.read(first.artKey!), "the replaced object should be gone").toBeNull();
		} finally {
			stub.restore();
		}
	});
});
