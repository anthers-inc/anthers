// SPDX-License-Identifier: AGPL-3.0-or-later

// Mobile horizontal-overflow detector. Boots the production preview (serve.ts
// against ./dist), seeds the SiteGate flag, then for each route loads the page at
// a narrow mobile viewport and walks the DOM for any element whose right edge
// extends past the viewport's right edge (i.e. contributes to horizontal
// scroll). Reports each offender's tag, class, computed width, and how far past
// the viewport it pokes — so the fix can be targeted at the actual breakout.
//
//   bun run scripts/mobile-overflow.ts                  # default routes at 390px
//   bun run scripts/mobile-overflow.ts / /for-creators # custom routes
//   MOB_WIDTH=360 bun run scripts/mobile-overflow.ts   # custom width
//
// Exits non-zero if any route overflows.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

const WEB_ROOT = `${import.meta.dir}/..`;
const OUT_DIR = `${WEB_ROOT}/.screenshots`;
const PORT = Number(process.env.SHOT_PORT ?? 4178);
const BASE = `http://localhost:${PORT}`;
const WIDTH = Number(process.env.MOB_WIDTH ?? 390);

const DEFAULT_ROUTES = [
	"/",
	"/for-creators",
	"/about",
	"/compare/itch-io",
	"/compare/ghost",
	"/demo-creator-page",
	"/demo-creator-breakdown",
	"/demo-infrastructure",
	"/demo-user",
	"/resources",
	"/resources/pay-comparison",
	"/resources/video-storage",
	"/resources/creator-monetization",
	"/subscribe",
	"/faq",
	"/roadmap",
	"/jams",
	"/login",
	"/signup",
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
		viewport: { width: WIDTH, height: 844 },
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true,
	});
	await ctx.addInitScript(() => {
		try {
			localStorage.setItem("anthers_site_access", "true");
		} catch {}
	});

	for (const route of routes) {
		const page = await ctx.newPage();
		await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
		await page.waitForTimeout(300);

		// With isMobile:true, Playwright scales the layout viewport to fit the
		// document, so window.innerWidth reports the SCALED width, not the 390 we
		// asked for. Treat the requested WIDTH as the source of truth and measure
		// overflow against it. The clientWidth of <html> is the layout viewport
		// width (the CSS px the page actually has to lay out in); scrollWidth is
		// how wide the content wants to be. overflow > 0 means content forces the
		// page wider than the device.
		const report = await page.evaluate(() => {
			const docWidth = document.documentElement.scrollWidth;
			const vw = window.innerWidth;
			const clientWidth = document.documentElement.clientWidth;
			return { docWidth, vw, clientWidth };
		});

		const overflow = report.docWidth - WIDTH;
		const ok = overflow <= 0;
		if (!ok) failures++;

		// Re-query offenders against the requested WIDTH so the rect math is
		// consistent (getBoundingClientRect runs in the SCALED viewport under
		// isMobile, but the relative overflow is what we care about).
		let deduped: {
			tag: string;
			id: string;
			className: string;
			width: number;
			right: number;
			overBy: number;
		}[] = [];
		if (!ok) {
			const offenders = await page.evaluate((targetVw: number) => {
				const out: {
					tag: string;
					id: string;
					className: string;
					width: number;
					right: number;
					overBy: number;
					computed: {
						display: string;
						maxWidth: string;
						width: string;
						overflow: string;
						position: string;
					};
					parentClass: string;
				}[] = [];
				const all = document.querySelectorAll("*");
				for (const el of all) {
					const rect = (el as HTMLElement).getBoundingClientRect();
					const overBy = rect.right - targetVw;
					if (overBy > 1) {
						const cs = window.getComputedStyle(el);
						out.push({
							tag: el.tagName.toLowerCase(),
							id: (el as HTMLElement).id || "",
							className:
								typeof (el as HTMLElement).className === "string"
									? (el as HTMLElement).className.split(/\s+/).slice(0, 8).join(" ")
									: "",
							width: Math.round(rect.width),
							right: Math.round(rect.right),
							overBy: Math.round(overBy),
							computed: {
								display: cs.display,
								maxWidth: cs.maxWidth,
								width: cs.width,
								overflow: cs.overflow,
								position: cs.position,
							},
							parentClass:
								el.parentElement && typeof (el.parentElement as HTMLElement).className === "string"
									? (el.parentElement as HTMLElement).className.split(/\s+/).slice(0, 8).join(" ")
									: "",
						});
					}
				}
				return out;
			}, WIDTH);
			const seen = new Set<string>();
			deduped = offenders
				.filter((o) => {
					const key = `${o.tag}|${o.className}|${o.width}`;
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				})
				.sort((a, b) => b.overBy - a.overBy)
				.slice(0, 8);
		}

		console.log(
			`[${ok ? "ok" : "OVER"}] ${route}  docWidth=${report.docWidth} clientWidth=${report.clientWidth} requestedVw=${WIDTH} overflow=${overflow}`,
		);
		if (!ok && deduped.length) {
			for (const o of deduped) {
				console.log(
					`    +${o.overBy}px  <${o.tag}${o.id ? `#${o.id}` : ""}> w=${o.width}  .${o.className}`,
				);
				console.log(
					`        display=${o.computed.display} width=${o.computed.width} maxW=${o.computed.maxWidth} overflow=${o.computed.overflow} pos=${o.computed.position}`,
				);
				console.log(`        parent: .${o.parentClass}`);
			}
			const out = `${OUT_DIR}/mobile-${slug(route)}.png`;
			await page.screenshot({ path: out, fullPage: true });
			console.log(`    screenshot -> ${out}`);
		}
		await page.close();
	}
	await browser.close();
} finally {
	server.kill();
}

console.log(
	failures
		? `\n${failures} route(s) overflowed at width ${WIDTH}.`
		: `\nAll ${routes.length} route(s) fit at width ${WIDTH}.`,
);
process.exit(failures ? 1 : 0);
