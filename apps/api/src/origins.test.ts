// SPDX-License-Identifier: Apache-2.0
/**
 * The admin CORS boundary in a browser session.
 *
 * The admin preview takes a free port rather than :4174 so browser runs can overlap. Without
 * that port in `adminOrigins()`, the admin app's POST preflight is refused and every admin spec
 * fails at the sign-in door — a red gate that says nothing about the code it is gating.
 *
 * ⚠️ **The site preview's port is the other half of this test.** `adminOrigins()` is the boundary
 * that keeps the main site out of every admin route; admitting the site origin here would hand a
 * script on the site the operator's credentials. The two preview ports arrive together in the
 * session environment, and the admin list must take only one of them.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { adminOrigins } from "./origins";

const KEYS = ["ADMIN_PREVIEW_PORT", "PREVIEW_PORT", "ADMIN_URL", "FRONTEND_URL"] as const;
const saved = new Map<string, string | undefined>();

beforeAll(() => {
	for (const key of KEYS) saved.set(key, process.env[key]);
});

afterEach(() => {
	for (const key of KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("adminOrigins in a browser session", () => {
	it("admits the admin preview's free port, and not the site preview's", () => {
		delete process.env.ADMIN_URL;
		delete process.env.FRONTEND_URL;
		process.env.ADMIN_PREVIEW_PORT = "45678";
		process.env.PREVIEW_PORT = "45679";

		const origins = adminOrigins();
		expect(origins).toContain("http://localhost:45678");
		expect(origins).toContain("http://127.0.0.1:45678");
		expect(origins, "the site preview's origin entered the admin list").not.toContain(
			"http://localhost:45679",
		);
		expect(origins).not.toContain("http://127.0.0.1:45679");
	});

	it("does not take the site preview's port on its own", () => {
		delete process.env.ADMIN_URL;
		delete process.env.FRONTEND_URL;
		delete process.env.ADMIN_PREVIEW_PORT;
		process.env.PREVIEW_PORT = "45679";

		expect(adminOrigins()).not.toContain("http://localhost:45679");
	});

	it("keeps the admin list alone on a public deployment", () => {
		process.env.FRONTEND_URL = "https://anthers.org";
		process.env.ADMIN_URL = "https://admin.anthers.org";
		process.env.ADMIN_PREVIEW_PORT = "45678";
		process.env.PREVIEW_PORT = "45679";

		expect(adminOrigins()).toEqual(["https://admin.anthers.org"]);
	});
});
