// SPDX-License-Identifier: Apache-2.0
/**
 * A code email's failure path must not turn the log into a second delivery channel.
 *
 * The subject carries the code by design, so the skipped-send warning must not print the
 * subject; the service's own failure line prints the address and never the code.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	sendAdminSignInCodeEmail,
	sendSignInCodeEmail,
	sendSignupCodeEmail,
} from "../services/email";

const restored: Array<() => void> = [];

afterEach(() => {
	while (restored.length > 0) restored.pop()?.();
});

describe("code emails on a skipped send", () => {
	it("never puts the code in the log, and redacts the address", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const info = spyOn(console, "info").mockImplementation(() => {});
		const error = spyOn(console, "error").mockImplementation(() => {});
		restored.push(
			() => warn.mockRestore(),
			() => info.mockRestore(),
			() => error.mockRestore(),
		);

		const code = "ABC123";
		await sendSignupCodeEmail("person@example.com", code);
		await sendSignInCodeEmail("person@example.com", code);
		await sendAdminSignInCodeEmail("admin@example.com", code);

		const lines = [...warn.mock.calls, ...info.mock.calls, ...error.mock.calls]
			.map((args) => args.map(String).join(" "))
			.join("\n");
		expect(lines).not.toContain(code);
		expect(lines).toContain("p…@example.com");
	});
});
