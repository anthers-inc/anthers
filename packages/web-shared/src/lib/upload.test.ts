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
	it("advances by completed parts plus the in-flight part's load, with no throw on a progress event", async () => {
		const reported: number[] = [];
		const file = new File([new Uint8Array(100)], "clip.mp4");
		// Fires the progress events as the wire does — partway, then the whole part —
		// and a throw in the runner's callback propagates HERE, so the TDZ version
		// fails this suite at its first event with a ReferenceError.
		const put: SessionPartPutter = async (_url, blob, onLoaded) => {
			const size = blob.size;
			onLoaded(Math.floor(size / 4));
			onLoaded(size);
			return { etag: `etag-${size}`, bytes: size };
		};
		const key = await uploadSessionPlan(
			file,
			{
				sessionId: "s1",
				partSize: 64,
				parts: [
					{ number: 1, url: "https://storage/part1" },
					{ number: 2, url: "https://storage/part2" },
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
						{ number: 1, etag: "etag-64" },
						{ number: 2, etag: "etag-36" },
					]);
					return "session-key";
				},
			},
		);
		expect(key).toBe("session-key");
		// Part 1's events are deterministic (both fire before its completion is
		// accounted): a quarter and the whole part. Part 2's are interleaved with
		// part 1's completion on a concurrent wire, so its quarter reads 9 or 73 and
		// its whole 36 or 100 — the assertions hold the *bounds*, not the order.
		expect(reported.length).toBeGreaterThanOrEqual(4);
		expect(reported).toContain(16);
		expect(reported).toContain(64);
		expect(reported.every((p) => p <= 100)).toBe(true);
		// Every value is an honest sum of completed bytes and one in-flight part:
		// exactly the set the two parts' quarter/whole events compose.
		const possible = new Set([9, 16, 36, 64, 73, 100]);
		expect(reported.every((p) => possible.has(p))).toBe(true);
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
