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
	/*
	 * 🚨 **`metadata.needsMedia` splits this suite across two CI jobs, and it is the ONLY
	 * place that split is written down.** A project needs media if running it wants ffmpeg
	 * or poppler — which in practice means it seeds, or depends on something that seeds, the
	 * fixtures that produce bytes a player can actually play. Those run in a container image
	 * carrying both tools; everything else runs on a bare runner with no system dependencies
	 * at all, which is what makes that half of the suite unable to fail for infrastructure
	 * reasons.
	 *
	 * The flag lives here rather than as two lists in `ci.yml` because Playwright 1.61 has no
	 * `--project` negation: a job can only name projects, so a project added later would run
	 * in NEITHER job and nothing would say so — a green suite quietly covering less than it
	 * did. `scripts/e2e-projects.ts` derives both job's arguments from this array and **fails
	 * on a project that declares no flag**, so the failure mode is a red run naming the
	 * project rather than silence.
	 *
	 * Nothing about local running changes: `make verify` and a bare `playwright test` still
	 * run every project, so the pre-push gate keeps meaning what it meant.
	 */
	projects: [
		// Seeds the gauntlet fixture and signs its viewer in (writes the storageState the
		// gauntlet project runs under). *.setup.ts so `bun test` never claims it either.
		{ name: "setup", testMatch: "**/*.setup.ts", metadata: { needsMedia: true } },
		// The static suite — pure client-side specs (calculators) that predate the API wiring.
		// e2e specs are named *.e2e.ts so `bun test` (which claims *.test/*.spec) never tries
		// to run them — only Playwright does.
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
			testMatch: "**/*.e2e.ts",
			// Both authenticated suites are excluded: they need the session storageState
			// that only `setup` produces, and signed out every route on this app renders the
			// same marketing page — so they would pass here without asserting anything.
			testIgnore: ["**/user-gauntlet.e2e.ts", "**/*.authed.e2e.ts"],
			metadata: { needsMedia: false },
		},
		// Authenticated specs that are NOT the gauntlet: independent, parallel-safe, and
		// signed in as the fixture viewer. Separate from `gauntlet` on purpose — that one is
		// a single stateful staircase where order is the point, and dropping unrelated tests
		// into it would make its ratchet assertions depend on what else ran.
		{
			name: "authed",
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/e2e/.auth/gauntlet-viewer.json",
			},
			testMatch: "**/*.authed.e2e.ts",
			dependencies: ["setup"],
			metadata: { needsMedia: true },
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
			metadata: { needsMedia: true },
		},
	],
	webServer: [
		// The SPA, built and served statically — what the browser loads.
		//
		// NEVER reused, even locally. This is the only server that serves the *bundle*, and
		// reusing it skips the `build.ts` in the command above — so anything already sitting
		// on this port (a preview you started by hand, an earlier run) gets tested instead of
		// your working tree. That produces the worst kind of failure: one the source in front
		// of you contradicts. It cost a debugging cycle on 2026-07-28, chasing a fix that was
		// already correct. A rebuild is a few seconds; a lie is expensive.
		{
			command: `bun run build.ts && PORT=${PORT} bun run serve.ts`,
			cwd: here,
			url: `http://localhost:${PORT}`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		// The real API + Postgres. Pages served from localhost resolve their API base to
		// localhost:8000 (see web-shared rpc.ts), so no proxy is involved — but the API and
		// database must genuinely be up, which is the deliberate cost of authenticated e2e.
		// Locally this reuses a running `make dev` API (same port, same database); without
		// one it brings the dev Postgres up itself (docker) and starts the API. In CI the
		// database is a service container and the environment carries DATABASE_URL.
		//
		// Reuse is kept HERE, unlike the SPA above, because this server doesn't serve the
		// bundle — it runs from source, so a running `make dev` API is already current. That
		// asymmetry is the point: reuse what can't go stale, rebuild what can.
		{
			// In CI the API is run under a restart loop, because Bun sometimes segfaults it.
			//
			// Observed 2026-08-08 on Bun 1.3.9 — the version pinned specifically to dodge the
			// 1.3.14 crash — as `panic(main thread): Segmentation fault at address 0x0`, and
			// the decoded report puts it in `uWS::HttpContext<false>::init()` off a socket
			// closure. That is inside Bun's own HTTP server; nothing in this repo can prevent
			// it, and it does not reproduce locally.
			//
			// What it cost is out of all proportion to how often it happens. Playwright does
			// not supervise `webServer`, so the API stayed dead for the rest of the run: every
			// later request got ECONNRESET, `retries: 2` re-ran tests against a corpse, and the
			// visible failure was whatever assertion happened to be next — a locked heading
			// that never rendered, three tests away from the crash. Two separate investigations
			// chased that symptom to real-but-unrelated bugs before anyone read the server log.
			//
			// Restarting turns a doomed run into one flaky test that its retry then passes. The
			// loop is bounded so a genuinely un-startable API still fails fast rather than
			// spinning, and each restart prints a line — if these appear, the crash is still
			// happening and the Bun version is worth revisiting, so do not let it go quiet.
			command: process.env.CI
				? 'for i in 1 2 3 4 5; do bun src/server.ts && break; echo "[api] exited unexpectedly — restart $i/5"; sleep 1; done'
				: "make -C ../.. db-ready && bun --env-file=../../.env src/server.ts",
			cwd: apiDir,
			url: `http://localhost:${API_PORT}/health`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
	],
});
