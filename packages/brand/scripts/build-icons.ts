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
// sibling PRIVATE repo alongside the layered design working files — private because
// most of it is licensed third-party art rather than Anthers'.
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

/** One entry of the curated set, as `icons.json` carries it. */
export interface CuratedIcon {
	/** The friendly name code renders by. */
	id: string;
	/** The Noun Project icon id, which is what makes provenance and attribution findable. */
	nounId: number;
	/** Path within the private library's `svg/`, whose filename also carries the id. */
	path: string;
	/** Why this particular asset, in Anthers' terms rather than the vendor's. */
	why?: string;
}

// The icon library is a PRIVATE repository — it mixes Anthers' own working files with
// ~650 licensed Noun Project SVGs, which is not ours to publish wholesale. So this hint
// names a path rather than a URL: an outside reader cannot fetch it and does not need to,
// since `icons.ts` is committed and the app builds identically without the source.
const SOURCE_HINT = "the Anthers icon library (private; set BRAND_SOURCE to a checkout)";
/** Where the icon library lives. A sibling checkout by default, per the repo naming convention. */
const SVG_ROOT = join(process.env.BRAND_SOURCE ?? join(REPO, "..", "Anthers-Brand"), "svg");

// ── Curated set: assets promoted for use in code, with friendly ids. The list is
// `icons.json` beside this package, so `brand:add` can append to it and the reason
// each asset was chosen survives as a field rather than as a comment a rewrite
// would eat. Add by hand or with the tool, then reference by id via
// iconSvg/iconGroup/iconDataUri. Paths are relative to svg/.
const CURATED: CuratedIcon[] = (
	JSON.parse(readFileSync(join(ROOT, "icons.json"), "utf8")) as { icons: CuratedIcon[] }
).icons;

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

// 🚨 The id in the filename is what ties an asset to its artist, so a mismatch here
// would attribute an icon to the wrong person in THIRD-PARTY.md while everything
// still rendered. Both numbers are written down precisely so they can disagree out
// loud: `nounId` is what provenance is keyed on, and the filename is what a person
// reads. Nothing downstream can catch this, because both values are plausible.
const mislabeled = CURATED.filter((c) => {
	const inName = /-(\d+)\.svg$/.exec(c.path)?.[1];
	return inName !== undefined && Number(inName) !== c.nounId;
});
if (mislabeled.length > 0) {
	console.error("[brand] curated entries whose nounId disagrees with their filename:");
	for (const m of mislabeled)
		console.error(`          ${m.id} → nounId ${m.nounId}, file ${m.path}`);
	process.exit(1);
}

const duplicates = ["id", "nounId"].flatMap((field) => {
	const seen = new Map<string, number>();
	for (const c of CURATED) {
		const k = String(c[field as "id" | "nounId"]);
		seen.set(k, (seen.get(k) ?? 0) + 1);
	}
	return [...seen].filter(([, n]) => n > 1).map(([k]) => `${field} ${k}`);
});
if (duplicates.length > 0) {
	console.error(`[brand] duplicate curated entries: ${duplicates.join(", ")}`);
	process.exit(1);
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
