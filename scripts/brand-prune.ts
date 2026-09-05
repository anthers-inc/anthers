// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Remove art from the private library that nothing in the product uses.
 *
 *     bun run brand:prune            # dry run — lists what would go
 *     bun run brand:prune --apply    # delete it
 *
 * ⭐ **A local pool of maybes earned its keep when picking an icon meant browsing a
 * folder.** It does not now: `brand:search` chooses against nearly ten million icons and
 * `brand:wanted` plus `brand:collect` make pulling one more a link and a command. What is
 * left is a repository that is mostly third-party art nobody renders, which is exactly
 * what the library was moved out of the platform repo to stop being.
 *
 * 🚨 **Refuses to delete from a dirty checkout**, because the whole safety of this is that
 * git can put it back. A prune run over uncommitted work is not revertible in the way the
 * word suggests, and 600 files is not a mistake anybody wants to reconstruct by hand.
 *
 * ⚠️ **Keeps everything the register names, including entries whose file has not arrived
 * yet.** A wanted icon has no file to delete, but naming it here means a later prune
 * cannot remove one that lands in between.
 */

import { existsSync, readdirSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative } from "node:path";
import { readRegister } from "./noun/provenance";

const REPO = join(import.meta.dir, "..");
const LIBRARY = process.env.BRAND_SOURCE ?? join(REPO, "..", "Anthers-Brand");
const SVG_ROOT = join(LIBRARY, "svg");

const apply = Bun.argv.includes("--apply");

if (!existsSync(SVG_ROOT)) {
	console.error(`brand:prune: the private icon library is not at ${SVG_ROOT}.`);
	process.exit(1);
}

const reg = readRegister();
const keep = new Set([...reg.icons, ...reg.wanted].map((i) => i.path));

function svgsUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...svgsUnder(full));
		else if (name.toLowerCase().endsWith(".svg")) out.push(full);
	}
	return out;
}

const all = svgsUnder(SVG_ROOT);
const doomed = all.filter((f) => !keep.has(relative(SVG_ROOT, f)));
const kept = all.length - doomed.length;

// 🚨 Every kept path must actually be one of ours. A register entry whose file is absent
// is fine (it is wanted); a KEPT file that matches nothing would mean the filter is wrong,
// and the failure mode of a wrong filter here is deleting art that is in use.
const keptPaths = new Set(all.map((f) => relative(SVG_ROOT, f)).filter((p) => keep.has(p)));
const registerMissing = [...keep].filter((p) => !keptPaths.has(p));

console.log(`library: ${all.length} SVGs, ${kept} in the register, ${doomed.length} unused`);
if (registerMissing.length > 0) {
	console.log(`\n  ${registerMissing.length} register entr(ies) have no file yet (wanted):`);
	for (const p of registerMissing) console.log(`    ${p}`);
}

const byCollection = new Map<string, number>();
for (const f of doomed) {
	const c = relative(SVG_ROOT, f).split("/").slice(0, -1).join("/");
	byCollection.set(c, (byCollection.get(c) ?? 0) + 1);
}
console.log("\nwould remove:");
for (const [c, n] of [...byCollection].sort()) console.log(`  ${String(n).padStart(4)}  ${c}`);

if (!apply) {
	console.log(`\n  Dry run. ${doomed.length} file(s) would go. Re-run with --apply to delete.`);
	process.exit(0);
}

const dirty = Bun.spawnSync(["git", "-C", LIBRARY, "status", "--porcelain"]);
if (dirty.stdout.toString().trim().length > 0) {
	console.error(
		"\nbrand:prune: the icon library has uncommitted changes, so this is refused.\n" +
			"  Commit or stash them first — being able to `git restore` is the whole safety here.",
	);
	process.exit(1);
}

for (const f of doomed) unlinkSync(f);

// A collection folder with nothing left in it is noise; remove it, deepest first.
const dirs = new Set(doomed.map((f) => join(f, "..")));
for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
	try {
		if (readdirSync(d).length === 0) rmdirSync(d);
	} catch {
		// Left in place: something else is in it, which is a reason to keep it.
	}
}

console.log(
	`\n  removed ${doomed.length} file(s), kept ${kept}.\n` +
		"  Next: `bun run catalog` in the library to rebuild manifest.json and ASSETS.md,\n" +
		"  then `bun run brand:build` here to confirm the generated markup is unchanged.",
);
