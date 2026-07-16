// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import app from "../index";

const testFetch = app.fetch;

// csrfProtection turns away any mutation without an allowed Origin, so the gate
// is only reachable from one — the same as it is from a real browser.
const ORIGIN = "http://localhost:3000";

function postGate(body: unknown) {
	return testFetch(
		new Request("http://localhost/health/gate", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify(body),
		}),
	);
}

const originalPassword = process.env.SITE_PASSWORD;
const originalKeys = process.env.SITE_ACCESS_KEYS;

beforeEach(() => {
	process.env.SITE_PASSWORD = "open-sesame";
	process.env.SITE_ACCESS_KEYS = "press-preview, jane-doe";
});

afterEach(() => {
	process.env.SITE_PASSWORD = originalPassword;
	process.env.SITE_ACCESS_KEYS = originalKeys;
});

describe("POST /health/gate — password", () => {
	it("accepts the site password", async () => {
		const res = await postGate({ password: "open-sesame" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("rejects a wrong password", async () => {
		expect((await postGate({ password: "nope" })).status).toBe(403);
	});

	it("rejects everything when no password is configured", async () => {
		process.env.SITE_PASSWORD = "";
		expect((await postGate({ password: "" })).status).toBe(403);
	});
});

describe("POST /health/gate — invite keys", () => {
	it("accepts a configured invite key", async () => {
		const res = await postGate({ invite: "press-preview" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
	});

	it("accepts a key listed after another, ignoring surrounding whitespace", async () => {
		expect((await postGate({ invite: "jane-doe" })).status).toBe(200);
	});

	it("rejects a key that was revoked from the list", async () => {
		process.env.SITE_ACCESS_KEYS = "jane-doe";
		expect((await postGate({ invite: "press-preview" })).status).toBe(403);
		// Revoking one link leaves the others working.
		expect((await postGate({ invite: "jane-doe" })).status).toBe(200);
	});

	it("rejects an empty key when no keys are configured", async () => {
		process.env.SITE_ACCESS_KEYS = "";
		expect((await postGate({ invite: "" })).status).toBe(403);
	});

	it("does not accept the site password as an invite key", async () => {
		expect((await postGate({ invite: "open-sesame" })).status).toBe(403);
	});
});

describe("POST /health/gate — malformed requests", () => {
	it("rejects a body that isn't JSON", async () => {
		const res = await testFetch(
			new Request("http://localhost/health/gate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN },
				body: "not json",
			}),
		);
		expect(res.status).toBe(400);
	});

	it("rejects a redeem attempt from an origin CSRF doesn't allow", async () => {
		const res = await testFetch(
			new Request("http://localhost/health/gate", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
				body: JSON.stringify({ invite: "press-preview" }),
			}),
		);
		expect(res.status).toBe(403);
	});

	it("rejects a body carrying neither secret", async () => {
		expect((await postGate({})).status).toBe(403);
	});

	it("rejects non-string secrets", async () => {
		expect((await postGate({ password: true, invite: 1 })).status).toBe(403);
	});
});
