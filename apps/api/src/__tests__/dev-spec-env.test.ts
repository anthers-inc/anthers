// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pins the rules in `dev-spec-env.ts`. Each one is a decision about which production
 * configuration values a developer machine is allowed to adopt, so each gets a fixture
 * rather than being asserted against whatever this machine's `.do/app.yaml` happens to say.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSharedSpecEnv } from "../dev-spec-env.js";

const dir = mkdtempSync(join(tmpdir(), "dev-spec-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Write a spec fixture and return its path. */
function spec(body: string): string {
	const path = join(dir, `spec-${Math.abs(hash(body))}.yaml`);
	writeFileSync(path, body);
	return path;
}
// Not Math.random(): a fixture path should be a function of its content, so two identical
// specs reuse one file and a changed one gets a new name.
function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	return h;
}

const FULL = spec(`
envs:
  - key: DMCA_AGENT_NAME
    value: Parker Davis
  - key: DMCA_AGENT_EMAIL
    value: copyright@anthers.org
  - key: STORAGE_BACKEND
    value: s3
  - key: DATABASE_URL
    value: \${anthersdb.DATABASE_URL}
  - key: STORAGE_KEY
    type: SECRET
    value: EV[1:aaa:bbb]
services:
  - name: api
    envs:
      - key: PORT
        value: "8000"
      - key: FRONTEND_URL
        value: \${APP_URL}
`);

describe("loadSharedSpecEnv", () => {
	test("fills allowlisted values, from app level and from a component", () => {
		const env: Record<string, string | undefined> = {};
		const filled = loadSharedSpecEnv(FULL, env);
		expect(filled.sort()).toEqual(["DMCA_AGENT_EMAIL", "DMCA_AGENT_NAME", "PORT"]);
		expect(env.DMCA_AGENT_NAME).toBe("Parker Davis");
		expect(env.PORT).toBe("8000"); // component-level, not app-level
	});

	/**
	 * 🚨 The one that matters most. `STORAGE_BACKEND` is `s3` in the spec and `local` in dev;
	 * adopting it would boot the api straight into a credential error on a machine that has
	 * no R2 keys. It is off the allowlist, and this asserts the allowlist is what decides —
	 * not "is it non-secret", which `STORAGE_BACKEND` also is.
	 */
	test("ignores non-secret values that are NOT on the allowlist", () => {
		const env: Record<string, string | undefined> = {};
		loadSharedSpecEnv(FULL, env);
		expect(env.STORAGE_BACKEND).toBeUndefined();
	});

	test("never overrides a value already present", () => {
		const env: Record<string, string | undefined> = { PORT: "9999", DMCA_AGENT_NAME: "Someone" };
		const filled = loadSharedSpecEnv(FULL, env);
		expect(env.PORT).toBe("9999");
		expect(env.DMCA_AGENT_NAME).toBe("Someone");
		expect(filled).not.toContain("PORT");
	});

	test("an empty existing value counts as absent, so a blank .env line still gets filled", () => {
		const env: Record<string, string | undefined> = { DMCA_AGENT_NAME: "" };
		loadSharedSpecEnv(FULL, env);
		expect(env.DMCA_AGENT_NAME).toBe("Parker Davis");
	});

	test("skips App Platform interpolations, which mean nothing off DigitalOcean", () => {
		// Allowlisted here so the skip is doing the work rather than the allowlist.
		const withInterp = spec(`
envs:
  - key: DMCA_AGENT_NAME
    value: \${SOME_APP_PLATFORM_THING}
`);
		const env: Record<string, string | undefined> = {};
		expect(loadSharedSpecEnv(withInterp, env)).toEqual([]);
		expect(env.DMCA_AGENT_NAME).toBeUndefined();
	});

	test("never adopts a SECRET, even one carrying an encrypted value", () => {
		const secretish = spec(`
envs:
  - key: DMCA_AGENT_NAME
    type: SECRET
    value: EV[1:aaa:bbb]
`);
		const env: Record<string, string | undefined> = {};
		expect(loadSharedSpecEnv(secretish, env)).toEqual([]);
	});

	/** Production's guard: the Dockerfile never copies `.do/`, so the file is simply absent. */
	test("no spec file is a silent no-op", () => {
		const env: Record<string, string | undefined> = {};
		expect(loadSharedSpecEnv(null, env)).toEqual([]);
		expect(loadSharedSpecEnv(join(dir, "does-not-exist.yaml"), env)).toEqual([]);
		expect(Object.keys(env)).toEqual([]);
	});

	test("a malformed spec does not stop the dev server booting", () => {
		const broken = spec("envs:\n  - key: [unclosed\n");
		expect(loadSharedSpecEnv(broken, {})).toEqual([]);
	});
});
