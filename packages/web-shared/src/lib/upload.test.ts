// SPDX-License-Identifier: Apache-2.0
/**
 * The whole-file digest, read ahead of a session upload — the resume's key and the
 * completion's identity, computed here once and used twice. The expectation is
 * computed by Bun's own hasher, independent of the chained-slice read under test;
 * what the suite proves is that the slices arrive in order and nothing is skipped
 * or doubled at the 8 MiB boundary the reader uses.
 */
import { describe, expect, it } from "bun:test";
import { wholeFileSha256Hex } from "./upload";

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
