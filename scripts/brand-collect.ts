// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * File every downloaded SVG into the library at once, and regenerate.
 *
 *     bun run brand:collect                 # sweep ~/Downloads
 *     bun run brand:collect ~/Desktop       # sweep somewhere else
 *     bun run brand:collect --keep          # copy instead of moving
 *
 * ⭐ **Matches on the Noun Project id anywhere in the filename, so nothing needs renaming.**
 * The id is what ties a file to the artist it must be credited to, and it is the only part
 * of a download's name worth trusting — the term is neither unique nor stable, and the
 * punctuation around it is not ours to predict.
 *
 * ⚠️ **Do not narrow this to a naming scheme.** It matched `noun-<term>-<id>.svg` at first,
 * from the shape of the files already in the library — which are named the way *we* file
 * them, not the way they arrive. A real download is `noun_Butterfly_3662383.svg`, and the
 * mismatch presented as the tool quietly finding nothing.
 *
 * ⚠️ **Needs no API key.** Provenance was fetched when the icon was chosen. This moves
 * files, promotes them out of the wanted list, and re-runs the two generators.
 */

import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	BRAND_DIR,
	type CuratedIcon,
	readProvenance,
	readRegister,
	writeRegister,
} from "./noun/provenance";

const REPO = join(import.meta.dir, "..");
const SVG_ROOT = join(process.env.BRAND_SOURCE ?? join(REPO, "..", "Anthers-Brand"), "svg");

const args = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
const keep = Bun.argv.includes("--keep");
const from = args[0] ?? join(process.env.HOME ?? "", "Downloads");

if (!existsSync(SVG_ROOT)) {
	console.error(`brand:collect: the private icon library is not at ${SVG_ROOT}.`);
	process.exit(1);
}
if (!existsSync(from)) {
	console.error(`brand:collect: nothing at ${from}.`);
	process.exit(1);
}

const reg = readRegister();
const provenance = readProvenance();

/** Everything still waiting on a file, by Noun Project id. */
const outstanding = new Map<number, CuratedIcon>();
for (const w of reg.wanted) outstanding.set(w.nounId, w);
for (const i of reg.icons) if (!existsSync(join(SVG_ROOT, i.path))) outstanding.set(i.nounId, i);

if (outstanding.size === 0) {
	console.log("brand:collect: nothing is waiting on a file.");
	process.exit(0);
}

const collected: { icon: CuratedIcon; source: string }[] = [];
const unmatched: string[] = [];
const seen = new Set<number>();
for (const name of readdirSync(from)) {
	if (!name.toLowerCase().endsWith(".svg")) continue;
	// Every run of four or more digits is a candidate id. Four is the floor because a
	// shorter run is far more likely to be a size, a date or a version than an icon.
	const candidates = [...name.matchAll(/\d{4,}/g)]
		.map((m) => Number(m[0]))
		.filter((n) => outstanding.has(n));
	const unique = [...new Set(candidates)];
	if (unique.length > 1) {
		// Two ids we are waiting on, in one filename. Guessing would credit the wrong artist.
		console.error(`  skipped ${name} — names more than one wanted icon (${unique.join(", ")})`);
		continue;
	}
	const id = unique[0];
	const want = id === undefined ? undefined : outstanding.get(id);
	// ⚠️ A directory of downloads is somebody's whole desktop, not a delivery. Anything
	// that is not an SVG naming an icon we are actually waiting on is left alone.
	if (!want || id === undefined) {
		unmatched.push(name);
		continue;
	}
	if (seen.has(id)) continue;
	const source = join(from, name);
	if (!statSync(source).isFile()) continue;
	const svg = readFileSync(source, "utf8");
	if (!/<svg[\s>]/i.test(svg)) {
		console.error(`  skipped ${name} — not SVG markup`);
		continue;
	}
	seen.add(id);
	collected.push({ icon: want, source });
}

if (collected.length === 0) {
	// 🚨 Names what it looked at. "Found nothing" with no list is indistinguishable from
	// "looked in the wrong place", and that ambiguity is what made the first wrong matcher
	// cost somebody a round trip instead of being obvious from the output.
	console.log(`brand:collect: nothing in ${from} matches the ${outstanding.size} icon(s) waiting.`);
	if (unmatched.length > 0) {
		console.log(`\n  ${unmatched.length} SVG(s) there named no wanted icon id:`);
		for (const n of unmatched.slice(0, 12)) console.log(`    ${n}`);
	}
	console.log("\n  `bun run brand:wanted` lists what is outstanding, with the id of each.");
	process.exit(0);
}

for (const { icon, source } of collected) {
	const dest = join(SVG_ROOT, icon.path);
	mkdirSync(dirname(dest), { recursive: true });
	if (keep) {
		copyFileSync(source, dest);
	} else {
		// Across filesystems `rename` fails, so fall back to copy-then-remove rather than
		// leaving the file un-collected for a reason nobody would guess from the message.
		try {
			renameSync(source, dest);
		} catch {
			copyFileSync(source, dest);
			unlinkSync(source);
		}
	}
	const p = provenance.get(icon.nounId);
	console.log(`  ${icon.id.padEnd(26)} ${p?.creator.name ?? "?"}  →  ${icon.path}`);
}

// Promote everything that arrived out of `wanted` and into the curated set.
const arrived = new Set(collected.map((c) => c.icon.nounId));
writeRegister({
	...reg,
	icons: [...reg.icons, ...reg.wanted.filter((w) => arrived.has(w.nounId))],
	wanted: reg.wanted.filter((w) => !arrived.has(w.nounId)),
});

for (const [label, cmd, cwd] of [
	["icons.ts", ["bun", "run", "build"], BRAND_DIR],
	["THIRD-PARTY.md", ["bun", "run", join(REPO, "scripts", "brand-attribution.ts")], REPO],
] as const) {
	const proc = Bun.spawn([...cmd], { cwd, stdout: "inherit", stderr: "inherit" });
	if ((await proc.exited) !== 0) throw new Error(`regenerating ${label} failed`);
}

const left = readRegister().wanted.length;
console.log(
	`\n  collected ${collected.length}${left > 0 ? `, ${left} still waiting — bun run brand:wanted` : ", nothing left waiting"}`,
);
