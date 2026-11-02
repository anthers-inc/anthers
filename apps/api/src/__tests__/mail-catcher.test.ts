// SPDX-License-Identifier: Apache-2.0
/**
 * Where a session's email goes, and what happens to a code when it goes nowhere.
 *
 * 🚨 **The dangerous direction is production honoring the catcher.** Every code and every alert
 * would be handed to an address nothing reads while `sendEmail` reported each one sent, so sign-in
 * would stop working for everybody with no error anywhere. That refusal is what this pins first.
 *
 * Delivery into the catcher itself is exercised end to end by the browser suite, which signs up and
 * signs in with codes read back out of the session's inbox — `sendEmail` refuses to send at all
 * under this test runner, so no suite here can reach it.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mailCatcherUrl, sendSignInCodeEmail, sendSignupCodeEmail } from "../services/email.js";

describe("the mail catcher a session names", () => {
	it("is used on a developer's machine", () => {
		expect(
			mailCatcherUrl({
				MAIL_CATCHER_URL: "http://localhost:8025/",
				FRONTEND_URL: "http://localhost:3000",
			}),
		).toBe("http://localhost:8025");
	});

	it("is ignored in a public deployment, whatever the environment says", () => {
		expect(
			mailCatcherUrl({
				MAIL_CATCHER_URL: "http://localhost:8025",
				FRONTEND_URL: "https://anthers.org",
			}),
		).toBeNull();
	});

	it("is absent when nothing names one", () => {
		expect(mailCatcherUrl({ FRONTEND_URL: "http://localhost:3000" })).toBeNull();
		expect(mailCatcherUrl({ MAIL_CATCHER_URL: "  " })).toBeNull();
	});
});

describe("a code that was not sent", () => {
	const info = spyOn(console, "info");
	const warn = spyOn(console, "warn");
	afterEach(() => {
		info.mockClear();
		warn.mockClear();
	});

	// 🚨 The code used to reach the console twice — once from the failure branch's `if (!sent)`,
	// which read an object that is always truthy and so never ran, and once because the code is
	// in the subject line of the skipped-send warning. Both are closed; a developer reads the
	// code from the session's mail catcher or the database, not from the log stream.
	it("is not written to the console, and the address is redacted", async () => {
		await sendSignupCodeEmail("someone@example.com", "ABC234");
		await sendSignInCodeEmail("someone@example.com", "XYZ789");
		const logged = [...info.mock.calls, ...warn.mock.calls]
			.map((call) => call.map(String).join(" "))
			.join("\n");
		expect(logged).not.toContain("ABC234");
		expect(logged).not.toContain("XYZ789");
		expect(logged).toContain("s…@example.com");
	});
});
