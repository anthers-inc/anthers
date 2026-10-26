// SPDX-License-Identifier: Apache-2.0
/**
 * What counts as a usable password for an identity Anthers hosts.
 *
 * 🚨 **This is the person's password at their identity server, not an Anthers password.** Anthers
 * has no password sign-in of its own: the app is a client of the identity, and the credential is
 * the one the person types at the authorization server. So the rules here are the ones the node
 * should have — length, and nothing else that pretends to measure strength.
 *
 * ⭐ **Length rather than composition.** A minimum of ten characters with no character-class
 * requirement is the current guidance, and the reason is that composition rules push people toward
 * predictable substitutions (`P@ssw0rd1!`) while a longer phrase is both easier to remember and
 * harder to guess. The server stores only a scrypt hash, so the cost of a guess is already real;
 * this rule is about making the guess space large enough that the cost matters.
 *
 * ⚠️ **The node itself enforces only a maximum of 256 characters** (`NEW_PASSWORD_MAX_LENGTH`),
 * so the minimum and the two refusals below are Anthers'. They are shared between the API and the
 * browser so the form and the route cannot disagree about what is acceptable.
 *
 * ⚠️ **Never store the value this checks.** It is read to be validated and then handed to the node
 * in the request that creates or resets the account; `hosted-accounts.ts` carries the rule that
 * the only credential Anthers keeps is a session.
 */

/** The shortest password the form will accept, in characters. */
export const MIN_PASSWORD_LENGTH = 10;

/** The node's own ceiling. Anything longer is refused by the server, so it is refused here first. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * Why this password cannot be used, as a sentence the person can act on, or null when it can.
 *
 * `handle` and `email` are optional because the reset door knows both and the signup form knows
 * the handle it is about to issue. They are compared exactly (case-insensitively) rather than by
 * substring: refusing a password because it contains the letters of a handle would reject
 * perfectly good passphrases while doing nothing about the actual risk, which is somebody choosing
 * their own name as the whole secret.
 */
export function passwordProblem(
	value: string,
	opts: { handle?: string | null; email?: string | null } = {},
): string | null {
	if (!value.trim()) return "Choose a password.";
	if (value.length < MIN_PASSWORD_LENGTH) {
		return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	// The maximum is the node's, and it counts the same value it will receive.
	if (value.length > MAX_PASSWORD_LENGTH) {
		return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
	}

	const candidate = value.trim().toLowerCase();
	const bareHandle = opts.handle?.trim().replace(/^@/, "").toLowerCase();
	if (bareHandle && candidate === bareHandle) {
		return "That's your handle. Choose something else.";
	}
	const address = opts.email?.trim().toLowerCase();
	if (address && candidate === address) {
		return "That's your email address. Choose something else.";
	}
	return null;
}
