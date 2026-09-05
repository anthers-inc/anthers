// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Provenance for the icons this repository redistributes: who drew each one, under
// what license, and where the original lives.
//
// ⭐ **This is what stops the attribution table being typed.** It was hand-maintained
// and carried a per-pick caution — check the licensing line for each icon you take —
// in three separate task bodies, which is a check that gets skipped rather than one
// that fails. Every field here comes off the API response that delivered the art, so
// the check becomes an assertion the codegen makes and a person cannot forget.
//
// 🚨 **Reads and writes committed data only, and imports nothing that talks to the
// network.** `brand:attribution --check` runs in CI, which has no key and no private
// library, and it has to be able to.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BRAND_DIR = join(import.meta.dir, "..", "..", "packages", "brand");
const PROVENANCE_PATH = join(BRAND_DIR, "provenance.json");
const ICONS_PATH = join(BRAND_DIR, "icons.json");

export const SITE = "https://thenounproject.com";

/** One curated entry, as `icons.json` carries it. Mirrors `CuratedIcon` in the codegen. */
export interface CuratedIcon {
	id: string;
	nounId: number;
	path: string;
	why?: string;
}

export interface Person {
	name: string;
	username?: string;
	/** Site-relative, as the API returns it. */
	permalink?: string;
}

export interface IconProvenance {
	nounId: number;
	term: string;
	/** The vendor's own license key, unmodified. Classified by {@link LICENSES}. */
	license: string;
	/** The vendor's ready-made credit line. */
	attribution: string;
	/** Site-relative, as the API returns it. */
	permalink: string;
	creator: Person;
	collection?: { id: number; name?: string; permalink?: string };
	/** The date this record was read from the API, as `YYYY-MM-DD`. */
	fetchedAt: string;
}

/**
 * The licenses Anthers may redistribute under, keyed by the vendor's own string.
 *
 * 🚨 **Unknown means fail, never means allow.** An icon whose `license_description`
 * is not in this table stops the build rather than passing quietly, because the one
 * failure mode that matters here is redistributing art under terms nobody read. Adding
 * a key is a deliberate act: read what the license actually permits first.
 *
 * ⚠️ **Anthers attributes even where it has bought the right not to.** The Royalty-Free
 * license waives CC BY's attribution condition, and that waiver is a contract Anthers is
 * party to and a forker is not — so the credit is what makes this art usable by the
 * people the repository hands it to. See THIRD-PARTY.md.
 */
export const LICENSES: Record<string, { label: string; url: string | null }> = {
	"creative-commons-attribution": {
		label: "CC BY 3.0",
		url: "https://creativecommons.org/licenses/by/3.0/",
	},
	"public-domain": { label: "Public Domain", url: null },
};

/**
 * The register: what the product uses, and what it is waiting on.
 *
 * ⭐ **`wanted` is the half that makes this a workflow rather than a record.** The API
 * will not hand over a file, so somebody has to click download — and the step that used
 * to be missing was any way to say *"this icon, for this reason"* before the file
 * existed. An entry lands in `wanted` with its provenance already fetched, which turns
 * the human job into opening a link, and `brand:collect` promotes it into `icons` when
 * the file arrives.
 *
 * ⚠️ **The codegen reads `icons` only.** A wanted entry has no file, and `build-icons.ts`
 * treats a curated path with no file as a hard error — correctly, because that means the
 * library and the register have diverged. Keeping the two lists apart is what stops a
 * thing we have merely asked for from looking like a thing that has gone missing.
 */
export interface Register {
	note: string;
	icons: CuratedIcon[];
	wanted: CuratedIcon[];
}

export function readRegister(): Register {
	const parsed = JSON.parse(readFileSync(ICONS_PATH, "utf8")) as Partial<Register>;
	if (!Array.isArray(parsed.icons)) throw new Error("icons.json: no `icons` array");
	return { note: parsed.note ?? "", icons: parsed.icons, wanted: parsed.wanted ?? [] };
}

export function writeRegister(reg: Register): void {
	// `wanted` is omitted when empty so the common state of the file stays uncluttered.
	const body = reg.wanted.length > 0 ? reg : { note: reg.note, icons: reg.icons };
	writeFileSync(ICONS_PATH, `${JSON.stringify(body, null, "\t")}\n`);
}

export function readCurated(): CuratedIcon[] {
	return readRegister().icons;
}

export function writeCurated(icons: CuratedIcon[], note: string): void {
	writeRegister({ ...readRegister(), note, icons });
}

export function curatedNote(): string {
	return readRegister().note;
}

export function readProvenance(): Map<number, IconProvenance> {
	let raw: string;
	try {
		raw = readFileSync(PROVENANCE_PATH, "utf8");
	} catch {
		return new Map();
	}
	const parsed = JSON.parse(raw) as { icons?: Record<string, IconProvenance> };
	return new Map(Object.values(parsed.icons ?? {}).map((p) => [p.nounId, p]));
}

export function writeProvenance(records: Map<number, IconProvenance>, note: string): void {
	// Sorted by id so a re-fetch of one icon produces a one-record diff rather than a
	// reshuffle nobody can read.
	const icons = Object.fromEntries(
		[...records.values()].sort((a, b) => a.nounId - b.nounId).map((p) => [String(p.nounId), p]),
	);
	writeFileSync(PROVENANCE_PATH, `${JSON.stringify({ note, icons }, null, "\t")}\n`);
}

export const PROVENANCE_NOTE =
	"Who drew each icon this repository redistributes, under what license, and where the " +
	"original lives. GENERATED by `bun run brand:add` from the Noun Project API — do not edit " +
	"by hand. `bun run brand:attribution --check` fails if an entry is missing, if a license " +
	"is not one this repository may redistribute under, or if THIRD-PARTY.md has drifted from it.";

/** An absolute URL from a site-relative permalink, which is the only form the API returns. */
export const absolute = (permalink: string | undefined): string =>
	permalink ? `${SITE}${permalink}` : SITE;

/**
 * Every reason this curated set may not be redistributed, as a list of sentences.
 *
 * 🚨 **Fails closed on an unrecognized license.** The one outcome worth engineering
 * against is redistributing art under terms nobody read, and the way that happens is
 * a new license string arriving from the vendor and being treated as fine because the
 * code only knew how to recognize a *bad* one. So the test is membership of
 * {@link LICENSES}, and anything else is a failure that names the decision a person
 * has to make.
 *
 * A separate function from the command that prints it so the fail-closed behavior can
 * be tested against a license string that does not exist, which is the case no fixture
 * of real data can cover.
 */
export function auditCurated(
	curated: CuratedIcon[],
	provenance: Map<number, IconProvenance>,
): { failures: string[]; rows: { id: string; p: IconProvenance }[] } {
	const failures: string[] = [];
	const rows: { id: string; p: IconProvenance }[] = [];
	for (const icon of curated) {
		const p = provenance.get(icon.nounId);
		if (!p) {
			failures.push(
				`${icon.id} (noun ${icon.nounId}) has no provenance — run \`bun run brand:add --backfill\``,
			);
			continue;
		}
		if (!LICENSES[p.license]) {
			failures.push(
				`${icon.id} (noun ${icon.nounId}) is licensed "${p.license}", which is not a license ` +
					"this repository redistributes under. Read what it permits, then add it to LICENSES " +
					"in scripts/noun/provenance.ts — or drop the icon.",
			);
			continue;
		}
		if (!p.creator?.name) {
			failures.push(`${icon.id} (noun ${icon.nounId}) has no creator name to attribute`);
			continue;
		}
		if (!p.permalink) {
			failures.push(`${icon.id} (noun ${icon.nounId}) has no permalink back to the original`);
			continue;
		}
		rows.push({ id: icon.id, p });
	}
	return { failures, rows };
}
