// SPDX-License-Identifier: Apache-2.0
//
// Codegen for @anthers/brand: normalize the CURATED source art into
// `src/generated/icons.ts` — recolor-ready markup that `iconSvg`/`iconGroup`/
// `iconDataUri` read. Run `bun run build`.
//
// The source art is `svg/` beside this script's package, and `icons.ts` is committed
// too, so the app builds without running this at all and a fork can re-run it with no
// access to anything. `--check` regenerates in memory and fails if the committed
// `icons.ts` no longer matches what `svg/` produces, which is how
// `scripts/noun/authoring-time.test.ts` keeps the two in step.
//
// Assets are single-color FILLED art (the Noun Project "SVG, black" default);
// normalize() strips baked fills so one injected color controls each icon.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "src", "generated");

/** One entry of the curated set, as `icons.json` carries it. */
export interface CuratedIcon {
	/** The friendly name code renders by. */
	id: string;
	/** The Noun Project icon id, which is what provenance is keyed on. */
	nounId: number;
	/** Path within `svg/`, whose filename also carries the id. */
	path: string;
	/** Why this particular asset, in Anthers' terms rather than the vendor's. */
	why?: string;
}

/** The source art for every curated icon. */
const SVG_ROOT = join(ROOT, "svg");
const check = process.argv.includes("--check");

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

// 🚨 The id in the filename is what ties an asset to its artist, so a mismatch here
// would record the wrong creator and license in provenance.json while everything
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
	// Carrying on would silently drop an icon the app renders by id.
	console.error(`[brand] ${missing.length} curated asset(s) missing from ${SVG_ROOT}:`);
	for (const m of missing) console.error(`          ${m.id} → ${m.path}`);
	process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const iconRows = CURATED.map((c) => {
	const { viewBox, inner } = normalize(readFileSync(join(SVG_ROOT, c.path), "utf8"), c.path);
	return `\t${JSON.stringify(c.id)}: { viewBox: ${JSON.stringify(viewBox)}, inner: ${JSON.stringify(inner)} },`;
}).join("\n");
// Stamped CC-BY-3.0 rather than with the repository's Apache-2.0, because every geometry
// in it is Noun Project art that Anthers uses under its own license and cannot relicense.
const generated = `// SPDX-License-Identifier: CC-BY-3.0
// AUTO-GENERATED by scripts/build-icons.ts — do not edit by hand.
// Curated, recolor-ready icon markup from The Noun Project; provenance.json records
// each icon's creator and license. Add an icon with \`bun run brand:add\`.
export type BrandIcon = { readonly viewBox: string; readonly inner: string };
export const icons = {
${iconRows}
} as const satisfies Record<string, BrandIcon>;
export type BrandIconName = keyof typeof icons;
`;

const target = join(OUT_DIR, "icons.ts");
if (check) {
	if (!existsSync(target) || readFileSync(target, "utf8") !== generated) {
		console.error(
			"[brand] src/generated/icons.ts is out of date with svg/ — run `bun run brand:build`",
		);
		process.exit(1);
	}
	console.log(`[brand] ${CURATED.length} curated icons, src/generated/icons.ts is up to date`);
} else {
	writeFileSync(target, generated);
	console.log(`[brand] ${CURATED.length} curated icons written to src/generated/icons.ts`);
}
