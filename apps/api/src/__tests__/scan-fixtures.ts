// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fixtures for anything that exercises the media safety scan.
 *
 * Both halves of this file are here because getting either one wrong makes a suite pass for
 * the wrong reason — quietly, and while asserting the right things. They were each found
 * that way once already, and the reasoning is kept with them rather than in whichever suite
 * happened to hit it first.
 */
import sharp from "sharp";

/**
 * Shield answering whatever it is asked, with the classification the caller names.
 *
 * 🚨 **The credentials are set here, and without them a suite passes for the wrong reason.**
 * `shieldCredentials()` returns null when the environment has none, and `scanPdqHash` then
 * answers `unscannable` *without making a request at all* — so the stub sits unconsulted,
 * every upload succeeds, and the refusal case silently cannot fire. Found exactly that way.
 *
 * ⚠️ **It answers for whichever hashes the request carried**, rather than for one hash
 * fixed in advance. A stub keyed on a literal hash only works while the fixture image never
 * changes, and a test asking for a *different* picture would then get `no-known-match` from
 * a stub that looks like it is answering.
 */
export function stubShield(classification: string) {
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

/**
 * A wide, non-square image with real structure in it.
 *
 * 🚨 **Not a flat color, and that is not incidental.** PDQ reports its own confidence and
 * `scanPdqHash` refuses to match below `MIN_PDQ_QUALITY`, because matching on noise
 * produces false positives that quarantine somebody's work. A solid rectangle scores near
 * zero, so a flat fixture is answered `unscannable` without the vendor ever being asked —
 * and the refusal case cannot fire. Found exactly that way.
 *
 * The image is deliberately not square, so a caller can also assert that a route which
 * normalizes its uploads actually did.
 */
export async function artworkBytes(seed = 7): Promise<Buffer> {
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
	return await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
		.png()
		.toBuffer();
}

/** The same image as a multipart-ready `File`. */
export async function artwork(seed = 7, name = "art.png"): Promise<File> {
	const png = await artworkBytes(seed);
	return new File([new Uint8Array(png)], name, { type: "image/png" });
}
