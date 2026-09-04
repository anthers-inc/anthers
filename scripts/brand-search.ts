// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Search the Noun Project library from the terminal, so choosing an emblem happens
 * against nearly ten million icons instead of against the few hundred already in
 * the private library.
 *
 *     bun run brand:search "wildflower"
 *     bun run brand:search "wildflower" --style solid --limit 30
 *     bun run brand:search --like 7595393          # icons drawn in the same hand
 *     bun run brand:search "seed" --public-domain --json
 *
 * ⭐ **`--like` is the feature worth building a selection pass around.** A ladder of
 * Badges has to read as a set, which is a harder problem than finding one good icon
 * and is the one thing a bigger folder of SVGs can never help with. Feed it the pick
 * you are surest of and take the rest of the ladder from what comes back.
 *
 * ⚠️ **A search is a service call at $0.0025; `--like` is an icon call at $0.0095**,
 * because it carries an icon id. Both print the running total when they finish.
 * Every result line carries a permalink — open it to see the art, since a terminal
 * cannot show you the icon and the whole job here is a taste call.
 */

import { moreLikeThis, type NounIcon, reportSpend, search } from "./noun/client";

const SITE = "https://thenounproject.com";

// ⚠️ Which flags take a value has to be declared, not guessed from position: a
// boolean flag followed by the query would otherwise swallow it, and the search
// would run against an empty string rather than complaining.
const VALUE_FLAGS = new Set(["like", "limit", "style", "weight"]);
const args = Bun.argv.slice(2);
const values = new Map<string, string>();
const words: string[] = [];
for (let i = 0; i < args.length; i++) {
	const a = args[i] as string;
	if (!a.startsWith("--")) {
		words.push(a);
		continue;
	}
	const name = a.slice(2);
	if (VALUE_FLAGS.has(name)) values.set(name, args[++i] ?? "");
	else values.set(name, "");
}
const flag = (name: string) => values.get(name) || undefined;
const has = (name: string) => values.has(name);

const like = flag("like");
const query = words.join(" ");

if (!like && !query) {
	console.error(
		'brand:search: usage: bun run brand:search "<query>" [--style <s>] [--weight <w>]\n' +
			"                     [--limit <n>] [--public-domain] [--json]\n" +
			"                     bun run brand:search --like <icon-id> [--limit <n>] [--json]",
	);
	process.exit(2);
}

const limit = Number(flag("limit") ?? 20);
const params: Record<string, string | number | boolean> = { limit };
if (flag("style")) params.styles = flag("style") as string;
if (flag("weight")) params.line_weight = flag("weight") as string;
if (has("public-domain")) params.limit_to_public_domain = 1;

const result = like ? await moreLikeThis(like, { limit }) : await search(query, params);
const icons: NounIcon[] = result.icons ?? [];

if (has("json")) {
	console.log(JSON.stringify(icons, null, 2));
} else if (icons.length === 0) {
	console.log(like ? `nothing looks like icon ${like}` : `nothing matched "${query}"`);
} else {
	console.log(
		like
			? `${icons.length} icons in the same style as ${like}:\n`
			: `${icons.length} matches for "${query}":\n`,
	);
	for (const icon of icons) {
		// The license is the field a pick can go wrong on, so it sits where the eye lands
		// rather than at the end of the line. Everything here is redistributable with
		// attribution; the point is to see WHICH terms before choosing, not to filter.
		const creator = icon.creator?.name ?? "unknown";
		const license = (icon.license_description ?? "?").replace(
			"creative-commons-attribution",
			"CC BY 3.0",
		);
		console.log(
			`  ${String(icon.id).padEnd(9)} ${String(icon.term).slice(0, 28).padEnd(29)} ${license.padEnd(12)} ${creator}`,
		);
		console.log(`  ${" ".repeat(9)} ${SITE}${icon.permalink ?? ""}`);
	}
	console.log(
		`\nTo take one: bun run brand:add <icon-id> --as <friendly-id> --why "<why this one>"`,
	);
}

reportSpend();
