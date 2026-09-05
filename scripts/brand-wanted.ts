// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the product is waiting on: every chosen icon whose file is not here yet.
 *
 *     bun run brand:wanted           # the list, with a link per icon
 *     bun run brand:wanted --links   # just the URLs, one per line
 *
 * ⭐ **This is the whole of the human job.** The API will not hand over a file — it
 * answers `403 You are not authorized to edit this icon` — and the term accepted at key
 * creation says the app will not cache SVGs it fetches anyway. So files come down through
 * the NounPro subscription, and the only thing a person has to do is open these links and
 * save each one. `brand:collect` does everything after that.
 *
 * ⚠️ **Needs no API key.** Everything printed was fetched when the icon was chosen and
 * lives in `provenance.json`, so this works offline and in a checkout with no credentials.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { absolute, readProvenance, readRegister, SITE } from "./noun/provenance";

const REPO = join(import.meta.dir, "..");
const SVG_ROOT = join(process.env.BRAND_SOURCE ?? join(REPO, "..", "Anthers-Brand"), "svg");

const linksOnly = Bun.argv.includes("--links");
const reg = readRegister();
const provenance = readProvenance();

/**
 * ⚠️ **Two ways to be outstanding, and both belong here.** An entry on the `wanted` list
 * has never had a file. A *curated* entry whose file has gone missing is a different and
 * worse problem — the codegen fails on it — but from a person's point of view it is the
 * same job, so it is listed rather than left to surface as a build error.
 */
const missingCurated = reg.icons.filter((i) => !existsSync(join(SVG_ROOT, i.path)));
const outstanding = [...reg.wanted, ...missingCurated];

if (outstanding.length === 0) {
	console.log(
		`brand:wanted: nothing outstanding — all ${reg.icons.length} curated icons are here.`,
	);
	process.exit(0);
}

if (linksOnly) {
	for (const item of outstanding) {
		console.log(absolute(provenance.get(item.nounId)?.permalink) || SITE);
	}
	process.exit(0);
}

console.log(
	`${outstanding.length} icon(s) waiting on a file. Download each as SVG, single color black,\n` +
		"into ~/Downloads (any filename), then run `bun run brand:collect`.\n",
);

for (const item of outstanding) {
	const p = provenance.get(item.nounId);
	const flag = missingCurated.includes(item) ? "  ⚠️ IN USE, FILE MISSING" : "";
	console.log(`  ${item.id}${flag}`);
	console.log(`    ${p?.term ?? "?"} — ${p?.creator.name ?? "?"}`);
	console.log(`    ${absolute(p?.permalink)}`);
	if (item.why) console.log(`    why: ${item.why}`);
	console.log(`    → ${item.path}`);
	console.log();
}
