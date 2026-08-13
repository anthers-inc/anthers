// SPDX-License-Identifier: AGPL-3.0-or-later

// Screenshot / smoke helper for the web app (Tier 0 browser verification).
// Boots the production preview (serve.ts against ./dist), seeds the SiteGate
// localStorage flag so pages render past the pre-launch "Team access" wall,
// screenshots each route, and flags real JS errors — separating them from the
// expected no-backend API noise (there's no API in the static preview).
//
//   make screenshots                         # default route list
//   make screenshots ROUTES="/ /resources"   # custom routes
//   bun run scripts/screenshot.ts /resources/video-storage
//
// Output PNGs land in apps/web/.screenshots/ (gitignored). Exit code is
// non-zero if any route had a real page/console error.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const WEB_ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${WEB_ROOT}/.screenshots`;
const PORT = Number(process.env.SHOT_PORT ?? 4177);
const BASE = `http://localhost:${PORT}`;

const DEFAULT_ROUTES = [
	"/resources",
	"/resources/video-storage",
	"/resources/creator-monetization",
];

const args = process.argv.slice(2);
const routes = args.length ? args : DEFAULT_ROUTES;

const slug = (route: string) => route.replace(/^\/+|\/+$/g, "").replace(/\//g, "-") || "home";

async function waitForServer(url: string, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(url)).ok) return;
		} catch {}
		await Bun.sleep(250);
	}
	throw new Error(`preview server never came up at ${url}`);
}

// Ensure a build exists (make screenshots builds first; this covers direct runs).
if (!existsSync(`${WEB_ROOT}/dist/index.html`)) {
	console.log("No build found — running build.ts...");
	const build = Bun.spawn(["bun", "run", "build.ts"], {
		cwd: WEB_ROOT,
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await build.exited) !== 0) throw new Error("build failed");
}

await mkdir(OUT_DIR, { recursive: true });

const server = Bun.spawn(["bun", "run", "serve.ts"], {
	cwd: WEB_ROOT,
	env: { ...process.env, PORT: String(PORT) },
	stdout: "ignore",
	stderr: "inherit",
});

let failures = 0;
try {
	await waitForServer(BASE);
	const browser = await chromium.launch({ args: ["--no-sandbox"] });
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 900 },
		deviceScaleFactor: 2,
	});
	// SiteGate is a client-side wall keyed on this localStorage flag — seed it
	// before any app script runs so we land on the real app, not the gate.
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem("anthers_site_access", "true");
		} catch {}
	});

	for (const route of routes) {
		const page = await ctx.newPage();
		const pageErrors: string[] = [];
		const consoleErrors: string[] = [];
		page.on("pageerror", (e) => pageErrors.push(String(e)));
		page.on("console", (m) => {
			if (m.type() === "error") consoleErrors.push(m.text());
		});
		await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
		await page.waitForTimeout(300);
		const out = `${OUT_DIR}/${slug(route)}.png`;
		await page.screenshot({ path: out, fullPage: true });
		// Ignore the expected no-backend failures (there's no API in the preview).
		const real = consoleErrors.filter((e) => !/\/api\/|auth\/me|Failed to load resource/i.test(e));
		// An empty #root is a real failure that emits NO error, so error-watching alone
		// gives false confidence — the same trap as an HTTP-200 check. It is how a build
		// whose HTML pointed at the wrong chunk served a blank page with a clean console
		// and HTTP 200 throughout (2026-08-11). Every route mounts something.
		const mounted = await page.evaluate(
			() => (document.getElementById("root")?.innerHTML.length ?? 0) > 0,
		);
		const ok = pageErrors.length === 0 && real.length === 0 && mounted;
		if (!ok) failures++;
		console.log(`[${ok ? "ok" : "FAIL"}] ${route} -> ${out}`);
		if (!mounted) console.log("    blank: #root is empty — the app did not mount");
		for (const e of pageErrors) console.log(`    pageerror: ${e}`);
		for (const e of real) console.log(`    console: ${e}`);
		await page.close();
	}
	await browser.close();
} finally {
	server.kill();
}

console.log(
	failures ? `\n${failures} route(s) had real errors.` : `\nAll ${routes.length} route(s) clean.`,
);
process.exit(failures ? 1 : 0);
