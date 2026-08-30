// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * British spellings may not come back.
 *
 * House style is American English, settled 2026-08-24. The vault was swept the same day —
 * 744 spellings across 158 files — and this repository was swept on 2026-08-29, 354 more.
 * **Nothing failed while either was wrong**, which is why a third sweep was always going to
 * be needed and why this file exists instead.
 *
 * ⚠️ **This is a tripwire, not a dictionary, and the difference is the point.** The
 * canonical word list lives in the vault at `01.00 Automation/lint_spelling.py` and is far
 * larger than this — every `-ise` stem, every `-our` stem, the doubled-consonant rules. A
 * second copy of that list in this repository would drift from the first within a month,
 * and a rule that disagrees with itself in two places is worse than one place with a gap.
 * So this carries only **the forms that have actually appeared here**, which is what a
 * regression guard is for: it cannot catch a British spelling nobody has ever typed, and
 * `lint_spelling.py --ext md,ts,tsx,css` is still the tool for a real sweep.
 *
 * ⚠️ **This file declares `lint-spelling: ignore-file`**, because its subject IS the
 * vocabulary: a guard that lists the British forms it watches for cannot avoid spelling
 * them, and without the declaration the vault's own sweep reports seventy offenses here and
 * buries every real one. `scripts/retired-vocabulary-guard.test.ts` earns its exemption the
 * same way.
 *
 * ⭐ **Two escape hatches, both of which say why at the site.** A line carrying
 * `lint-spelling: ignore` is skipped, for a spelling that belongs to an external vocabulary
 * this code has to match exactly — pg-boss's `cancelled` job state, GitHub Actions'
 * `cancelled()`. And a proper noun is a name rather than a spelling: the Canadian Centre for
 * Child Protection is called that whatever house style says, including where prose
 * introduces it once and then writes "the Centre".
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

/**
 * The British forms actually found in this repository, and nothing speculative.
 *
 * Adding a word here is cheap and correct when one turns up. Adding every word the vault
 * knows is what this file is deliberately not doing.
 */
const BRITISH = [
	"cancelled",
	"cancelling",
	"catalogue",
	"catalogued",
	"cataloguing",
	"behaviour",
	"behavioural",
	"colour",
	"colours",
	"coloured",
	"subsidise",
	"subsidised",
	"subsidises",
	"enrol",
	"enrols",
	"enrolment",
	"amortise",
	"amortises",
	"recognise",
	"recognises",
	"recognised",
	"modelled",
	"labelled",
	"licence",
	"licences",
	"harbour",
	"artefact",
	"artefacts",
	"honour",
	"honours",
	"honoured",
	"honouring",
	"acknowledgement",
	"acknowledgements",
	// 🚨 These were LIVE on /privacy after the sweep that was meant to remove them, because
	// neither stem was in the vault's word list — and this guard was built from the tally of
	// what that sweep found, so it inherited the same blind spot by construction. A tripwire
	// derived from a sweep can only ever be as complete as the sweep was.
	"anonymise",
	"anonymised",
	"anonymises",
	"anonymising",
	"anonymisation",
	"unrecognised",
	"programme",
	"programmes",
	"itemise",
	"itemised",
	"centred",
	"centre",
	"defence",
	"organise",
	"organised",
	"organisation",
	"prioritise",
	"prioritised",
	"analyse",
	"analysed",
	"optimise",
	"optimised",
	"judgement",
	"whilst",
	"amongst",
	"grey",
	"fulfil",
	"fulfilment",
	"instalment",
	"specialise",
	"specialised",
	"summarise",
	"summarised",
	"standardise",
	"standardised",
	"normalise",
	"normalised",
	"initialise",
	"initialised",
	"serialise",
	"serialised",
	"utilise",
	"utilised",
	"visualise",
	"visualised",
] as const;

const WORD_RX = new RegExp(`\\b(${BRITISH.join("|")})\\b`, "gi");

/** A line that names its own exemption. */
const IGNORE_MARKER = /lint-spelling:\s*ignore/;

/**
 * Names, which are spelled the way their owner spells them.
 *
 * The bare `Centre` is capitalized mid-sentence and is therefore a name — prose introduces
 * the organization once and then refers to "the Centre", and rewriting the short form
 * leaves a document that names the Canadian Centre for Child Protection and then talks
 * about the Center. Our own lowercase "centre the column" is still caught.
 */
const PROPER_NOUNS = [/Canadian Centre for Child Protection/gi, /\bCentre\b/g];

const ROOTS = ["apps/api/src", "apps/web/src", "apps/web/tests", "packages", "scripts"] as const;
const EXTENSIONS = "**/*.{ts,tsx,css,md}";
const SELF = "american-spelling-guard.test.ts";

/** Blank out every span a name occupies, so a word inside one cannot match. */
function withoutNames(line: string): string {
	let out = line;
	for (const rx of PROPER_NOUNS) out = out.replace(rx, (m) => " ".repeat(m.length));
	return out;
}

async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const root of ROOTS) {
		for await (const rel of new Bun.Glob(EXTENSIONS).scan({ cwd: root })) {
			if (rel.includes("node_modules/") || rel.endsWith(SELF)) continue;
			found.push(join(root, rel));
		}
	}
	return found;
}

async function offenses(): Promise<string[]> {
	const hits: string[] = [];
	for (const file of await sourceFiles()) {
		(await Bun.file(file).text()).split("\n").forEach((line, i) => {
			if (IGNORE_MARKER.test(line)) return;
			for (const m of withoutNames(line).matchAll(WORD_RX)) {
				hits.push(`${file}:${i + 1} — ${m[0]}`);
			}
		});
	}
	return hits;
}

describe("American spelling", () => {
	it("scans a plausible number of files, so a broken glob cannot pass silently", async () => {
		expect((await sourceFiles()).length).toBeGreaterThan(200);
	});

	it("🚨 finds no British spelling anywhere in the repository", async () => {
		expect(
			await offenses(),
			"House style is American English. If this spelling belongs to somebody else — a pg-boss job state, a GitHub Actions function, a quoted document — put `lint-spelling: ignore` on the line and say whose it is. Otherwise fix it. A full sweep is `lint_spelling.sh <repo> --ext md,ts,tsx,css` from the vault's automation directory.",
		).toEqual([]);
	});

	it("⭐ still catches a British spelling when it sees one, so the matcher cannot rot", async () => {
		// A guard whose regex has stopped matching reports a clean repository forever, which
		// looks exactly like success. Asserted against a string rather than a file so it
		// cannot be satisfied by the very drift it is watching for.
		expect("we prioritised the colour of the catalogue".match(WORD_RX)).toHaveLength(3);
		// And the two escape hatches must not swallow ordinary prose.
		expect(withoutNames("centre the column").match(WORD_RX)).toHaveLength(1);
		expect(withoutNames("the Centre told us").match(WORD_RX)).toBeNull();
	});
});
