/**
 * Known-answer tests for PDQ hashing.
 *
 * 🚨 **This file is the only thing standing between us and a scanner that detects nothing
 * while reporting perfect health.** A PDQ implementation that is internally consistent but
 * not byte-compatible with everyone else's produces hashes that match no corpus anywhere,
 * and every scan returns `no-known-match` — which is indistinguishable from a clean
 * platform. Self-consistency tests cannot catch that. **Only a hash somebody else computed
 * can**, which is why the expectations below are Meta's published regression values rather
 * than anything this repository generated.
 *
 * The fixture is `bridge-1-original.jpg` from Meta's ThreatExchange PDQ regression corpus
 * (BSD-3-Clause), re-encoded to 320px wide at quality 50 so it costs 11 KB instead of
 * 350 KB. That re-encoding is not a compromise of the test — it *is* a second test, since
 * surviving a 25× size reduction is the perceptual property the whole design depends on.
 *
 * Source of the expected hash:
 *   facebook/ThreatExchange @ pdq/cpp/reg_test/expected/out
 */

import { describe, expect, it } from "bun:test";
import { pdqHashImage, pdqHashPixels } from "../lib/pdq";

/** Meta's reference hash for `pdq/data/reg-test-input/dih/bridge-1-original.jpg`. */
const REFERENCE_HASH = "d8f8f0cee0f4a84f0637022a078f67f0b36e2ed596621e1d33e6339c4e9c9b22";

/**
 * How far our hash may sit from the reference before the test fails.
 *
 * 🚨 **This number is doing real work and must not be raised to make a failure go away.**
 * A correct implementation lands 4–8 bits away — decoder differences, nothing more. The
 * defect this guards against, a reversed 16-bit word order, lands around **120**. PDQ's
 * conventional "same image" threshold is 31. Anything in between means something changed
 * that nobody understood, and the honest response is to find out what rather than to widen
 * the window.
 */
const MAX_DISTANCE = 24;

function hamming(a: string, b: string): number {
	const x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
	let bits = 0;
	for (let v = x; v > 0n; v >>= 1n) if (v & 1n) bits++;
	return bits;
}

async function fixture(): Promise<Buffer> {
	return Buffer.from(
		await Bun.file(`${import.meta.dir}/fixtures/pdq-bridge-320.jpg`).arrayBuffer(),
	);
}

describe("pdq", () => {
	it("reproduces Meta's published hash for a known image", async () => {
		const result = await pdqHashImage(await fixture());
		expect(result).not.toBeNull();
		expect(result?.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(hamming(result!.hash, REFERENCE_HASH)).toBeLessThanOrEqual(MAX_DISTANCE);
	});

	it("rejects the reversed word order that the underlying library emits", async () => {
		// The specific defect, asserted directly rather than left to the distance check —
		// so a failure says *what* broke instead of only that something did.
		const result = await pdqHashImage(await fixture());
		const bytes = Buffer.from(result!.hash, "hex");
		const words: Buffer[] = [];
		for (let i = 0; i < bytes.length; i += 2) words.push(bytes.subarray(i, i + 2));
		const reversed = Buffer.concat(words.reverse()).toString("hex");
		expect(hamming(reversed, REFERENCE_HASH)).toBeGreaterThan(64);
	});

	it("reports a usable quality for a real photograph", async () => {
		const result = await pdqHashImage(await fixture());
		expect(result!.quality).toBeGreaterThanOrEqual(50);
	});

	it("is deterministic", async () => {
		const a = await pdqHashImage(await fixture());
		const b = await pdqHashImage(await fixture());
		expect(a?.hash).toBe(b?.hash);
	});

	it("returns null for bytes that are not an image", async () => {
		expect(await pdqHashImage(Buffer.from("this is not an image, it is a sentence"))).toBeNull();
	});

	it("hashes raw pixels the same way it hashes an encoded image", async () => {
		// The video path hands over decoded frames rather than files; the two entry points
		// must not drift into producing different hashes for the same picture.
		const sharpMod = (await import("sharp")).default;
		const { data, info } = await sharpMod(await fixture())
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
		const fromPixels = await pdqHashPixels(new Uint8Array(data), info.width, info.height);
		const fromFile = await pdqHashImage(await fixture());
		expect(fromPixels.hash).toBe(fromFile!.hash);
	});

	it("gives a flat image a low quality score", async () => {
		// A featureless image carries no structure to fingerprint. PDQ says so through
		// `quality`, and the caller is expected to decline to match on it.
		const sharpMod = (await import("sharp")).default;
		const flat = await sharpMod({
			create: { width: 512, height: 512, channels: 3, background: { r: 128, g: 128, b: 128 } },
		})
			.jpeg()
			.toBuffer();
		const result = await pdqHashImage(flat);
		expect(result!.quality).toBeLessThan(50);
	});
});
