// SPDX-License-Identifier: Apache-2.0
/**
 * The password door's one browser-side guard.
 *
 * 🚨 **A login that sets a cookie without checking where the request came from is a login-CSRF.**
 * An attacker posts their own credentials from a page the victim is visiting; the victim's browser
 * ends up signed in to the attacker's account, so their next actions land there. The route refuses
 * a present-but-foreign Origin before it looks at the password at all.
 */
import { describe, expect, it } from "bun:test";
import app from "../index.js";

describe("signing in with a password", () => {
	it("refuses a foreign origin before checking the password", async () => {
		const res = await app.request("/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
			body: JSON.stringify({
				identifier: "someone@example.test",
				password: "a long enough password",
			}),
		});
		expect(res.status).toBe(403);
		expect(res.headers.get("set-cookie") ?? "").not.toContain("session=");
	});
});
