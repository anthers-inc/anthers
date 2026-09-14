// SPDX-License-Identifier: Apache-2.0
/**
 * Which edits to a published Lexicon are allowed, proven against the real `org.anthers.work`.
 *
 * ⚠️ **Every accepted edit sits beside a refused one of the same shape**, so a checker that
 * answered "compatible" to everything would fail half of this file rather than passing it.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { PUBLISHED_LEXICONS } from "../apps/api/src/services/published-lexicons.js";
import {
	evolutionProblems,
	LEXICON_DIR,
	type LexiconDoc,
	PUBLISHED_DIR,
	publishedPath,
	readLexiconDocs,
	repositoryEvolutionProblems,
} from "./lexicon-evolution.js";

const WORK = JSON.parse(readFileSync("lexicons/org/anthers/work.json", "utf8")) as LexiconDoc;
const SET = JSON.parse(
	readFileSync("lexicons/org/anthers/creatorPermissions.json", "utf8"),
) as LexiconDoc;

/** A copy of a schema with one edit applied to its main record's object. */
function edited(
	base: LexiconDoc,
	edit: (main: Record<string, unknown>, doc: LexiconDoc) => void,
): LexiconDoc {
	const doc = structuredClone(base);
	const main = doc.defs.main as Record<string, unknown>;
	edit((main.record as Record<string, unknown>) ?? main, doc);
	return doc;
}

function props(record: Record<string, unknown>): Record<string, Record<string, unknown>> {
	return record.properties as Record<string, Record<string, unknown>>;
}

describe("edits a published schema may take", () => {
	it("accepts the schema unchanged", () => {
		expect(evolutionProblems(WORK, structuredClone(WORK))).toEqual([]);
	});

	it("accepts reworded prose", () => {
		const doc = edited(WORK, (record, d) => {
			(d.defs.main as Record<string, unknown>).description = "Reworded.";
			props(record).title.description = "Reworded too.";
		});
		const set = structuredClone(SET);
		(set.defs.main as Record<string, unknown>).title = "A New Title";
		(set.defs.main as Record<string, unknown>).detail = "New detail.";
		expect(evolutionProblems(WORK, doc)).toEqual([]);
		expect(evolutionProblems(SET, set)).toEqual([]);
	});

	it("accepts a new optional property and a new def", () => {
		const doc = edited(WORK, (record, d) => {
			props(record).subtitle = { type: "string", maxLength: 300 };
			d.defs.extra = { type: "string" };
		});
		expect(evolutionProblems(WORK, doc)).toEqual([]);
	});

	it("accepts a field made optional, nullable, or given another known value", () => {
		const doc = edited(WORK, (record) => {
			record.required = (record.required as string[]).filter((n) => n !== "url");
			record.nullable = ["description"];
			props(record).kind.knownValues = [...(props(record).kind.knownValues as string[]), "zine"];
		});
		expect(evolutionProblems(WORK, doc)).toEqual([]);
	});
});

describe("edits that break a published schema", () => {
	const refused: [string, LexiconDoc, string][] = [
		[
			"a property removed",
			edited(WORK, (record) => delete props(record).description),
			"properties.description was removed or renamed",
		],
		[
			"a property renamed",
			edited(WORK, (record) => {
				props(record).summary = props(record).description;
				delete props(record).description;
			}),
			"properties.description was removed or renamed",
		],
		[
			"a property retyped",
			edited(WORK, (record) => {
				props(record).title.type = "integer";
			}),
			"properties.title.type changed",
		],
		[
			"a new property that is required",
			edited(WORK, (record) => {
				props(record).subtitle = { type: "string" };
				record.required = [...(record.required as string[]), "subtitle"];
			}),
			"`subtitle` became required",
		],
		[
			"an existing field made required",
			edited(WORK, (record) => {
				record.required = [...(record.required as string[]), "description"];
			}),
			"`description` became required",
		],
		[
			"a constraint added",
			edited(WORK, (record) => {
				props(record).url.maxLength = 2000;
			}),
			"properties.url.maxLength was added",
		],
		[
			"a constraint tightened",
			edited(WORK, (record) => {
				props(record).title.maxLength = 10;
			}),
			"properties.title.maxLength changed",
		],
		[
			"a constraint removed",
			edited(WORK, (record) => delete props(record).title.maxLength),
			"properties.title.maxLength was removed",
		],
		[
			"a known value removed",
			edited(WORK, (record) => {
				props(record).kind.knownValues = (props(record).kind.knownValues as string[]).slice(1);
			}),
			"properties.kind.knownValues no longer includes",
		],
		[
			"the record key changed",
			edited(WORK, (_record, d) => {
				(d.defs.main as Record<string, unknown>).key = "any";
			}),
			"defs.main.key changed",
		],
		[
			"a collection added to a permission set",
			(() => {
				const set = structuredClone(SET);
				const perms = (set.defs.main as { permissions: { collection: string[] }[] }).permissions;
				perms[0].collection.push("org.anthers.comment");
				return set;
			})(),
			"permissions[0].collection changed",
		],
	];

	for (const [name, doc, reason] of refused) {
		it(`refuses ${name}, for that reason`, () => {
			const base = name.includes("permission set") ? SET : WORK;
			expect(evolutionProblems(base, doc).join("\n")).toContain(reason);
		});
	}

	it("refuses a published schema whose source was deleted, and says how to retire it", () => {
		expect(evolutionProblems(WORK, null)[0]).toContain("--retire");
	});
});

describe("the repository as committed", () => {
	it("breaks no published schema", () => {
		expect(repositoryEvolutionProblems()).toEqual([]);
	});

	it("keeps a published copy of every schema Anthers writes records under", () => {
		const published = readLexiconDocs(PUBLISHED_DIR);
		for (const nsid of PUBLISHED_LEXICONS)
			expect({ nsid, has: published.has(nsid) }).toEqual({ nsid, has: true });
	});

	it("files each published copy where its NSID says", () => {
		for (const [nsid, { path }] of readLexiconDocs(PUBLISHED_DIR)) {
			expect(path).toBe(publishedPath(nsid));
		}
		expect(publishedPath("org.anthers.work")).toBe(`${PUBLISHED_DIR}/org/anthers/work.json`);
		expect(readLexiconDocs(LEXICON_DIR).size).toBeGreaterThan(0);
	});
});
