// SPDX-License-Identifier: Apache-2.0
/**
 * How the scope probe reads a server's answer to a write it built to be refused.
 *
 * 🚨 **The verdict is the whole finding**, and the two answers it must never confuse sit side by
 * side: `InvalidSwap` means the permission and the record were both accepted, while a refusal for
 * the record's shape says nothing about the permission at all. The probe itself needs a person at
 * a browser and a real account, so this is the part of it a test can reach.
 */
import { describe, expect, it } from "bun:test";
import { IMPOSSIBLE_COMMIT, verdictFor } from "./atproto-scope-probe.js";

describe("reading the answer to a write refused at the commit", () => {
	it("reads a refused swap as the permission honored", () => {
		expect(verdictFor(400, { error: "InvalidSwap" })).toBe("honored");
	});

	it("reads a refusal of the credentials as the permission not honored", () => {
		expect(verdictFor(403, { error: "ScopeMissingError" })).toBe("not_honored");
		expect(verdictFor(401, { error: "InvalidToken" })).toBe("not_honored");
	});

	it("does not read a refusal of the record as an answer about the permission", () => {
		expect(verdictFor(400, { error: "InvalidRequest" })).toBe("record_invalid");
		expect(verdictFor(400, { error: "InvalidRecord" })).toBe("record_invalid");
	});

	it("flags a server that committed the record despite the swap", () => {
		expect(verdictFor(200, { error: undefined })).toBe("committed");
	});

	it("leaves anything else for a person to read rather than guessing", () => {
		expect(verdictFor(500, { error: "InternalServerError" })).toBe("unclear");
		expect(verdictFor(400, { error: "SomethingNew" })).toBe("unclear");
		expect(verdictFor(400, null)).toBe("unclear");
	});

	it("names a commit shaped like a real one, so the refusal is about the swap and not the syntax", () => {
		expect(IMPOSSIBLE_COMMIT).toMatch(/^bafyrei[a-z2-7]{52}$/);
	});
});
