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
	// 🚨 **CI's `expect` window is the slow container's honest one, not the fast dev box's.**
	// The 5s default was written for an idle, fast machine. CI's `browser-media` job is one
	// runner carrying Chromium, the built SPA, the API, Postgres, Mailpit, the ATProto
	// network and the media fixtures' ffmpeg — and it runs the suite 3–4x slower than an
	// idle dev box (8m39s on 2026-10-14's #502 merge group against ~2.5 minutes local).
	// Traces from that day's failures show healthy expects resolving in single-digit
	// milliseconds and the failing ones sitting at exactly 5000ms — the assert never got
	// the chance to see its element, so the window was the defect, not the code. 15s
	// keeps every assertion that would ever resolve at idle latency honest while giving
	// the slow runner the time it actually needs. (Retries above stay on for the
	// crash-recovery class that `ci-api-supervisor.sh`'s restart leaves mid-flight; this
	// knob covers the class below both — one failing run that day had no crash at all.)
	expect: {
		timeout: process.env.CI ? 15_000 : 5_000,
	},
	// 🚨 **Local runs cap at a handful of workers, not half the machine.** Playwright's
	// default is cores/2, which was written for one person on an idle box. This machine
	// runs several agent sessions at once — each with its own browsers and, since the
	// pre-push hook verifies every push, its own full-suite runs — and at cores/2 the
	// suite's timeout-adjacent assertions flake in rotating sets under the contention.
	// A busy box must degrade into a slower run, never a false-red gate: the gate's
	// redness is the signal every push trusts, so it has to mean the code is red. CI
	// stays at 1 worker; it pays for certainty in wall-clock on a quiet runner.
	// E2E_WORKERS overrides when a deliberately quiet machine wants the speed back.
	workers: process.env.CI ? 1 : Number(process.env.E2E_WORKERS ?? 4),
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
		// Seeds instance A of the gauntlet fixture and signs its user in (writes the
		// storageState the authed project runs under). *.setup.ts so `bun test` never
		// claims it either — EXCEPT the walk's own setup, which belongs to `setup-walk`
		// alone: two projects matching the same file would run it twice, and the two
		// instances' fixtures must be seeded by their own owners.
		{
			name: "setup",
			testMatch: "**/*.setup.ts",
			testIgnore: "**/gauntlet-walk.setup.ts",
			metadata: { needsMedia: true },
		},
		// The same job for the walk's OWN fixture instance: seeds instance B
		// (`walk-creator` / `walk-walker` / `walk-gauntlet-*` — see
		// `packages/db/src/gauntlet-walk.ts`) and signs the walk user in, writing the
		// storageState the gauntlet project runs under. No dependencies — it is itself a
		// setup project, and it must not wait on (nor be waited on by) instance A's chain.
		{
			name: "setup-walk",
			testMatch: "**/gauntlet-walk.setup.ts",
			metadata: { needsMedia: true },
		},
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
		// signed in as the fixture user. Separate from `gauntlet` on purpose — that one is
		// a single stateful staircase where order is the point, and dropping unrelated tests
		// into it would make its ratchet assertions depend on what else ran.
		//
		// These run on instance A of the gauntlet fixture (`setup` seeds it and leaves it
		// at the floor). The gauntlet walk seeds and resets its OWN instance since the two
		// fixtures are disjoint — see the note on that project — so no ordering between the
		// two projects is required, and none is declared.
		{
			name: "authed",
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/e2e/.auth/gauntlet-walker.json",
			},
			testMatch: "**/*.authed.e2e.ts",
			dependencies: ["setup"],
			metadata: { needsMedia: true },
		},
		// The User Gauntlet walk: authenticated (storageState from setup-walk), strictly serial —
		// it is one stateful staircase, not a bag of independent tests.
		//
		// The walk owns instance B of the fixture: the `walk-creator` / `walk-walker`
		// accounts and the `walk-gauntlet-*` slugs defined in
		// `packages/db/src/gauntlet-walk.ts`. Its
		// `beforeAll` resets instance B (`db:gauntlet --instance walk`) and ratchets only
		// instance B's user — and instance A's specs and resets never touch a
		// `walk-gauntlet-` row, because A's own helpers scope every delete on the `gauntlet-`
		// prefix and the walk creator's id. With the row sets disjoint, the two projects run
		// independently and in any order: `--project=gauntlet` alone, `--project=authed`
		// alone, and the two together in one invocation are each a complete, correct suite.
		//
		// (The staircase itself — `EXPECTED_STAIRCASE`, `BADGE_RUNGS`, `DOWNLOAD_PRICE` —
		// is still SHARED between the instances, imported from `@anthers/db/gauntlet` by
		// the walk. Only the fixture's rows fork; the published access table must not.)
		{
			name: "gauntlet",
			use: {
				...devices["Desktop Chrome"],
				storageState: "tests/e2e/.auth/gauntlet-walk-walker.json",
			},
			testMatch: "**/user-gauntlet.e2e.ts",
			dependencies: ["setup-walk"],
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
			// In CI the API runs under `ci-api-supervisor.sh`, because Bun sometimes
			// segfaults it, and Bun's crash handling makes an unsupervised death cost
			// minutes rather than the seconds a restart should take.
			//
			// Observed 2026-08-08 on Bun 1.3.9 — the version pinned specifically to dodge the
			// 1.3.14 crash — as `panic(main thread): Segmentation fault at address 0x0`, and
			// the decoded report puts it in `uWS::HttpContext<false>::init()` off a socket
			// closure. That is inside Bun's own HTTP server; nothing in this repo can prevent
			// it, and it does not reproduce locally.
			//
			// What it cost is out of all proportion to how often it happens — and 2026-10-14
			// made the shape exact: four failed `browser-media` jobs in one day (two merge
			// groups ejecting #498 and #502, two head runs of #499 and #501), every
			// implicated spec green in local isolation. The failed runs' logs carried the
			// mechanism: the panic prints, its crash handler then **hangs ~81 seconds while
			// the process stays alive** (`Illegal instruction (core dumped)` is when the
			// kernel finally reaps it), and every spec whose requests cross that window
			// fails on whatever assertion sits next — a `toBeVisible` that never renders, a
			// sign-in lock deadline, tests against a corpse after it — while `retries: 2`
			// re-runs pass against the supervisor-restarted server. The failing-spec list
			// rotates because the crash time maps to whichever tests are in flight.
			//
			// The supervisor (its docblock is the full reasoning) restarts on death and
			// SIGKILLs a child that goes silent while alive, cutting the dead window to
			// seconds, and logs every act to stderr — the stream these captured logs do
			// show. The budget is bounded so a genuinely un-startable API still fails fast.
			// `process.env.CI` is the same switch the workers/retries knobs use: the
			// supervisor is CI's shape, a session's direct command is the local one.
			command: process.env.CI
				? "../../scripts/ci-api-supervisor.sh"
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
