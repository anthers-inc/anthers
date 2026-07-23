// SPDX-License-Identifier: AGPL-3.0-or-later

import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Run from apps/web regardless of where `playwright test` is invoked, so the
// webServer command (build.ts + serve.ts) resolves ./dist correctly.
const here = fileURLToPath(new URL(".", import.meta.url));
const apiDir = fileURLToPath(new URL("../api", import.meta.url));
const PORT = 4173;
const API_PORT = 8000;

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	workers: process.env.CI ? 1 : undefined,
	reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "on-first-retry",
		// Chromium needs --no-sandbox in most CI/container environments.
		launchOptions: { args: ["--no-sandbox"] },
	},
	projects: [
		// Seeds the gauntlet fixture and signs its viewer in (writes the storageState the
		// gauntlet project runs under). *.setup.ts so `bun test` never claims it either.
		{ name: "setup", testMatch: "**/*.setup.ts" },
		// The static suite — pure client-side specs (calculators) that predate the API wiring.
		// e2e specs are named *.e2e.ts so `bun test` (which claims *.test/*.spec) never tries
		// to run them — only Playwright does.
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			testMatch: "**/*.e2e.ts",
			testIgnore: "**/user-gauntlet.e2e.ts",
		},
		// The User Gauntlet walk: authenticated (storageState from setup), strictly serial —
		// it is one stateful staircase, not a bag of independent tests.
		{
			name: "gauntlet",
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/e2e/.auth/gauntlet-viewer.json",
			},
			testMatch: "**/user-gauntlet.e2e.ts",
			dependencies: ["setup"],
			fullyParallel: false,
		},
	],
	webServer: [
		// The SPA, built and served statically — what the browser loads.
		{
			command: `bun run build.ts && PORT=${PORT} bun run serve.ts`,
			cwd: here,
			url: `http://localhost:${PORT}`,
			reuseExistingServer: !process.env.CI,
			timeout: 120_000,
		},
		// The real API + Postgres. Pages served from localhost resolve their API base to
		// localhost:8000 (see web-shared rpc.ts), so no proxy is involved — but the API and
		// database must genuinely be up, which is the deliberate cost of authenticated e2e.
		// Locally this reuses a running `make dev` API (same port, same database); without
		// one it brings the dev Postgres up itself (docker) and starts the API. In CI the
		// database is a service container and the environment carries DATABASE_URL.
		{
			command: process.env.CI
				? "bun src/index.ts"
				: "make -C ../.. db-ready && bun --env-file=../../.env src/index.ts",
			cwd: apiDir,
			url: `http://localhost:${API_PORT}/health`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
	],
});
