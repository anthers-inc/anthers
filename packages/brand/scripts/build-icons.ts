// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codegen for @anthers/brand: normalize the CURATED source art into
// `src/generated/icons.ts` — recolor-ready markup that `iconSvg`/`iconGroup`/
// `iconDataUri` read. Run `bun run build`.
//
// 🚨 THE SOURCE ART IS NOT IN THIS REPOSITORY, and that is deliberate. The icon
// library is ~650 Noun Project SVGs — 14 MiB, of which this file promotes 18 —
// and it lived here until 2026-08-14, when it was 91% of everything tracked. A
// platform's repository should not be, by weight, an icon mirror. It moved to a
// sibling repo (see SOURCE_HINT) alongside the layered design working files.
//
// **This costs the app nothing**, which is the whole reason the split is cheap:
// `icons.ts` inlines each icon's viewBox and path markup, `src/` never reads the
// source tree, and nothing imports the raw SVGs. The app builds identically with
// the library absent. What you lose without it is only the ability to RE-RUN this
// codegen — so it degrades with a pointer rather than failing, the same way
// `econ:figures` skips its wiki blocks when the vault isn't present.
//
// Point it elsewhere with `BRAND_SOURCE=/path/to/checkout bun run build`.
//
// Assets are single-color FILLED art (the Noun Project "SVG, black" default);
// normalize() strips baked fills so one injected color controls each icon.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO = join(ROOT, "..", "..");
const OUT_DIR = join(ROOT, "src", "generated");

const SOURCE_HINT = "https://github.com/anthers-inc/Anthers-Brand";
/** Where the icon library lives. A sibling checkout by default, per the repo naming convention. */
const SVG_ROOT = join(process.env.BRAND_SOURCE ?? join(REPO, "..", "Anthers-Brand"), "svg");

// ── Curated set: assets promoted for use in code, with friendly ids. Add here,
// then reference by id via iconSvg/iconGroup/iconDataUri. Paths are relative to svg/.
const CURATED: { id: string; path: string }[] = [
	{ id: "bee", path: "nature/animals-38481-(bees)/noun-bee-1248042.svg" },
	{ id: "bee-flying", path: "nature/animals-38481-(bees)/noun-bee-1248044.svg" },
	{ id: "grass-band", path: "nature/grass-289179/noun-grass-8183011.svg" },
	{ id: "grass-tall", path: "nature/grass-289179/noun-grass-8183007.svg" },
	{ id: "grass-clump", path: "nature/grass-289179/noun-grass-8183013.svg" },
	{ id: "grass-cattail", path: "nature/grass-289179/noun-grass-8183001.svg" },
	{ id: "grass-reed", path: "nature/grass-289179/noun-grass-8183009.svg" },
	{
		id: "divider-botanical",
		path: "nature/botanical-borders-and-frames-228479/noun-botanical-border-7282328.svg",
	},
	// Solid single blooms scattered along the hand-drawn side vines for life. Chosen
	// as bloom-dominant (minimal stem) shapes that stay legible at ~small size.
	{ id: "bloom-cluster", path: "nature/wildflowers-solid-271979/noun-wildflower-7595393.svg" },
	{ id: "bloom-round", path: "nature/wildflowers-solid-271979/noun-wildflower-7762479.svg" },
	{ id: "bloom-tulip", path: "nature/wildflowers-solid-271979/noun-wildflower-7595473.svg" },
	{
		id: "wreath",
		path: "nature/botanical-borders-and-frames-228479/noun-botanical-circle-frame-7366648.svg",
	},
	// The single round botanical frame used behind every Anthers Badge on the
	// marketing site (one consistent wreath for all Badges, per Parker's call).
	{
		id: "frame-round",
		path: "nature/botanical-borders-and-frames-228479/noun-botanical-round-frame-7366626.svg",
	},
	// One wreath per Anthers Badge — sparse → full to echo growing support.
	{
		id: "wreath-root",
		path: "nature/botanical-borders-and-frames-228479/noun-botanical-circle-border-7366645.svg",
	},
	{
		id: "wreath-sprout",
		path: "nature/botanical-borders-and-frames-228479/noun-leafy-wreath-6832659.svg",
	},
	{
		id: "wreath-petal",
		path: "nature/botanical-borders-and-frames-228479/noun-floral-wreath-6832663.svg",
	},
	{
		id: "wreath-blossom",
		path: "nature/botanical-borders-and-frames-228479/noun-leafy-circle-border-7366620.svg",
	},
	// An L-shaped trailing-leaf corner flourish. Placed at all four corners (rotated)
	// to frame the auth (login/signup) card — adapts to any card aspect without
	// distortion. (An arch-frame was tried first but its tall crown clips behind the
	// header on the vertically-centered auth card, so corners it is.)
	{
		id: "corner-leafy",
		path: "nature/botanical-borders-and-frames-228479/noun-corner-leafy-frame-7366617.svg",
	},
];

function normalize(raw: string, file: string): { viewBox: string; inner: string } {
	const s = raw
		.replace(/<\?xml[\s\S]*?\?>/g, "")
		.replace(/<!DOCTYPE[\s\S]*?>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const open = s.match(/<svg\b[^>]*>/i);
	if (!open) throw new Error(`${file}: no <svg> element`);
	const openTag = open[0];
	let viewBox = openTag.match(/viewBox\s*=\s*"([^"]+)"/i)?.[1]?.trim() ?? "";
	if (!viewBox) {
		const w = openTag.match(/\bwidth\s*=\s*"([\d.]+)/i)?.[1];
		const h = openTag.match(/\bheight\s*=\s*"([\d.]+)/i)?.[1];
		if (w && h) viewBox = `0 0 ${w} ${h}`;
	}
	if (!viewBox) throw new Error(`${file}: no viewBox and no width/height to derive one`);
	let inner = s.slice(s.indexOf(openTag) + openTag.length, s.lastIndexOf("</svg>"));
	inner = inner
		.replace(/<title[\s\S]*?<\/title>/gi, "")
		.replace(/<desc[\s\S]*?<\/desc>/gi, "")
		.replace(/<metadata[\s\S]*?<\/metadata>/gi, "")
		.replace(/\sfill\s*=\s*"([^"]*)"/gi, (m, v) => (v.trim().toLowerCase() === "none" ? m : ""))
		.replace(/fill\s*:\s*[^;"'}]+;?/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	return { viewBox, inner };
}

// The generated file is committed, so a checkout without the source art is a
// perfectly working state — say so plainly rather than failing a build over it.
if (!existsSync(SVG_ROOT)) {
	console.log(
		`[brand] icon source not found at ${SVG_ROOT}\n` +
			`        Nothing to regenerate — src/generated/icons.ts is committed and complete,\n` +
			`        and the app builds without the source library.\n` +
			`        To curate a new icon, clone ${SOURCE_HINT} beside this repo\n` +
			`        (or set BRAND_SOURCE=/path/to/checkout) and run this again.`,
	);
	process.exit(0);
}

const missing = CURATED.filter((c) => !existsSync(join(SVG_ROOT, c.path)));
if (missing.length > 0) {
	// A source tree that exists but lacks a curated file is a real error, unlike an
	// absent one: it means the library and this list have diverged, and carrying on
	// would silently drop an icon the app renders by id.
	console.error(`[brand] ${missing.length} curated asset(s) missing from ${SVG_ROOT}:`);
	for (const m of missing) console.error(`          ${m.id} → ${m.path}`);
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const iconRows = CURATED.map((c) => {
	const { viewBox, inner } = normalize(readFileSync(join(SVG_ROOT, c.path), "utf8"), c.path);
	return `\t${JSON.stringify(c.id)}: { viewBox: ${JSON.stringify(viewBox)}, inner: ${JSON.stringify(inner)} },`;
}).join("\n");
writeFileSync(
	join(OUT_DIR, "icons.ts"),
	`// SPDX-License-Identifier: AGPL-3.0-or-later
// AUTO-GENERATED by scripts/build-icons.ts — do not edit by hand.
// Curated, recolor-ready icon markup. Add entries to CURATED in the codegen, then
// \`bun run build\` with the icon source checked out. (Artwork is third-party and
// attributed — see THIRD-PARTY.md.)
export type BrandIcon = { readonly viewBox: string; readonly inner: string };
export const icons = {
${iconRows}
} as const satisfies Record<string, BrandIcon>;
export type BrandIconName = keyof typeof icons;
`,
);

console.log(`[brand] ${CURATED.length} curated icons written to src/generated/icons.ts`);
