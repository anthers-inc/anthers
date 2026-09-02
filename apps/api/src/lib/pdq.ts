/**
 * PDQ perceptual hashing — the only place image bytes become a hash.
 *
 * PDQ is Meta's open perceptual image hash: a 256-bit fingerprint of an image's structure
 * that survives re-encoding, resizing and mild cropping. Anthers computes it locally and
 * sends **only the hash** to a detection vendor, so no user media ever leaves the platform
 * for detection purposes. That decision, and the reasoning behind it, is the child-safety coverage map, which is deliberately not public
 * § *What leaves Anthers is a hash, never the media*.
 *
 * ── Two findings from validating this against Meta's published vectors ──────────────
 *
 * 🚨 **`pdq-wasm` serializes the hash with its 16-bit words in REVERSE order** relative to
 * the reference `pdq-photo-hasher` output, and its own `PDQ.toHex()` does the same thing.
 * `reverseWordOrder` below undoes it. This is not cosmetic: a word-reversed hash sent to a
 * vendor matches nothing, every scan comes back `no-known-match`, and **the whole system
 * looks like it is working perfectly while detecting nothing at all**. It is the worst
 * failure mode available here, and the only thing that catches it is a known-answer test
 * against a hash somebody else produced — which is what `pdq.test.ts` is.
 *
 * ⚠️ **The dependency is pinned to an exact version on purpose.** If a later release
 * "fixes" the word order, this correction would double-apply and silently invert the
 * output again. The known-answer test is what would catch that, so it must never be
 * relaxed into a self-consistency check.
 *
 * ⚠️ **Our hash of an image is not bit-identical to a reference hash of the same image.**
 * Decoders differ — measured 4–8 bits out of 256 against Meta's vectors, well inside PDQ's
 * conventional 31-bit "same image" threshold. Consequence for the caller: expect a vendor
 * to answer `near` rather than `exact`, and never compare a PDQ hash for equality against
 * one computed elsewhere.
 *
 * ⚠️ **Loaded through `createRequire` because the ESM build does not work under Bun.** Its
 * WASM loader probes for a global `require`, finds none in Bun's ESM context, and returns
 * a null factory that surfaces as "PDQ WASM module not available" — which reads like a
 * broken install rather than a module-format problem.
 */

import { createRequire } from "node:module";
import sharp from "sharp";

const require_ = createRequire(import.meta.url);

interface PdqModule {
	init(): Promise<void>;
	hash(image: { data: Uint8Array; width: number; height: number; channels: 1 | 3 }): {
		hash: Uint8Array;
		quality: number;
	};
	toHex(hash: Uint8Array): string;
}

/**
 * PDQ's own confidence in the hash, 0–100. A flat or near-featureless image produces a
 * hash with little signal in it, and Meta's guidance is to treat a low-quality hash as
 * unreliable rather than to match on it.
 *
 * 🚨 **A low-quality hash is dropped rather than sent.** Matching on noise produces false
 * positives against a corpus of real material, and a false positive here quarantines
 * somebody's work and puts a report in front of the Designated Child Safety Contact.
 * Under 18 U.S.C. § 2258A(f) there is no duty to search at all, so declining to match on
 * an unreliable fingerprint costs nothing that was owed.
 */
export const MIN_PDQ_QUALITY = 50;

export interface PdqHash {
	/** 64 hex characters, in the reference byte order a vendor expects. */
	hash: string;
	/** PDQ's own 0–100 confidence. Below `MIN_PDQ_QUALITY` the hash is not worth matching. */
	quality: number;
}

let modulePromise: Promise<PdqModule> | null = null;

async function loadPdq(): Promise<PdqModule> {
	if (!modulePromise) {
		modulePromise = (async () => {
			const { PDQ } = require_("pdq-wasm") as { PDQ: PdqModule };
			await PDQ.init();
			return PDQ;
		})();
	}
	return modulePromise;
}

/**
 * Undo `pdq-wasm`'s reversed 16-bit word order. See the file header — this is the
 * difference between a hash that matches a corpus and one that never matches anything.
 */
function reverseWordOrder(hex: string): string {
	const bytes = Buffer.from(hex, "hex");
	const words: Buffer[] = [];
	for (let i = 0; i < bytes.length; i += 2) words.push(bytes.subarray(i, i + 2));
	return Buffer.concat(words.reverse()).toString("hex");
}

/**
 * Hash decoded pixels. Exported for the video path, which already holds raw frames and has
 * no reason to re-encode them just to decode them again.
 *
 * **Pass RGB, not grayscale.** PDQ converts to luminance itself, with the reference's own
 * coefficients; converting first with a different set of coefficients moves the hash away
 * from what everyone else computed for the same picture.
 */
export async function pdqHashPixels(
	data: Uint8Array,
	width: number,
	height: number,
): Promise<PdqHash> {
	const pdq = await loadPdq();
	const result = pdq.hash({ data, width, height, channels: 3 });
	return { hash: reverseWordOrder(pdq.toHex(result.hash).toLowerCase()), quality: result.quality };
}

/**
 * Hash an encoded image. Returns `null` when the bytes are not a decodable image, which is
 * an ordinary outcome rather than an error — an upload may be any file at all, and the
 * caller decides what an unhashable object means.
 */
export async function pdqHashImage(input: Buffer | Uint8Array): Promise<PdqHash | null> {
	let raw: { data: Buffer; info: sharp.OutputInfo };
	try {
		// `removeAlpha` rather than `flatten`: PDQ wants three channels, and compositing a
		// transparent image onto an assumed background would invent pixels that were never
		// in the file. `failOn: "none"` keeps a slightly-corrupt-but-decodable image
		// scannable, since refusing to hash it is how something slips through unexamined.
		raw = await sharp(input, { failOn: "none" })
			.removeAlpha()
			.raw()
			.toBuffer({ resolveWithObject: true });
	} catch {
		return null;
	}
	if (raw.info.channels !== 3) return null;
	return pdqHashPixels(new Uint8Array(raw.data), raw.info.width, raw.info.height);
}
