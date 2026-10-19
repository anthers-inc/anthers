// SPDX-License-Identifier: Apache-2.0
/**
 * The whole-file digest, read ahead of a session upload — the resume's key and the
 * completion's identity, computed here once and used twice. The expectation is
 * computed by Bun's own hasher, independent of the chained-slice read under test;
 * what the suite proves is that the slices arrive in order and nothing is skipped
 * or doubled at the 8 MiB boundary the reader uses.
 */
import { describe, expect, it } from "bun:test";
import { type SessionPartPutter, uploadSessionPlan, wholeFileSha256Hex } from "./upload";

function patternBytes(size: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(new ArrayBuffer(size));
	for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 13) & 0xff;
	return bytes;
}

describe("wholeFileSha256Hex", () => {
	it("is the file's own sha-256 across more slices than one", async () => {
		const bytes = patternBytes(9 * 1024 * 1024 + 1234); // past the 8 MiB slice boundary
		const file = new File([bytes], "take.mp4");
		const expected = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		expect(await wholeFileSha256Hex(file)).toBe(expected);
	});

	it("is the file's own sha-256 within a single slice", async () => {
		const bytes = patternBytes(4096);
		const file = new File([bytes], "small.mp4");
		const expected = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		expect(await wholeFileSha256Hex(file)).toBe(expected);
	});
});

/**
 * The session plan's progress arithmetic.
 *
 * 🚨 **This is the suite the production incident wrote.** The runner once read its part
 * runner's `bytes` from inside the progress callback that the very same destructuring
 * was still awaiting — a temporal-dead-zone throw on EVERY progress event of every
 * part, so a production video upload drove its bar to nowhere while the bytes went up
 * all the same (browser error event 5359; local dev rides the direct method and never
 * saw it). The runner takes its I/O as a parameter now, so the callback fires through
 * the fake for real and the arithmetic is asserted on.
 */
describe("uploadSessionPlan", () => {
	it("sums every in-flight part, so interleaved siblings never move the bar backwards", async () => {
		const reported: number[] = [];
		const file = new File([new Uint8Array(300)], "clip.mp4");
		let releaseFirst = () => {};
		const firstHeld = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		// Three workers start together and each reports only its own bytes. The runner's
		// figure must be all of them at once: 80 + 20 + 10 of 300 is 37%. Adding the
		// speaking part to the completed total instead reads 27%, then 7%, then 3% — the
		// backwards stutter this suite exists to fail on.
		const put: SessionPartPutter = async (url, blob, onLoaded) => {
			const number = Number(url.slice(-1));
			if (number === 1) {
				onLoaded(80);
				await firstHeld;
				onLoaded(blob.size);
			} else {
				onLoaded(number === 2 ? 20 : 10);
				if (number === 2) releaseFirst();
			}
			return { etag: `etag-${number}`, bytes: blob.size };
		};
		const key = await uploadSessionPlan(
			file,
			{
				sessionId: "s1",
				partSize: 100,
				parts: [
					{ number: 1, url: "https://storage/part1" },
					{ number: 2, url: "https://storage/part2" },
					{ number: 3, url: "https://storage/part3" },
				],
				held: [],
				digest: "sha-x",
			},
			(p) => {
				if (p != null) reported.push(p);
			},
			undefined,
			{
				put,
				complete: async (parts, digest, sessionId) => {
					expect(sessionId).toBe("s1");
					expect(digest).toBe("sha-x");
					expect(parts).toEqual([
						{ number: 1, etag: "etag-1" },
						{ number: 2, etag: "etag-2" },
						{ number: 3, etag: "etag-3" },
					]);
					return "session-key";
				},
			},
		);
		expect(key).toBe("session-key");
		// The three simultaneous openings are the whole-file sum, never one part's share.
		expect(reported.slice(0, 3)).toEqual([27, 33, 37]);
		for (let i = 1; i < reported.length; i++) {
			expect(reported[i]).toBeGreaterThanOrEqual(reported[i - 1]);
		}
		expect(reported.at(-1)).toBe(100);
	});

	it("holds the bar where it was when a failed part restarts", async () => {
		const reported: number[] = [];
		let attempts = 0;
		// The first attempt puts 60 of its 100 bytes on the wire and then loses the
		// connection. The retry restarts that part's counter at zero, which must not walk
		// the creator's bar back to where the abandoned attempt had reached.
		const put: SessionPartPutter = async (_url, blob, onLoaded) => {
			attempts += 1;
			if (attempts === 1) {
				onLoaded(60);
				throw new Error("network");
			}
			onLoaded(20);
			onLoaded(blob.size);
			return { etag: null, bytes: blob.size };
		};
		const key = await uploadSessionPlan(
			new File([new Uint8Array(100)], "clip.mp4"),
			{
				sessionId: "s3",
				partSize: 100,
				parts: [{ number: 1, url: "https://storage/part1" }],
				held: [],
				digest: "sha-z",
			},
			(p) => {
				if (p != null) reported.push(p);
			},
			undefined,
			{ put, complete: async () => "key3" },
		);
		expect(key).toBe("key3");
		expect(attempts).toBe(2);
		expect(reported).toEqual([60, 100]);
	});

	it("records held parts and starts a resumed attempt at where they already are", async () => {
		const reported: number[] = [];
		const putted: number[] = [];
		const put: SessionPartPutter = async (_url, blob, onLoaded) => {
			onLoaded(blob.size);
			putted.push(blob.size);
			return { etag: null, bytes: blob.size };
		};
		const key = await uploadSessionPlan(
			new File([new Uint8Array(100)], "clip.mp4"),
			{
				sessionId: "s2",
				partSize: 64,
				parts: [
					{ number: 1, url: "https://storage/part1" },
					{ number: 2, url: "https://storage/part2" },
				],
				held: [1],
				digest: "sha-y",
			},
			(p) => {
				if (p != null) reported.push(p);
			},
			undefined,
			{ put, complete: async () => "key2" },
		);
		expect(key).toBe("key2");
		// Part 1's 64 held bytes open the attempt at 64% — not a restarted 0 — and
		// only part 2 goes up.
		expect(putted).toEqual([36]);
		expect(reported[0]).toBe(64);
		expect(reported.at(-1)).toBe(100); // the runner's own final announcement
	});
});
