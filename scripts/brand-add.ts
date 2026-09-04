// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Take one icon from the Noun Project into the curated set, in a single step.
 *
 *     bun run brand:add 7595393 --as bloom-cluster --why "reads at small size"
 *     bun run brand:add 7595393 --as bloom-cluster --file ~/Downloads/noun-x.svg
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
 * ⚠️ **One icon call for the metadata, plus one for the file if the API will hand it
 * over** — at $0.0095 each. It will not on the current plan, so pass the SVG with
 * `--file` and the add costs one. `--backfill` costs one per icon it fills.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { downloadSvg, icon as fetchIcon, type NounIcon, reportSpend } from "./noun/client";
import {
	absolute,
	BRAND_DIR,
	curatedNote,
	type IconProvenance,
	LICENSES,
	PROVENANCE_NOTE,
	readCurated,
	readProvenance,
	writeCurated,
	writeProvenance,
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
			"                  [--file <local.svg>] [--group nature] [--dry-run]\n" +
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
 * The icon's markup, from disk if `--file` named one and from the API otherwise.
 *
 * 🚨 **The `download` endpoint is refused on the current plan, so `--file` is the
 * working path today.** It is a catch-22 rather than a wrong parameter: omitting
 * `color` answers `400 Must provide a hexadecimal color value`, and supplying it
 * answers `403 You are not authorized to edit this icon` — for SVG and PNG alike,
 * and for an icon whose file the library already holds. Everything else here works,
 * so the fallback is to fetch the one file by hand from the permalink above, under
 * the NounPro subscription, and hand it to `--file`. That still automates six of the
 * seven steps, and the download path starts working the day the plan allows it
 * without anything here changing.
 */
async function markup(): Promise<string> {
	const local = values.get("file");
	if (local) return readFileSync(local, "utf8");
	try {
		return await downloadSvg(nounId);
	} catch (err) {
		console.error(
			`\nbrand:add: the API would not hand over the file — ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n\n` +
				`  Download it yourself from ${absolute(p.permalink)} as SVG, single color black,\n` +
				"  then re-run with the file:\n\n" +
				`    bun run brand:add ${nounId} --as ${friendly} --file <path-to-downloaded.svg>\n\n` +
				"  Nothing was written. The metadata call has already been spent, and --file spends none.",
		);
		process.exit(1);
	}
}

const svg = await markup();
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
