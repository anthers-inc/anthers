// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which face the finishing page shows, and the distinction that decides it.
 *
 * 🚨 **This is the one bug in the signup rebuild that reached a real person.** Parker walked
 * the Bluesky door on 2026-08-26, granted `transition:email`, and was shown an email field as
 * though nothing had been learned. The server had done its job perfectly — the PDS returned
 * the address and it was written to the pending signup — and the page still could not use it,
 * because it chose its state on *"do we have an address"* when the question that matters is
 * *"have we posted to it"*.
 *
 * Those two facts come apart on exactly one path, which is why nothing caught it: the Bluesky
 * door reaches this page with no address at all. `begin` runs before the round trip and has
 * nothing to send to; the PDS supplies one at the OAuth callback, which posts nothing. So the
 * page announced "we sent a six-character code to …" for an address nothing had ever been
 * sent to.
 *
 * ⚠️ **A pure function, tested directly, because the alternative is not testable.** The rest
 * of this page needs a browser, a pending signup and a real OAuth round trip; the decision
 * itself needs none of them, and it is the whole of what went wrong.
 */
import { describe, expect, it } from "bun:test";
import { faceFor } from "./FinishSignupPage";

const pending = (over: Partial<Parameters<typeof faceFor>[0]> = {}) => ({
	email: null,
	codeSent: false,
	addressProved: false,
	...over,
});

describe("choosing the face", () => {
	it("asks for an address when there is none", () => {
		expect(faceFor(pending())).toBe("address");
	});

	it("🚨 asks about the address Bluesky gave us rather than claiming to have mailed it", () => {
		// The regression. An address the PDS handed over is a prefill, and nothing has been
		// posted to it — so the honest face is the one with a field in it, filled in.
		expect(faceFor(pending({ email: "someone@example.com", codeSent: false }))).toBe("address");
	});

	it("shows the code box once a code has actually gone out", () => {
		expect(faceFor(pending({ email: "someone@example.com", codeSent: true }))).toBe("code");
	});

	it("needs no code at all when the address was already proved elsewhere", () => {
		// The cross-browser resume: the mailbox was proved at `/login`, and asking again would
		// be asking somebody to prove the same fact twice.
		expect(
			faceFor(pending({ email: "someone@example.com", codeSent: false, addressProved: true })),
		).toBe("resumed");
	});

	it("prefers the proved state even when a code is outstanding", () => {
		expect(
			faceFor(pending({ email: "someone@example.com", codeSent: true, addressProved: true })),
		).toBe("resumed");
	});
});
