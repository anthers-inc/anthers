// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Run from apps/web regardless of where `playwright test` is invoked, so the
// webServer command (build.ts + serve.ts) resolves ./dist correctly.
const here = fileURLToPath(new URL(".", import.meta.url));
const apiDir = fileURLToPath(new URL("../api", import.meta.url));
/*
 * 🚨 **This suite runs inside a browser session, never against a database somebody else is using.**
 * `make test-e2e` and `make verify` start one (`scripts/session.ts browser`), which brings up its
 * own Postgres and AT Protocol network and hands this config free ports for the preview and the
 * API — so a run can overlap `make dev` on :8000, or another run, without either touching the
 * other's data. The fallbacks below are CI's, where the job's service containers are the session.
 */
const PORT = Number(process.env.PREVIEW_PORT ?? 4173);
const API_PORT = Number(process.env.API_PORT ?? 8000);
/** The admin app's preview, which `scripts/session.ts` starts beside the site's. */
const ADMIN_PORT = Number(process.env.ADMIN_PREVIEW_PORT ?? 4174);
const adminDir = fileURLToPath(new URL("../admin", import.meta.url));

/**
 * Refuses to start a server outside a session. A bare `bunx playwright test` would otherwise bring
 * the API up against whatever `.env` names — the running dev session's database — and seed the
 * gauntlet fixture into it. Checked in the command rather than at the top of this file, because
 * `scripts/e2e-projects.ts` imports the config just to read its projects.
 */
const REQUIRE_SESSION =
	'test -n "$ANTHERS_SESSION" || { echo "Run the browser suite in a session: make test-e2e, or bun run ../../scripts/session.ts browser -- bunx playwright test"; exit 1; }';

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
		//
		// ⚠️ **These run on the fixture as `setup` left it, which is why `gauntlet` waits for
		// them rather than the other way round.** See the note on that project.
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
		//
		// 🚨 **It runs AFTER `authed`, and the ordering is load-bearing in both directions.**
		// Its `beforeAll` RESETS the shared fixture — `db:gauntlet` deletes the fixture
		// creator's posts and Works and rebuilds them — so running beside `authed` pulls rows
		// out from under any spec holding one. `votes.authed.e2e.ts` is the one that holds
		// them, and its symptom is a thread that existed in `beforeAll` and reads "No comments
		// yet" by the assertion. ⚠️ The race is scheduling-dependent rather than reliable: it
		// surfaced when that spec was renamed and its alphabetical position moved, so it was
		// latent and winning by luck before that.
		//
		// ⚠️ **The dependency points this way and not the other, which was tried first.**
		// Making `authed` wait for `gauntlet` also removes the race and is wrong, because the
		// walk deliberately ratchets the viewer's state upward — it leaves them supporting,
		// purchased and following. The authed specs assume the floor `setup` established, and
		// the basket spec fails immediately on the leftovers. So: reset, then the specs that
		// need the floor, then the staircase that climbs away from it.
		//
		// ⚠️ **The cost is real and it is the right trade.** Serializing adds the two projects'
		// wall clocks instead of overlapping them. A suite that is fast and sometimes wrong
		// teaches people to re-run it until it is green, and that habit is what makes every
		// later failure ambiguous.
		{
			name: "gauntlet",
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/e2e/.auth/gauntlet-viewer.json",
			},
			testMatch: "**/user-gauntlet.e2e.ts",
			dependencies: ["setup", "authed"],
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
			command: `${REQUIRE_SESSION} && bun run build.ts && PORT=${PORT} API_PORT=${API_PORT} bun run serve.ts`,
			cwd: here,
			url: `http://localhost:${PORT}`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		// The admin app, built and served the same way and never reused, for the same reason. It is a
		// separate app on a separate origin, which is what its specs need to prove the admin session
		// holds up across origins the way it will on admin.anthers.org.
		{
			command: `${REQUIRE_SESSION} && bun run build.ts && PORT=${ADMIN_PORT} API_PORT=${API_PORT} bun run serve.ts`,
			cwd: adminDir,
			url: `http://localhost:${ADMIN_PORT}`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		// The real API + Postgres. The preview tells pages which port the API took (see
		// web-shared rpc.ts), so no proxy is involved — but the API and database must genuinely
		// be up, which is the deliberate cost of authenticated e2e. The session supplies the
		// database; in CI it is a service container and the job's environment carries it.
		//
		// NEVER reused either. A running `make dev` API is current code, but it is the dev
		// session's database, and a suite that seeds and resets fixtures must not reach it.
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
				: `${REQUIRE_SESSION} && bun --env-file=../../.env src/server.ts`,
			cwd: apiDir,
			url: `http://localhost:${API_PORT}/health`,
			/*
			 * 🚨 **The handle door is the session's real one.** Hosting reads four variables —
			 * the server, its invite, the key that seals credentials, and the domain the server
			 * says it issues under — and the browser session (or `scripts/ci-network.ts` in CI)
			 * supplies a real server for all of them, private to this run. So a spec that walks
			 * the door walks it against an identity server that answers, and the write guard in
			 * `lib/atproto-network.ts` refuses anything that is not local. Only the ports are set here.
			 */
			env: {
				PORT: String(API_PORT),
				// Where the OAuth callback sends the browser back to. CI has no session to name it, and
				// without it the API falls back to `make dev`'s 3000, where nothing is listening.
				PREVIEW_PORT: String(PORT),
				// Open, as it is in production (`.do/app.yaml`). Closed, a creator whose identity is held
				// elsewhere is never asked for the publishing permission and never refused without it, so
				// the suite would walk a publishing path production does not have.
				ATPROTO_PUBLISH_ENABLED: "true",
			},
			reuseExistingServer: false,
			timeout: 180_000,
		},
	],
});
