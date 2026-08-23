// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Three security branches read `NODE_ENV`, which production does not set — so each of them
 * silently took its development branch on the live site.
 *
 * 🚨 **Every case below is written against PRODUCTION'S ACTUAL ENVIRONMENT, which is
 * `FRONTEND_URL=https://anthers.org` with `NODE_ENV` deleted.** That distinction is the whole
 * point of this file. A test that sets `NODE_ENV="production"` and then asserts the strict
 * behaviour describes the author's model of production rather than production, and two
 * ATProto defects shipped green past exactly that mistake (see the note in 42.05). Each
 * `describe` therefore deletes `NODE_ENV` explicitly rather than relying on it being unset.
 *
 * ⚠️ **These are unit assertions and they are not the verification.** A `Set-Cookie` header
 * built in-process proves the code's intent; only `curl -I` against the live site proves the
 * deployment's. Both were run — see the task record.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { setSecureCookie, setSessionCookie } from "../lib/cookies.js";
import { isPublicDeployment, publicOrigin } from "../lib/deployment.js";
import { allowedOrigins } from "../origins.js";

const TOUCHED = ["BASE_URL", "FRONTEND_URL", "NODE_ENV"] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
	for (const key of TOUCHED) saved.set(key, process.env[key]);
});

afterEach(() => {
	for (const key of TOUCHED) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** Production, as the live App Platform spec actually configures it. */
function asProduction(): void {
	delete process.env.BASE_URL;
	delete process.env.NODE_ENV;
	process.env.FRONTEND_URL = "https://anthers.org";
}

/** A developer's machine, as `.env.example` and the code's own fallbacks describe it. */
function asDevelopment(): void {
	delete process.env.BASE_URL;
	delete process.env.NODE_ENV;
	process.env.FRONTEND_URL = "http://localhost:3000";
}

describe("publicOrigin", () => {
	it("reads an https origin as public with NODE_ENV unset", () => {
		expect(publicOrigin({ FRONTEND_URL: "https://anthers.org" })).toBe("https://anthers.org");
		expect(isPublicDeployment({ FRONTEND_URL: "https://anthers.org" })).toBe(true);
	});

	it("does not mistake the dev origin for a public one", () => {
		// Dev sets FRONTEND_URL too. A check for whether the variable is SET rather than what
		// scheme it carries would call every developer's machine production.
		expect(publicOrigin({ FRONTEND_URL: "http://localhost:3000" })).toBeNull();
		expect(isPublicDeployment({})).toBe(false);
	});

	it("ignores NODE_ENV in both directions, which is the point of the helper", () => {
		// 🚨 The label is not the thing. `NODE_ENV=production` with no public origin is a
		// misconfiguration, not a deployment; an https origin with no NODE_ENV is production.
		expect(isPublicDeployment({ NODE_ENV: "production" })).toBe(false);
		expect(
			isPublicDeployment({ NODE_ENV: "development", FRONTEND_URL: "https://anthers.org" }),
		).toBe(true);
	});

	it("prefers BASE_URL, strips trailing slashes, and accepts any scheme casing", () => {
		expect(
			publicOrigin({ BASE_URL: "https://api.anthers.org/", FRONTEND_URL: "https://anthers.org" }),
		).toBe("https://api.anthers.org");
		expect(publicOrigin({ FRONTEND_URL: "HTTPS://anthers.org///" })).toBe("HTTPS://anthers.org");
	});

	it("treats an empty value as absent", () => {
		// `Number("")` is 0 and `""` is not undefined: this repo has been bitten by both.
		expect(publicOrigin({ BASE_URL: "", FRONTEND_URL: "https://anthers.org" })).toBe(
			"https://anthers.org",
		);
		expect(isPublicDeployment({ FRONTEND_URL: "  " })).toBe(false);
	});
});

describe("allowedOrigins in production's actual environment", () => {
	it("admits no localhost origin", () => {
		// 🚨 The live defect: any page served from localhost on a visitor's machine could make
		// CREDENTIALED cross-origin requests to anthers.org, read the responses, and pass the
		// CSRF origin check, because allowedOrigins() is shared by both.
		asProduction();
		const origins = allowedOrigins();
		// Matched by SHAPE rather than by listing the four ports, so a fifth dev origin added
		// to the other branch cannot slip past this assertion.
		expect(origins.filter((o) => /^https?:\/\/localhost(:|$)/.test(o))).toEqual([]);
		expect(origins).toContain("https://anthers.org");
		// The desktop Studio's own origins survive: they are bearer-authenticated, so they
		// carry no ambient authority, and both merely LOOK like localhost.
		expect(origins).toContain("tauri://localhost");
		expect(origins).toContain("http://tauri.localhost");
	});

	it("still admits the dev and e2e origins on a developer's machine", () => {
		asDevelopment();
		const origins = allowedOrigins();
		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://localhost:4173");
	});
});

/** Read the cookie a browser would actually be sent, rather than the options object. */
async function setCookieHeader(write: (c: any) => void): Promise<string> {
	const app = new Hono();
	app.get("/", (c) => {
		write(c);
		return c.body(null, 204);
	});
	const res = await app.request("http://localhost/");
	return res.headers.get("set-cookie") ?? "";
}

describe("cookies in production's actual environment", () => {
	it("marks the session cookie Secure", async () => {
		asProduction();
		const header = await setCookieHeader((c) => setSessionCookie(c, "tok"));
		expect(header).toContain("session=tok");
		expect(header).toContain("Secure");
		expect(header).toContain("HttpOnly");
	});

	it("marks the ATProto pending-signup cookie Secure, through the same helper", async () => {
		// The pending cookie carried its own copy of these attributes and its own NODE_ENV
		// branch. It goes through `setSecureCookie` now, so this asserts the shared policy the
		// route actually calls rather than a second description of it.
		asProduction();
		const header = await setCookieHeader((c) => setSecureCookie(c, "atproto_pending", "tok", 600));
		expect(header).toContain("atproto_pending=tok");
		expect(header).toContain("Secure");
	});

	it("leaves Secure off in development, where the site is plain http", async () => {
		asDevelopment();
		const header = await setCookieHeader((c) => setSessionCookie(c, "tok"));
		expect(header).toContain("session=tok");
		expect(header).not.toContain("Secure");
	});
});
