// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The half of the handle rules both the browser and the server run.
 *
 * ⭐ **These live here rather than beside the API's copy because the point of the module is
 * that there is one copy.** A name with an underscore has to be refused identically in the
 * card as somebody types and at the route that creates the account, and a test that only ever
 * ran against one of them would not notice the two drifting.
 *
 * 🚨 **A null answer is not availability.** Nothing here knows whether a name is taken or
 * reserved — the node decides that, and `hosted-accounts.test.ts` covers the server's half.
 */
import { describe, expect, it } from "bun:test";
import {
	handleSyntaxProblem,
	MAX_HANDLE_NAME,
	MIN_HANDLE_NAME,
	normalizeHandleName,
} from "./handles.js";

describe("normalizeHandleName", () => {
	it("takes a name however somebody writes it", () => {
		expect(normalizeHandleName("  @Alice  ", "anthers.social")).toBe("alice");
		expect(normalizeHandleName("Alice.anthers.social", "anthers.social")).toBe("alice");
		expect(normalizeHandleName("@alice.anthers.social", "anthers.social")).toBe("alice");
	});

	// The suffix is stripped only from the end. A name that merely contains it is a name.
	it("does not strip a suffix that is not at the end", () => {
		expect(normalizeHandleName("anthers.social.fan", "anthers.social")).toBe("anthers.social.fan");
	});

	// ⚠️ The browser learns the suffix from the API and has none until it answers. An empty
	// suffix must not turn every name into a stripped fragment of itself.
	it("strips nothing when the suffix is not known yet", () => {
		expect(normalizeHandleName("alice.", "")).toBe("alice.");
		expect(normalizeHandleName("@Alice", "")).toBe("alice");
	});
});

describe("handleSyntaxProblem", () => {
	it("accepts an ordinary name", () => {
		expect(handleSyntaxProblem("alice")).toBeNull();
		expect(handleSyntaxProblem("alice-in-print")).toBeNull();
		expect(handleSyntaxProblem("a1b2")).toBeNull();
	});

	it("refuses names that are too short or too long", () => {
		expect(handleSyntaxProblem("a".repeat(MIN_HANDLE_NAME - 1))).toContain("at least");
		expect(handleSyntaxProblem("a".repeat(MAX_HANDLE_NAME + 1))).toContain("at most");
		expect(handleSyntaxProblem("a".repeat(MAX_HANDLE_NAME))).toBeNull();
	});

	// 🚨 A handle is a domain name and an Anthers username is not, so the two alphabets differ
	// by exactly one character people actually use. Naming it beats restating the rule.
	it("names the underscore rather than restating the alphabet", () => {
		const problem = handleSyntaxProblem("alice_in_print");
		expect(problem).toContain("underscores");
		expect(problem).toContain("hyphen");
	});

	it("refuses characters a domain name cannot carry", () => {
		expect(handleSyntaxProblem("alice!")).toContain("letters, numbers and hyphens");
		expect(handleSyntaxProblem("alice.smith")).toContain("letters, numbers and hyphens");
	});

	it("refuses a leading or trailing hyphen, which a DNS label cannot have", () => {
		expect(handleSyntaxProblem("-alice")).toContain("hyphen");
		expect(handleSyntaxProblem("alice-")).toContain("hyphen");
	});

	// ⚠️ **Uppercase is refused rather than quietly accepted**, because this runs on a value
	// that has already been through `normalizeHandleName`. Accepting it here would mean the
	// browser's check and the server's disagreed about a name somebody typed with a capital.
	it("refuses uppercase, which normalization is expected to have removed", () => {
		expect(handleSyntaxProblem("Alice")).toContain("letters, numbers and hyphens");
	});

	// 🚨 The message is what a reader sees under the field, in a region held at two lines. A
	// longer one grows the panel and moves the button out from under the pointer.
	it("keeps every message inside two lines at 390px", () => {
		const problems = [
			handleSyntaxProblem("ab"),
			handleSyntaxProblem("a".repeat(MAX_HANDLE_NAME + 1)),
			handleSyntaxProblem("alice_in_print"),
			handleSyntaxProblem("alice!"),
			handleSyntaxProblem("-alice"),
		];
		for (const problem of problems) {
			expect(problem).not.toBeNull();
			// Roughly 45 characters fit a line at that width; two lines is the reserved region.
			expect(problem?.length, `too long for two lines: ${problem}`).toBeLessThanOrEqual(90);
		}
	});
});
