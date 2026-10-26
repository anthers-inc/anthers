// SPDX-License-Identifier: Apache-2.0
/**
 * The password rule the signup form and the reset route both obey.
 *
 * The refusals are the interesting half: a minimum, the node's maximum, and the two secrets a
 * person already has in front of them (their handle and their email). Composition rules are
 * deliberately absent — see `passwords.ts`.
 */
import { describe, expect, test } from "bun:test";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, passwordProblem } from "./passwords";

describe("passwordProblem", () => {
	test("accepts a length-first passphrase", () => {
		expect(passwordProblem("a longer phrase than ten")).toBeNull();
	});

	test("accepts exactly the minimum and refuses one character under it", () => {
		expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
		expect(passwordProblem("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(
			`Use at least ${MIN_PASSWORD_LENGTH} characters.`,
		);
	});

	test("refuses the node's own maximum, because the node would", () => {
		expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
		expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBe(
			`Use at most ${MAX_PASSWORD_LENGTH} characters.`,
		);
	});

	test("refuses an empty or whitespace-only value", () => {
		expect(passwordProblem("")).toBe("Choose a password.");
		expect(passwordProblem("          ")).toBe("Choose a password.");
	});

	test("refuses the person's own handle or address as the whole secret", () => {
		expect(passwordProblem("JaneDoe.anthers.social", { handle: "@janedoe.anthers.social" })).toBe(
			"That's your handle. Choose something else.",
		);
		expect(passwordProblem("jane@example.com", { email: "Jane@Example.com" })).toBe(
			"That's your email address. Choose something else.",
		);
	});

	test("a handle inside a longer passphrase is not the hazard this rule is about", () => {
		expect(
			passwordProblem("janedoe.anthers.social is my handle", { handle: "janedoe.anthers.social" }),
		).toBeNull();
	});
});
