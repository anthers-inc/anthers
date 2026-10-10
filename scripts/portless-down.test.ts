// SPDX-License-Identifier: Apache-2.0
/**
 * The scope `make down`'s portless fallback kills in. The route table is machine-wide, so the
 * ownership filter here is what stands between a checkout's `make down` and another project's —
 * or another checkout's — live dev server.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownedHostnames, portlessAppNames, type Route } from "./portless-down.ts";

const ROUTES: Route[] = [
	{ hostname: "migration.localhost", port: 8766, pid: 0 },
	{ hostname: "feed-heading.anthers.localhost", port: 4189, pid: 0 },
	{ hostname: "signup-page.anthers.localhost", port: 4330, pid: 100 },
	{ hostname: "signup-page.api.anthers.localhost", port: 4601, pid: 100 },
	{ hostname: "admin.anthers.localhost", port: 4239, pid: 200 },
	{ hostname: "anthers.localhost", port: 4324, pid: 200 },
	{ hostname: "api.anthers.localhost", port: 4602, pid: 200 },
	{ hostname: "polysemy.localhost", port: 5173, pid: 300 },
];

const NAMES = ["anthers", "admin.anthers", "api.anthers"];

describe("which portless routes a checkout may down", () => {
	it("owns the unprefixed project names, and nothing else, in the main checkout", () => {
		const owned = ownedHostnames(ROUTES, NAMES, "", "localhost").map((r) => r.hostname);
		expect(owned).toEqual([
			"admin.anthers.localhost",
			"anthers.localhost",
			"api.anthers.localhost",
		]);
	});

	it("owns only its own branch's prefixed forms in a worktree", () => {
		const owned = ownedHostnames(ROUTES, NAMES, "signup-page", "localhost").map((r) => r.hostname);
		expect(owned).toEqual(["signup-page.anthers.localhost", "signup-page.api.anthers.localhost"]);
	});

	it("never owns another project's routes or another checkout's branch prefix", () => {
		for (const prefix of ["", "signup-page", "other-branch"]) {
			const owned = ownedHostnames(ROUTES, NAMES, prefix, "localhost");
			expect(owned.map((r) => r.hostname)).not.toContain("polysemy.localhost");
			expect(owned.map((r) => r.hostname)).not.toContain("migration.localhost");
			if (prefix !== "" && prefix !== "signup-page") expect(owned).toEqual([]);
		}
	});

	it("leaves a hostname on a TLD it does not serve, on any checkout", () => {
		expect(
			ownedHostnames([{ hostname: "anthers.test", port: 443 }], NAMES, "", "localhost"),
		).toEqual([]);
		expect(
			ownedHostnames([{ hostname: "anthers.test", port: 443 }], NAMES, "signup-page", "localhost"),
		).toEqual([]);
	});
});

describe("the app names a checkout is served under", () => {
	it("reads a single named app, and reads nothing where there is no config", () => {
		const dir = mkdtempSync(join(tmpdir(), "portless-names-"));
		try {
			writeFileSync(join(dir, "portless.json"), JSON.stringify({ name: "single-app" }));
			expect(portlessAppNames(dir)).toEqual(["single-app"]);
			rmSync(join(dir, "portless.json"));
			expect(portlessAppNames(dir)).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
