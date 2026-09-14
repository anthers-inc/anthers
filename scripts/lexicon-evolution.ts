// SPDX-License-Identifier: Apache-2.0
/**
 * Whether an edit to a published `org.anthers.*` Lexicon is one the network can absorb.
 *
 * 🛑 **A published schema is a commitment to people outside this project.** Other software may
 * already hold records shaped by it and validate new ones against the version it fetched, so a
 * field may be added only if it is optional, and nothing may ever be renamed, retyped, made
 * required or removed. A breaking edit is not fixed, it is published under a new NSID.
 *
 * ⭐ **What was published is committed, so the check needs no network.** `lexicons-published/`
 * holds a byte-for-byte copy of each schema as it went out, written by
 * `atproto-publish-lexicon.ts` at the moment it publishes and removed when it retires one.
 * `lex:check` compares `lexicons/` against it in `make verify` and CI, which stops a breaking
 * edit at the pull request rather than at the prompt that would publish it — and the publisher
 * compares it against the network before every write, so a copy that has drifted from what is
 * really published is caught there.
 *
 * ⚠️ **The rules are conservative on purpose.** Anything this cannot prove compatible is
 * reported, including a loosened constraint and an entry added to a permission set, because a
 * false alarm costs a conversation and a missed break costs somebody else's software. The things
 * it accepts are the ones the evolution rules plainly allow: rewording prose, adding an optional
 * property or a new def, and making a field optional or nullable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Where the Lexicon sources live, relative to the repository root. */
export const LEXICON_DIR = "lexicons";
/** Where the copy of what is actually published lives, mirroring `lexicons/`. */
export const PUBLISHED_DIR = "lexicons-published";

export interface LexiconDoc {
	lexicon: number;
	id: string;
	defs: Record<string, unknown>;
	[key: string]: unknown;
}

/** Every Lexicon JSON file under `dir`, keyed by NSID, with the file it came from. */
export function readLexiconDocs(dir: string): Map<string, { doc: LexiconDoc; path: string }> {
	const docs = new Map<string, { doc: LexiconDoc; path: string }>();
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return docs;
	}
	for (const entry of entries) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) {
			for (const [nsid, found] of readLexiconDocs(path)) docs.set(nsid, found);
			continue;
		}
		if (!entry.endsWith(".json")) continue;
		const doc = JSON.parse(readFileSync(path, "utf8")) as LexiconDoc;
		if (typeof doc.id !== "string") throw new Error(`${path} has no \`id\``);
		docs.set(doc.id, { doc, path });
	}
	return docs;
}

/** Where an NSID's published copy lives: `org.anthers.work` → `lexicons-published/org/anthers/work.json`. */
export function publishedPath(nsid: string, root = PUBLISHED_DIR): string {
	return `${join(root, ...nsid.split("."))}.json`;
}

/** Prose written for a person, which may be reworded without breaking anybody. */
function isProse(key: string): boolean {
	return ["description", "title", "detail"].some((k) => key === k || key.startsWith(`${k}:`));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function show(value: unknown): string {
	return JSON.stringify(value);
}

/**
 * Every way `current` breaks what `published` promised, as sentences. Empty when compatible.
 *
 * `current` is `null` when the schema is published and its source has been deleted, which is a
 * problem in its own right: retiring a schema takes it off the network first.
 */
export function evolutionProblems(published: LexiconDoc, current: LexiconDoc | null): string[] {
	if (!current) {
		return [
			`${published.id} is published but gone from ${LEXICON_DIR}/ — retire it with ` +
				"`atproto-publish-lexicon.ts --retire` rather than deleting the file",
		];
	}
	const problems: string[] = [];
	compare(published, current, published.id, problems);
	return problems;
}

function compare(published: unknown, current: unknown, path: string, out: string[]): void {
	if (Array.isArray(published)) {
		if (!Array.isArray(current) || current.length !== published.length) {
			out.push(`${path} changed from ${show(published)} to ${show(current)}`);
			return;
		}
		for (const [i, item] of published.entries()) compare(item, current[i], `${path}[${i}]`, out);
		return;
	}

	if (!isPlainObject(published)) {
		if (published !== current) {
			out.push(`${path} changed from ${show(published)} to ${show(current)}`);
		}
		return;
	}

	if (!isPlainObject(current)) {
		out.push(`${path} changed from an object to ${show(current)}`);
		return;
	}

	for (const [key, value] of Object.entries(published)) {
		if (isProse(key)) continue;
		const here = `${path}.${key}`;

		if (key === "properties" || key === "defs") {
			const now = isPlainObject(current[key]) ? current[key] : {};
			for (const [name, def] of Object.entries(value as Record<string, unknown>)) {
				if (!(name in now)) out.push(`${here}.${name} was removed or renamed`);
				else compare(def, now[name], `${here}.${name}`, out);
			}
			continue;
		}
		if (key === "required") {
			// Dropping a name from `required` makes a field optional, which every reader tolerates.
			const before = strings(value);
			for (const name of strings(current.required)) {
				if (!before.includes(name)) out.push(`${path}: \`${name}\` became required`);
			}
			continue;
		}
		if (key === "nullable" || key === "knownValues") {
			const now = strings(current[key]);
			for (const entry of strings(value)) {
				if (!now.includes(entry)) out.push(`${here} no longer includes \`${entry}\``);
			}
			continue;
		}
		if (!(key in current)) {
			out.push(`${here} was removed`);
			continue;
		}
		compare(value, current[key], here, out);
	}

	for (const key of Object.keys(current)) {
		if (key in published || isProse(key)) continue;
		// New properties, defs, nullable fields and known values are all additions a reader
		// ignores; a new `required` list makes every field in it required.
		if (key === "properties" || key === "defs" || key === "nullable" || key === "knownValues") {
			continue;
		}
		if (key === "required") {
			for (const name of strings(current.required)) {
				out.push(`${path}: \`${name}\` became required`);
			}
			continue;
		}
		out.push(`${path}.${key} was added as ${show(current[key])}`);
	}
}

/** Every problem across the repository: each published schema against its current source. */
export function repositoryEvolutionProblems(
	currentDir = LEXICON_DIR,
	publishedDir = PUBLISHED_DIR,
): string[] {
	const current = readLexiconDocs(currentDir);
	const problems: string[] = [];
	for (const [nsid, { doc }] of readLexiconDocs(publishedDir)) {
		problems.push(...evolutionProblems(doc, current.get(nsid)?.doc ?? null));
	}
	return problems;
}
