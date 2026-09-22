// SPDX-License-Identifier: Apache-2.0
/**
 * Whether the Work's Edit page holds anything unsaved. The failure worth a suite is the page
 * announcing changes nobody made, which is what the access table's rungs arriving late would do.
 */
import { describe, expect, it } from "bun:test";
import type { WorkInput } from "@anthers/web-shared/types";
import { unsavedKey } from "./work-edit";

const base: WorkInput = {
	title: "A song",
	description: "",
	visibility: "private",
	streamEnabled: true,
	downloadEnabled: false,
	seedAccess: [{ threshold: 0, allow: true, price: "0.00" }],
	originallyReleased: null,
};

describe("unsavedKey", () => {
	it("is unchanged when the creator's rungs arrive with no rows ticked", () => {
		const withRungs: WorkInput = {
			...base,
			seedAccess: [
				{ threshold: 0, allow: true, price: "0.00" },
				{ threshold: 3, allow: false, price: "0.00" },
				{ threshold: 6, allow: false, price: "0.00" },
			],
		};
		expect(unsavedKey(withRungs)).toBe(unsavedKey(base));
	});

	it("changes when a rung is ticked or priced", () => {
		const ticked: WorkInput = {
			...base,
			seedAccess: [...(base.seedAccess ?? []), { threshold: 3, allow: true, price: "0.00" }],
		};
		const priced: WorkInput = {
			...base,
			seedAccess: [...(base.seedAccess ?? []), { threshold: 3, allow: false, price: "2.00" }],
		};
		expect(unsavedKey(ticked)).not.toBe(unsavedKey(base));
		expect(unsavedKey(priced)).not.toBe(unsavedKey(base));
	});

	it("changes when the baseline row stops letting everyone in", () => {
		const closed: WorkInput = {
			...base,
			seedAccess: [{ threshold: 0, allow: false, price: "0.00" }],
		};
		expect(unsavedKey(closed)).not.toBe(unsavedKey(base));
	});

	it("changes with any other field", () => {
		expect(unsavedKey({ ...base, title: "Another song" })).not.toBe(unsavedKey(base));
		expect(unsavedKey({ ...base, visibility: "released" })).not.toBe(unsavedKey(base));
	});

	it("changes when a credit is added, edited, or removed", () => {
		const credited: WorkInput = {
			...base,
			credits: [{ role: "Written by", contributor: "A. Creator", types: ["created"] }],
		};
		expect(unsavedKey(credited)).not.toBe(unsavedKey(base));
		const edited: WorkInput = {
			...base,
			credits: [{ role: "Written by", contributor: "A. Creator", types: ["created", "ai"] }],
		};
		expect(unsavedKey(edited)).not.toBe(unsavedKey(credited));
		// Removing them all is an edit back to the empty table the save sends, not to omission.
		expect(unsavedKey({ ...base, credits: [] })).not.toBe(unsavedKey(credited));
	});
});
