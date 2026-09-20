// SPDX-License-Identifier: Apache-2.0
/**
 * A check before the browser suite runs, for a failure that has nothing to do with the code.
 *
 * 🚨 **A wall of tests failing in two milliseconds is never a real failure.** It is the
 * harness never starting, and Playwright reports it as 162 assertion failures rather than
 * one environment problem. An absent browser build cost a debugging cycle on 2026-09-04,
 * and nothing in the test output says that is what it is.
 *
 * The API port needs no check any more: each run starts its own API on a free port inside its
 * own session (`scripts/session.ts`), so nothing else can be answering there.
 *
 * ⚠️ **This is a preflight, not a fixer.** It refuses and names the command that helps,
 * because guessing — installing a browser — is exactly what a script should not do to a
 * developer's machine.
 */

import { chromium } from "@playwright/test";

const problems: string[] = [];

// ── The browser Playwright actually drives ───────────────────────────────────
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
			"      suite with PLAYWRIGHT_BROWSERS_PATH pointed at a shared Anthers-owned\n" +
			"      directory (~/.cache/ms-playwright-anthers), which every worktree of this\n" +
			"      repository uses and nothing else can reach; running `bunx playwright test`\n" +
			"      by hand without it looks in the machine-wide cache instead.",
	);
}

if (problems.length > 0) {
	console.error("\ne2e-preflight — the suite will not run:\n");
	for (const p of problems) console.error(`  ✗ ${p}\n`);
	process.exit(1);
}
console.log("e2e-preflight: browser launches ✓");
