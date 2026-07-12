// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Generates a visual contact sheet (one PNG per collection) for the brand SVG
// library — because the Noun Project `noun-<type>-<id>` filenames aren't
// individually descriptive, you need to *see* the art to choose. Recolors each
// asset to brand green on cream, captions it with its id, and screenshots a grid
// via headless Chromium. Output: preview/<collection>.png. Run: `bun run preview`.

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const SVG_ROOT = join(ROOT, "svg");
const OUT = join(ROOT, "preview");
mkdirSync(OUT, { recursive: true });

/** Every directory that directly contains .svg files, as a path relative to svg/. */
function collections(dir: string, rel = ""): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const out: string[] = [];
	if (entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith(".svg")))
		out.push(rel || ".");
	for (const e of entries) {
		if (e.isDirectory())
			out.push(...collections(join(dir, e.name), rel ? `${rel}/${e.name}` : e.name));
	}
	return out;
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx.newPage();

for (const col of collections(SVG_ROOT)) {
	const dir = join(SVG_ROOT, col);
	const files = readdirSync(dir)
		.filter((f) => f.toLowerCase().endsWith(".svg"))
		.sort();
	const cells = files
		.map((f) => {
			const svg = readFileSync(join(dir, f), "utf8")
				.replace(/<\?xml[\s\S]*?\?>/g, "")
				.replace(/<!--[\s\S]*?-->/g, "");
			return `<figure><div class="art">${svg}</div><figcaption>${basename(f, ".svg")}</figcaption></figure>`;
		})
		.join("");
	const html = `<!doctype html><meta charset="utf8"><style>
		body{margin:0;background:#f2efe4;font:11px system-ui;color:#33473b;padding:18px}
		h1{font:600 15px system-ui;margin:0 0 14px}
		.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:10px}
		figure{margin:0;text-align:center;background:#fff;border:1px solid #dcdccf;border-radius:8px;padding:8px 4px}
		.art{height:70px;display:flex;align-items:center;justify-content:center}
		.art svg{width:60px;height:60px}
		.art svg,.art svg *{fill:#2f5d3a}
		figcaption{margin-top:6px;font-size:8.5px;color:#82897f;word-break:break-all;line-height:1.3}
		</style><h1>${col} — ${files.length} assets</h1><div class="grid">${cells}</div>`;
	await page.setContent(html, { waitUntil: "networkidle" });
	const safe = col.replace(/[^\w-]+/g, "_");
	await page.screenshot({ path: join(OUT, `${safe}.png`), fullPage: true });
	console.log(`[preview] ${col} → preview/${safe}.png (${files.length})`);
}

await browser.close();
