// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Two checks before the browser suite runs, both for failures that look identical and
 * have nothing to do with the code.
 *
 * 🚨 **A wall of tests failing in two milliseconds is never a real failure.** It is the
 * harness never starting, and Playwright reports it as 162 assertion failures rather than
 * one environment problem. Both of the causes below cost a debugging cycle on 2026-09-04:
 * an absent browser build, and another project's dev server answering on the API's port.
 * Neither says what it is from the test output.
 *
 * ⚠️ **This is a preflight, not a fixer.** It refuses and names the command that helps,
 * because guessing — installing a browser, killing somebody's server — is exactly what a
 * script should not do to a developer's machine.
 */

import { chromium } from "@playwright/test";

const API_PORT = Number(process.env.API_PORT ?? 8000);
const API = `http://localhost:${API_PORT}`;

const problems: string[] = [];

// ── 1. The browser Playwright actually drives ────────────────────────────────
//
// Checked by launching it rather than by looking for a path: `chromium` and the headless
// shell are separate binaries, the suite uses whichever the config implies, and only a
// launch settles which one is missing. It costs about a second.
try {
	const browser = await chromium.launch({ args: ["--no-sandbox"] });
	await browser.close();
} catch (err) {
	const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
	problems.push(
		`Playwright cannot launch its browser.\n` +
			`      ${detail}\n\n` +
			"      Fix:  make e2e-install\n\n" +
			"      Why this happens: browsers are keyed by BUILD number, and this repo pins a\n" +
			"      Playwright version that wants a specific one. Another project installing a\n" +
			"      different Playwright prunes builds its own version does not reference — so\n" +
			"      installing browsers over there deletes them over here. `make` runs this\n" +
			"      suite with PLAYWRIGHT_BROWSERS_PATH=0, which keeps them in node_modules\n" +
			"      where nothing else can reach them; running `bunx playwright test` by hand\n" +
			"      without it looks in the shared cache instead.",
	);
}

// ── 2. Whoever is answering on the API port is us ────────────────────────────
//
// 🚨 `reuseExistingServer` is on locally and deliberately: an API run from source cannot
// go stale, so reusing a running `make dev` is free. What it does not check is WHOSE server
// it found. Playwright's own readiness probe is satisfied by any response at all, so
// another project's dev server on this port is accepted and then 404s every request.
async function reachable(path: string): Promise<Response | null> {
	try {
		return await fetch(`${API}${path}`, { signal: AbortSignal.timeout(2500) });
	} catch {
		return null;
	}
}

const health = await reachable("/health");
if (health !== null) {
	// Something is there. Two questions: does it answer /health as we do, and does it carry
	// our routes? A 404 on a route that exists is the tell — a foreign server has no idea
	// what /api/auth/sign-in is, while ours refuses a bodyless POST with a 4xx that is not 404.
	const body = (await health.json().catch(() => null)) as { status?: string } | null;
	const signIn = await reachable("/api/auth/sign-in");
	const looksLikeUs =
		health.ok && body?.status === "ok" && signIn !== null && signIn.status !== 404;
	if (!looksLikeUs) {
		problems.push(
			`Something is listening on port ${API_PORT}, and it is not the Anthers API.\n` +
				`      /health → ${health.status}${body?.status ? ` {"status":"${body.status}"}` : ""}` +
				`, /api/auth/sign-in → ${signIn ? signIn.status : "unreachable"}\n\n` +
				`      Fix:  stop whatever is on ${API_PORT}, then re-run.\n` +
				`            lsof -ti :${API_PORT} | xargs -r ps -o pid,cmd -p\n\n` +
				"      The suite reuses an API already running on this port, which is right for a\n" +
				"      `make dev` and wrong for another project's server. Every request would 404\n" +
				"      and the failure would surface as every test failing instantly.",
		);
	}
}

if (problems.length > 0) {
	console.error("\ne2e-preflight — the suite will not run:\n");
	for (const p of problems) console.error(`  ✗ ${p}\n`);
	process.exit(1);
}
console.log("e2e-preflight: browser launches, and the API port is ours or free ✓");
