// SPDX-License-Identifier: Apache-2.0
/**
 * Push the seeded Noun Project blocklist up to the vendor — the one-time step after
 * `seed-noun-blocklist` has run against production.
 *
 *     bun run scripts/noun-blocklist-vendor-sync.ts
 *
 * 🚨 **The vendor credentials come from the "Anthers Prod" vault project** — the SAME
 * entries the API serves with — because the push is a key-level operation on the
 * vendor's side, keyed to the very key the picker asks with. The script runs on a
 * person's machine, not in production, and it holds the same credential handling every
 * vault-reading script here does: the token files, the values never on a command line.
 *
 * 🚨 **This script is an operator door, and it is deliberately dumb**: it reads nothing
 * from any database. It reads the blocklist THE VENDOR reports having (GET
 * /v2/client/blacklist), diffs it against the list below — which is the seed script's
 * own term list, imported — and pushes what is missing with `overwrite: false`. The
 * local `noun_blocklist` table in production is the OTHER copy; the two are reconciled
 * by the same terms living in both this file and the seed script, which is why the seed
 * script's TERMS are imported rather than restated — one list, two readers, and the
 * diff prints any disagreement rather than papering over it.
 *
 * After a successful run, their side carries every term; the vendor's view caches ten
 * minutes.
 */

import { get, vendorPost } from "../apps/api/src/lib/noun/client";
import { bwsSecrets } from "./bws";
import { TERMS } from "./seed-noun-blocklist-terms";

const secrets = await bwsSecrets("prod");
process.env.NOUN_PROJECT_KEY = secrets.get("NOUN_PROJECT_KEY") ?? "";
process.env.NOUN_PROJECT_SECRET = secrets.get("NOUN_PROJECT_SECRET") ?? "";
if (!process.env.NOUN_PROJECT_KEY) {
	console.error(
		"noun-blocklist-vendor-sync: no NOUN_PROJECT_KEY in the Anthers Prod vault project.",
	);
	process.exit(2);
}

// The vendor's own view of the key-level blocklist, as of now.
const current = await get<{
	blacklist: { search_terms?: string[]; icon_ids?: number[]; collection_ids?: number[] };
}>("/v2/client/blacklist");
const theirs = new Set((current.blacklist.search_terms ?? []).map((t) => t.toLowerCase()));

// The wanted list is the seed terms, lowercased the way both sides spell them.
const wanted = TERMS.map((t) => t.value.toLowerCase());
const missing = [...new Set(wanted)].filter((t) => !theirs.has(t));

if (missing.length === 0) {
	console.log(
		`noun-blocklist-vendor-sync: nothing to push — the vendor already carries all ${wanted.length} term(s).`,
	);
	process.exit(0);
}

console.log(`noun-blocklist-vendor-sync: pushing ${missing.length} missing term(s)...`);
await vendorPost("/v2/client/blacklist/term", { blacklist: missing, overwrite: false });
console.log(`pushed: ${missing.join(", ")}`);
console.log("(the vendor caches its view for ten minutes; a re-read may lag.)");
