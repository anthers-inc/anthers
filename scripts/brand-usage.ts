// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the Noun Project key has spent this month, and what it is allowed to spend.
 *
 *     bun run brand:usage                # limits and usage
 *     bun run brand:usage --json         # the raw response
 *     bun run brand:usage --probe        # does search+include_svg bill as a service call?
 *
 * 🚨 **A search does not return SVGs, so sourcing costs an icon call per icon.**
 * `include_svg` was worth a fourfold saving if it worked — a search carries no icon
 * ID and so bills at $0.0025 rather than the $0.0095 an icon call costs — and it
 * returns no SVG field at all. Measured 2026-09-04 against a trial key, with
 * `include_svg` as `1`, as `true`, and alongside `limit_to_public_domain`; the
 * result carries `attribution`, `id`, `license_description`, `permalink`, `term`,
 * `thumbnail_url`, `collections`, `tags`, `styles` and `creator`, and nothing else.
 * ⚠️ Trial keys may simply not be served it, so `--probe` stays here to be re-run on
 * a paid plan rather than being deleted now that it has an answer.
 *
 * ⭐ **Every search response carries `usage_limits` inline**, which is why the probe
 * needs no second usage call and why any tool can report the running bill for free.
 */

import { reportSpend, search, usage } from "./noun/client";

const args = Bun.argv.slice(2);
const json = args.includes("--json");
const probe = args.includes("--probe");

/**
 * Every number in the response, by dotted path.
 *
 * ⚠️ **Recursive on purpose, because the counters are three levels down.** The
 * live shape is `monthly.usage.service`, and a flattener that walked two levels
 * found nothing at all — which the probe reported as "no counter moved", the exact
 * answer a working saving would produce. A reader that can miss its target and
 * still print a confident sentence is worse than no reader.
 */
function counters(node: unknown, prefix = ""): Record<string, number> {
	if (!node || typeof node !== "object") return {};
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
		const path = prefix ? `${prefix}.${k}` : k;
		if (typeof v === "number") out[path] = v;
		else if (v && typeof v === "object") Object.assign(out, counters(v, path));
	}
	return out;
}

const before = await usage();
if (json && !probe) {
	console.log(JSON.stringify(before, null, 2));
} else if (!probe) {
	const flat = counters(before);
	const keys = Object.keys(flat).sort();
	if (keys.length === 0) {
		console.log("usage: the response carried no numeric counters — run with --json to see it.");
	} else {
		for (const k of keys) console.log(`  ${k.padEnd(28)} ${flat[k]}`);
	}
}

if (probe) {
	console.log("probing whether a search with include_svg returns usable SVGs…\n");
	// ⭐ Every search response carries `usage_limits` inline, so the "after" reading is
	// free — the probe costs one usage call plus the one search it is measuring.
	const result = await search("flower", { limit: 1, include_svg: 1 });

	const a = counters(before);
	const b = counters(result.usage_limits);
	const moved = Object.keys({ ...a, ...b })
		.filter((k) => (b[k] ?? 0) !== (a[k] ?? 0))
		.sort();

	console.log("counters that moved across the one search:");
	for (const k of moved) console.log(`  ${k.padEnd(34)} ${a[k] ?? 0} → ${b[k] ?? 0}`);
	if (moved.length === 0) console.log("  (none reported)");

	const first = result.icons?.[0] ?? {};
	const svgField = Object.entries(first).find(
		([k, v]) => /svg|encoded|file/i.test(k) && typeof v === "string" && v.length > 0,
	);
	console.log(
		`\ninclude_svg returned: ${
			svgField ? `\`${svgField[0]}\`, ${String(svgField[1]).length} characters` : "no SVG field"
		}`,
	);
	console.log(`fields on the result: ${Object.keys(first).sort().join(", ")}`);
	if (json) console.log(`\n${JSON.stringify(first, null, 2)}`);
}

reportSpend();
