// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Codegen for @anthers/brand. Two outputs from svg/**:
//
//   src/generated/manifest.ts  — lightweight metadata for EVERY asset (id, path,
//                                collection, viewBox). The searchable "index";
//                                never imported by apps, so it costs no bundle.
//   src/generated/icons.ts     — normalized, recolor-ready markup for the CURATED
//                                subset actually used in code (see CURATED below).
//                                This is what iconSvg/iconGroup/iconDataUri read.
//
// It also (re)writes ASSETS.md — the human/agent-facing catalog. Run `bun run build`.
//
// Assets are single-color FILLED art (the Noun Project "SVG, black" default);
// normalize() strips baked fills so one injected color controls each icon.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SVG_ROOT = join(ROOT, "svg");
const OUT_DIR = join(ROOT, "src", "generated");

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
	// marketing site (one consistent wreath for all ranks, per Parker's call).
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
];

// Short, human descriptions per collection folder for ASSETS.md.
const DESCRIPTIONS: Record<string, string> = {
	"nature/animals-38481-(bees)":
		"Bees — top-view, angled, and flying (with dotted trails) + two bee-on-flower pollination scenes.",
	"nature/botanical-borders-and-frames-228479":
		"The big one: horizontal leaf/laurel dividers, L-corner frames, circular wreaths, arch/oval/hexagon/diamond frames, split borders (gap for text), vines & flourishes.",
	"nature/floral-borders-242604":
		"Delicate flower-on-a-baseline sprigs — poppies/wildflowers rising from a line. Ideal section dividers & accents.",
	"nature/flower-and-foliage-167008":
		"Large single-flower & foliage library (line + solid). General-purpose blooms and leaves.",
	"nature/grass-289179":
		"Grass tufts, reeds, cattails, and bushes — outline and solid. For meadow floors and ground accents.",
	"nature/wildflowers-outline-271978": "Single wildflowers, outline style.",
	"nature/wildflowers-solid-271979": "Single wildflowers, solid style (plus a rose).",
};

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

/** All .svg under svg/, as {relPath, collection}. */
function walk(dir: string): { relPath: string; collection: string }[] {
	const out: { relPath: string; collection: string }[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(full));
		else if (e.name.toLowerCase().endsWith(".svg")) {
			const relPath = relative(SVG_ROOT, full);
			out.push({ relPath, collection: relative(SVG_ROOT, dir) });
		}
	}
	return out;
}

mkdirSync(OUT_DIR, { recursive: true });

// ── manifest.ts (all assets, metadata only) ──
const all = walk(SVG_ROOT).sort((a, b) => a.relPath.localeCompare(b.relPath));
const manifestRows = all.map((a) => {
	const { viewBox } = normalize(readFileSync(join(SVG_ROOT, a.relPath), "utf8"), a.relPath);
	return {
		id: a.relPath.replace(/\.svg$/i, ""),
		path: a.relPath,
		collection: a.collection,
		viewBox,
	};
});
writeFileSync(
	join(OUT_DIR, "manifest.ts"),
	`// SPDX-License-Identifier: AGPL-3.0-or-later
// AUTO-GENERATED by scripts/build-icons.ts — do not edit. Metadata for every asset
// in svg/ (no markup). For discovery/tooling only; not imported by apps.
export type BrandAsset = { id: string; path: string; collection: string; viewBox: string };
export const manifest: BrandAsset[] = ${JSON.stringify(manifestRows, null, "\t")};
`,
);

// ── icons.ts (curated, with markup) ──
const iconRows = CURATED.map((c) => {
	const { viewBox, inner } = normalize(readFileSync(join(SVG_ROOT, c.path), "utf8"), c.path);
	return `\t${JSON.stringify(c.id)}: { viewBox: ${JSON.stringify(viewBox)}, inner: ${JSON.stringify(inner)} },`;
}).join("\n");
writeFileSync(
	join(OUT_DIR, "icons.ts"),
	`// SPDX-License-Identifier: AGPL-3.0-or-later
// AUTO-GENERATED by scripts/build-icons.ts — do not edit by hand.
// Curated, recolor-ready icon markup. Add entries to CURATED in the codegen, then
// \`bun run build\`. (Artwork may be third-party; see THIRD-PARTY.md.)
export type BrandIcon = { readonly viewBox: string; readonly inner: string };
export const icons = {
${iconRows}
} as const satisfies Record<string, BrandIcon>;
export type BrandIconName = keyof typeof icons;
`,
);

// ── ASSETS.md (catalog / guide) ──
const byCollection = new Map<string, number>();
for (const a of all) byCollection.set(a.collection, (byCollection.get(a.collection) ?? 0) + 1);
const collectionRows = [...byCollection.entries()]
	.sort()
	.map(([c, n]) => {
		const previewName = `${c.replace(/[^\w-]+/g, "_")}.png`;
		return `| \`${c}\` | ${n} | ${DESCRIPTIONS[c] ?? "—"} | [preview](preview/${previewName}) |`;
	})
	.join("\n");
const curatedRows = CURATED.map((c) => `| \`${c.id}\` | \`${c.path}\` |`).join("\n");
writeFileSync(
	join(ROOT, "ASSETS.md"),
	`<!-- AUTO-GENERATED by scripts/build-icons.ts. Edit the codegen (descriptions / CURATED), not this file. -->
# Brand asset catalog

${all.length} source SVGs live in \`svg/\`, all viewBox \`0 0 100 100\`, single-color, recolor-ready. This is the map; to actually *see* the art, open the per-collection contact sheets in [\`preview/\`](preview/) (regenerate with \`bun run preview\`). Filenames are Noun Project \`noun-<type>-<id>\` — not individually descriptive, so browse visually.

## Collections

| Collection (\`svg/…\`) | Count | What's in it | Visual |
|---|---|---|---|
${collectionRows}

## How to find & use

- **Find:** open the collection's contact sheet in \`preview/\`, note the \`noun-…-<id>\` under the one you want. Or grep \`src/generated/manifest.ts\`.
- **Promote for code use:** add \`{ id, path }\` to \`CURATED\` in \`scripts/build-icons.ts\`, then \`bun run build\`. It becomes available by \`id\`.
- **Recolor + render (standalone):** \`iconDataUri(id)\` as a CSS \`mask-image\` on an element with \`background-color: currentColor\` (color follows \`text-*\`).
- **Recolor + compose (into a generated SVG, e.g. a tiled background):** splice \`iconGroup(id, { x, y, size, color, rotate?, anchor? })\`.

## Curated (baked into \`icons.ts\`, usable by id)

| id | source |
|---|---|
${curatedRows}
`,
);

console.log(
	`[brand] manifest: ${all.length} assets · icons: ${CURATED.length} curated · ASSETS.md + preview links written`,
);
