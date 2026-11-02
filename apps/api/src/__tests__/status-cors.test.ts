// SPDX-License-Identifier: Apache-2.0
/**
 * The status page is a public read on a separate failure domain. It gets its own
 * credential-less CORS policy; it is not a credentialed origin and not a CSRF origin.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import app from "../index";

const FRONTEND = process.env.FRONTEND_URL;
const BASE = process.env.BASE_URL;
const STATUS = process.env.STATUS_PAGE_URL;

beforeAll(() => {
	process.env.BASE_URL = "https://api.anthers.org";
	process.env.FRONTEND_URL = "https://anthers.org";
	process.env.STATUS_PAGE_URL = "https://status.anthers.org";
});

afterAll(() => {
	if (BASE === undefined) delete process.env.BASE_URL;
	else process.env.BASE_URL = BASE;
	if (FRONTEND === undefined) delete process.env.FRONTEND_URL;
	else process.env.FRONTEND_URL = FRONTEND;
	if (STATUS === undefined) delete process.env.STATUS_PAGE_URL;
	else process.env.STATUS_PAGE_URL = STATUS;
});

it("answers the status origin without allowing credentials", async () => {
	const res = await app.request("http://localhost/api/status", {
		method: "OPTIONS",
		headers: {
			Origin: "https://status.anthers.org",
			"Access-Control-Request-Method": "GET",
		},
	});
	expect(res.status).toBe(204);
	expect(res.headers.get("access-control-allow-origin")).toBe("https://status.anthers.org");
	expect(res.headers.get("access-control-allow-credentials")).toBeNull();
});

it("does not admit the status origin to a CSRF-protected mutation", async () => {
	const res = await app.request("http://localhost/api/accounts/me", {
		method: "PATCH",
		headers: { Origin: "https://status.anthers.org", "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	expect(res.status).toBe(403);
});
