// SPDX-License-Identifier: Apache-2.0
/**
 * The waitlist route sends through the shared email service and escapes what it was given.
 *
 * 🚨 **The source check is the one that matters.** The route once built its own Resend client
 * with the sandbox sender `onboarding@resend.dev`, which Resend delivers only to the account
 * owner, so every real signup failed while the service beside it had already been fixed. A
 * behavioral test cannot see that from the test runner, where no email is ever sent, so the
 * rule that the route owns no client and names no sender is asserted on the file itself.
 */
import { describe, expect, it } from "bun:test";
import { waitlistMessage } from "../routes/waitlist";

describe("the waitlist notification", () => {
	it("escapes the submitted address into the HTML", () => {
		const message = waitlistMessage(`a<b>"@example.com`, "creator");
		expect(message.html).not.toContain("<b>");
		expect(message.html).toContain("a&lt;b&gt;");
		expect(message.to).toBe("contact@anthers.org");
	});

	it("🚨 owns no Resend client and names no sender of its own", async () => {
		const source = await Bun.file(new URL("../routes/waitlist.ts", import.meta.url)).text();
		const code = source.replace(/\/\*[\s\S]*?\*\//g, "");
		expect(code).not.toContain("new Resend(");
		expect(code).not.toContain("resend.dev");
		expect(code).toContain("sendEmail(");
	});
});
