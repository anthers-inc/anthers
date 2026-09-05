// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Take one icon from the Noun Project into the curated set, in a single step.
 *
 *     bun run brand:add 7595393 --as bloom-cluster --file ~/Downloads/noun-x.svg --why "…"
 *     bun run brand:add 7595393 --as bloom-cluster --dry-run   # metadata only, no download
 *     bun run brand:add --backfill        # provenance for curated icons that lack it
 *
 * ⭐ **This is the seven-step ritual collapsed into one command.** Adding an emblem
 * meant finding it on the site, downloading the SVG, dropping it in the private
 * library, adding an entry to the codegen, running the codegen against a checkout,
 * committing the regenerated markup, and hand-editing THIRD-PARTY.md. Exactly one of
 * those steps carries a licensing distinction; the other six were bookkeeping, and
 * bookkeeping is what makes iterating on a pick expensive enough that people settle
 * for the first thumbnail that looked right.
 *
 * 🚨 **Authoring time, never build time.** It writes files a person then commits.
 * `packages/brand` keeps committing its generated markup so a fork builds with no
 * key, no network and no private library — see authoring-time.test.ts, which fails
 * if this credential's name ever appears on the deploy path.
 *
 * ⚠️ **One icon call, for the metadata.** The file comes from `--file` and spends
 * nothing: the API terms forbid caching an SVG it hands over, so the subscription
 * supplies files and the API supplies search and metadata. `--backfill` costs one
 * per icon it fills.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { icon as fetchIcon, type NounIcon, reportSpend } from "./noun/client";
import {
	absolute,
	BRAND_DIR,
	curatedNote,
	type IconProvenance,
	LICENSES,
	PROVENANCE_NOTE,
	readCurated,
	readProvenance,
	readRegister,
	writeCurated,
	writeProvenance,
	writeRegister,
} from "./noun/provenance";

const REPO = join(import.meta.dir, "..");
/** Where the private icon library lives — a sibling checkout, per the repo naming convention. */
const SVG_ROOT = join(process.env.BRAND_SOURCE ?? join(REPO, "..", "Anthers-Brand"), "svg");

const VALUE_FLAGS = new Set(["as", "why", "group", "file"]);
const args = Bun.argv.slice(2);
const values = new Map<string, string>();
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i] as string;
	if (!a.startsWith("--")) words.push(a);
	else if (VALUE_FLAGS.has(a.slice(2))) values.set(a.slice(2), args[++i] ?? "");
	else values.set(a.slice(2), "");
}
const backfill = values.has("backfill");
const dryRun = values.has("dry-run");
const today = new Date().toISOString().slice(0, 10);

const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");

/** The provenance record an API response yields, with the shape the file is checked against. */
function toProvenance(raw: NounIcon): IconProvenance {
	const collection = raw.collections?.[0] as
		| { id?: number | string; name?: string; permalink?: string }
		| undefined;
	return {
		nounId: Number(raw.id),
		term: raw.term,
		license: raw.license_description ?? "",
		attribution: raw.attribution ?? "",
		permalink: raw.permalink ?? "",
		creator: {
			name: raw.creator?.name ?? "",
			username: raw.creator?.username,
			permalink: raw.creator?.permalink,
		},
		collection: collection
			? { id: Number(collection.id), name: collection.name, permalink: collection.permalink }
			: undefined,
		fetchedAt: today,
	};
}

async function regenerate() {
	const steps: { label: string; cmd: string[]; cwd: string }[] = [
		{ label: "icons.ts", cmd: ["bun", "run", "build"], cwd: BRAND_DIR },
		{
			label: "THIRD-PARTY.md",
			cmd: ["bun", "run", join(REPO, "scripts", "brand-attribution.ts")],
			cwd: REPO,
		},
	];
	for (const { label, cmd, cwd } of steps) {
		const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
		if ((await proc.exited) !== 0) throw new Error(`regenerating ${label} failed`);
	}
}

// ── Backfill ─────────────────────────────────────────────────────────────────

if (backfill) {
	const curated = readCurated();
	const provenance = readProvenance();
	const wanted = curated.filter((c) => !provenance.has(c.nounId));
	if (wanted.length === 0) {
		console.log("brand:add --backfill: every curated icon already has provenance.");
	} else {
		console.log(
			`fetching provenance for ${wanted.length} icon(s) — ${wanted.length} icon calls, about $${(wanted.length * 0.0095).toFixed(3)}\n`,
		);
		for (const c of wanted) {
			const { icon: raw } = await fetchIcon(c.nounId);
			const p = toProvenance(raw);
			provenance.set(p.nounId, p);
			const known = LICENSES[p.license] ? "" : "  ⚠️ UNRECOGNIZED LICENSE";
			console.log(
				`  ${c.id.padEnd(18)} ${String(p.nounId).padEnd(9)} ${p.license.padEnd(30)} ${p.creator.name}${known}`,
			);
		}
		writeProvenance(provenance, PROVENANCE_NOTE);
		console.log(`\n  wrote packages/brand/provenance.json`);
		await regenerate();
	}
	reportSpend();
	process.exit(0);
}

// ── Add one ──────────────────────────────────────────────────────────────────

const nounId = Number(words[0]);
const friendly = values.get("as");
if (!Number.isFinite(nounId) || nounId <= 0 || !friendly) {
	console.error(
		'brand:add: usage: bun run brand:add <icon-id> --as <friendly-id> [--why "…"]\n' +
			"                  --file <local.svg> [--group nature] [--dry-run]\n" +
			"                  bun run brand:add --backfill",
	);
	process.exit(2);
}

const curated = readCurated();
if (curated.some((c) => c.id === friendly)) {
	console.error(
		`brand:add: "${friendly}" is already a curated id — pick another or edit icons.json.`,
	);
	process.exit(1);
}
const already = curated.find((c) => c.nounId === nounId);
if (already) {
	console.error(`brand:add: noun ${nounId} is already curated as "${already.id}".`);
	process.exit(1);
}

const { icon: raw } = await fetchIcon(nounId);
const p = toProvenance(raw);

console.log(`  ${p.term} — ${p.creator.name}`);
console.log(`  ${absolute(p.permalink)}`);
console.log(
	`  license: ${p.license}${LICENSES[p.license] ? "" : "  ⚠️ NOT a license this repository redistributes under"}`,
);

// The collection directory mirrors the vendor's own slug so the library stays
// navigable by the same names the site uses. An icon that belongs to no collection
// is a real case rather than an error, and lands in `uncollected/`.
const slugDir = p.collection?.permalink
	? (/\/([^/]+)\/?$/.exec(p.collection.permalink.replace(/\/$/, ""))?.[1] ??
		`collection-${p.collection.id}`)
	: "uncollected";
const group = values.get("group") ?? "nature";

/**
 * Reuse a directory the library already has for this collection.
 *
 * ⚠️ **Some are hand-suffixed** — `animals-38481-(bees)` rather than `animals-38481` —
 * because a person named them for what they hold. Deriving the name from the slug alone
 * would file a second bee beside the first in a directory of its own, splitting a
 * collection in two with nothing to say why.
 */
function collectionDirIn(groupDir: string): string {
	const parent = join(SVG_ROOT, groupDir);
	if (!existsSync(parent)) return slugDir;
	const match = readdirSync(parent, { withFileTypes: true }).find(
		(e) => e.isDirectory() && (e.name === slugDir || e.name.startsWith(`${slugDir}-`)),
	);
	return match?.name ?? slugDir;
}
const collectionDir = collectionDirIn(group);
const relPath = join(group, collectionDir, `noun-${slug(p.term)}-${nounId}.svg`);
console.log(`  → ${join(SVG_ROOT, relPath)}`);

if (dryRun) {
	console.log("\n  --dry-run: nothing written, and the file was not downloaded.");
	reportSpend();
	process.exit(0);
}

if (!existsSync(SVG_ROOT)) {
	console.error(
		`\nbrand:add: the private icon library is not at ${SVG_ROOT}.\n` +
			"           Clone it beside this repository, or set BRAND_SOURCE to a checkout.\n" +
			"           Nothing was written; the metadata call has already been spent.",
	);
	process.exit(1);
}

/**
 * The icon's markup, which comes from disk and may never come from the API.
 *
 * 🚨 **The key-creation flow requires agreeing that the app will not cache SVG
 * files** (Parker, 2026-09-04), and writing an API-fetched SVG into the private
 * library is the clearest instance of that. So `--file` is not a fallback for a
 * download that is temporarily refused — **it is the only permitted route**, and
 * the API supplies search and metadata rather than files.
 *
 * ⭐ **A subscription is what makes the file side unambiguous.** NounPro exists
 * precisely so a subscriber may download and keep artwork, and every one of the 648
 * icons already in the library arrived that way. Hand-fetching one file from the
 * permalink is the single step that stays manual, and six of the seven still go.
 *
 * ⚠️ **This is a contract constraint and not a plan limitation, which matters
 * because the two look identical from here.** The endpoint does also refuse us
 * today — omitting `color` answers `400 Must provide a hexadecimal color value`
 * and supplying it answers `403 You are not authorized to edit this icon`, for SVG
 * and PNG alike — and an earlier version of this file read that as a catch-22 to
 * route around, noting that the download path would start working the day the plan
 * allowed it. **That is exactly the outcome to prevent**: a latent violation that
 * switches itself on when somebody upgrades a plan for unrelated reasons. The
 * runtime Badge Maker fetches, composes and discards within one request and never
 * writes a file; nothing at authoring time has that shape.
 */
function markup(): string | null {
	const local = values.get("file");
	return local ? readFileSync(local, "utf8") : null;
}

const svg = markup();

/**
 * No file yet: record what we want and where it goes, and hand back the link.
 *
 * ⭐ **This is the step the workflow was missing.** Somebody has to click download, so the
 * useful thing a tool can do is know *which* icons are outstanding, why each was chosen,
 * and where each one's file belongs — leaving a human with one job, opening a link.
 * `brand:wanted` prints the list; `brand:collect` files what comes back.
 *
 * The provenance is fetched now rather than later, so a wanted entry already carries its
 * artist, license and permalink and the register is complete before the art arrives.
 */
if (!svg) {
	const reg = readRegister();
	if (reg.wanted.some((w) => w.nounId === nounId)) {
		console.log("\n  Already on the wanted list.");
	} else {
		reg.wanted.push({
			id: friendly,
			nounId,
			path: relPath,
			...(values.get("why") ? { why: values.get("why") as string } : {}),
		});
		writeRegister(reg);
		const pending = readProvenance();
		pending.set(nounId, p);
		writeProvenance(pending, PROVENANCE_NOTE);
		console.log("\n  Added to the wanted list in packages/brand/icons.json.");
	}
	console.log(
		`\n  Download it as SVG, single color black:\n    ${absolute(p.permalink)}\n\n` +
			"  Then `bun run brand:collect` files everything waiting in ~/Downloads at once.\n" +
			"  The API supplies search and metadata; the subscription supplies files.",
	);
	reportSpend();
	process.exit(0);
}
if (!/<svg[\s>]/i.test(svg)) {
	console.error(`brand:add: what came back for ${nounId} is not SVG markup.`);
	process.exit(1);
}
mkdirSync(dirname(join(SVG_ROOT, relPath)), { recursive: true });
writeFileSync(join(SVG_ROOT, relPath), svg);
console.log(`  wrote ${relPath} (${svg.length} bytes) into the private library`);

curated.push({
	id: friendly,
	nounId,
	path: relPath,
	...(values.get("why") ? { why: values.get("why") as string } : {}),
});
writeCurated(curated, curatedNote());
console.log("  registered in packages/brand/icons.json");

const provenance = readProvenance();
provenance.set(nounId, p);
writeProvenance(provenance, PROVENANCE_NOTE);
console.log("  recorded in packages/brand/provenance.json");

await regenerate();
console.log(`\n  \`${friendly}\` is ready to use: iconSvg("${friendly}")`);
reportSpend();
