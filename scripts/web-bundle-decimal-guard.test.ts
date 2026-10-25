// SPDX-License-Identifier: Apache-2.0
/**
 * decimal.js never reaches the web SPA's bundle graph.
 *
 * ⭐ **A walk of the import graph rather than a grep of the built bundle**, because a guard
 * that runs the bundler is too slow to stand beside the unit suites, and the bundler itself
 * is the weaker signal — a chunk that happens not to hold a string today can hold it tomorrow
 * while the import that pulls it in sat there all along. The graph walk reads the same thing
 * Bun's bundler reads (module specifiers, resolved through the workspace packages' own
 * `exports` maps), so it fails on the import, at the source, the moment one is written.
 *
 * The rule it enforces: **decimal.js may only be imported by `@anthers/shared/fees`** —
 * exact financial arithmetic is real money, so it lives in the one module that was budgeted
 * for it — and therefore the SPA graph may import neither `decimal.js` nor `@anthers/shared/fees`.
 * Two moves made this true (2026-10-15, the decimal-bundle-break task): `MERCH_BADGE_DISCOUNT_RATE`
 * and `reductionFor` out of `constants.ts` / `billing-cycle.ts` into `fees.ts`, both of which
 * are ordinary modules the web app's pages reach for (`SettingsPage`, `every page importing a
 * constant`), so one decimal import beside shared constants rode the whole library into the
 * public bundle. This test is the standing check on the import graph; a grep for a
 * decimal.js-only method name against a built bundle is the manual spot check beside it.
 *
 * ⚠️ **The walk must target the WEB app only.** The API, the worker and the tests use
 * decimal.js legitimately — a repo-wide grep is the check that reports a clean board and a
 * broken build, which is exactly what a guard people route around becomes.
 *
 * `Bun.Transpiler.scanImports` is why the walk is sound: it drops `import type` (erased at
 * build, nothing in the bundle), follows dynamic `import()` (the route-level chunks the
 * bundler splits, without which eight React.lazy authoring pages ship to every reader), and
 * lists bare specifiers straight, where `decimal.js` is caught by name.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Repository root — this file lives in `<root>/scripts/`. */
const ROOT = resolve(import.meta.dir, "..");

/** The SPA's single bundle entry (`index.html` points at it; `apps/web/build.ts` builds it). */
const ENTRY = join(ROOT, "apps/web/src/index.tsx");

/** Every import in the graph is decimal.js itself, or a file allowed to hold it. */
const FEES_FILE = join(ROOT, "packages/shared/src/fees.ts");
const DECIMAL_SPECIFIERS = ["decimal.js", "decimal.js-light"];

// ── Workspace alias map ───────────────────────────────────────────────────────
/**
 * Specifier prefix → absolute directory, built from the workspaces' own `exports` maps
 * rather than re-stated here, so renaming or adding an export keeps the walk honest.
 * Glob-shaped keys (`"./logo/*"`) export assets, not code, and are skipped.
 */
const ALIASES = new Map<string, { dir: string; file: (sub: string) => string | null }>();

function loadExportsMap(pkgDir: string, pkgName: string): void {
	const manifest = join(pkgDir, "package.json");
	if (!existsSync(manifest)) return;
	const exports: Record<string, string> | undefined = JSON.parse(
		readFileSync(manifest, "utf8"),
	).exports;
	if (!exports) return;
	const map = new Map<string, string>();
	for (const [key, target] of Object.entries(exports)) {
		if (key.includes("*")) continue;
		const file = resolve(pkgDir, target);
		if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
		map.set(key, file);
	}
	if (map.size === 0) return;
	ALIASES.set(pkgName, {
		dir: pkgDir,
		file: (sub) => map.get(sub) ?? null,
	});
}

for (const scope of ["packages", "apps"]) {
	for (const entry of readdirSync(join(ROOT, scope), { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const pkgDir = join(ROOT, scope, entry.name);
		const manifest = join(pkgDir, "package.json");
		if (!existsSync(manifest)) continue;
		const name: string = JSON.parse(readFileSync(manifest, "utf8")).name;
		if (typeof name === "string" && name.startsWith("@")) loadExportsMap(pkgDir, name);
	}
}

const TS_CANDIDATES = [".ts", ".tsx"];

/** The TS source an extensionless module path names, trying the shapes the tree writes. */
function tsFileFor(base: string): string | null {
	const JS_SOURCES = [".js", ".mjs", ".jsx"]; // vendored, third-party, and built sources
	// An explicit source path — the vendored `.js` files especially — is itself the file.
	if (existsSync(base) && [".ts", ".tsx", ...JS_SOURCES].some((ext) => base.endsWith(ext))) {
		return base;
	}
	const candidates = [
		...TS_CANDIDATES.map((ext) => `${base}${ext}`),
		// The tree writes ESM `./constants.js` against TS sources (Node16-style).
		...["ts", "tsx"].map((ext) => base.replace(/\.js(?:on)?$/, `.${ext}`)),
		...TS_CANDIDATES.map((ext) => join(base, `index${ext}`)),
		...JS_SOURCES.map((ext) => `${base}${ext}`),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && TS_CANDIDATES.some((ext) => candidate.endsWith(ext)))
			return candidate;
	}
	for (const candidate of JS_SOURCES.map((ext) => `${base}${ext}`)) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Resolve one module specifier from one importer. Returns `{ file }` for a workspace or
 * relative source file, `{ bare }` for a package dependency, or `null` for an import that
 * is not a source module (CSS, an asset, the platform's own namespaces).
 */
function resolveSpecifier(
	specifier: string,
	importer: string,
): { file?: string; bare?: string } | null {
	if (specifier.startsWith(".")) {
		const file = tsFileFor(join(dirname(importer), specifier));
		return file ? { file } : null; // relative, but not a TS module — an asset or stylesheet ride-along
	}
	if (specifier.startsWith("@anthers/")) {
		// A scoped name is exactly two segments — `@anthers/shared`, or the package plus a
		// subpath — so the split is at the SECOND slash, never the first.
		const match = specifier.match(/^(@[^/]+\/[^/]+)(\/.*|$)$/);
		if (!match) return null;
		const bare = ALIASES.get(match[1]);
		if (!bare) return null;
		// The exports keys are keyed `"."` for the root and `"./x"` for a subpath.
		const file = bare.file(match[2] === "" ? "." : `.${match[2]}`) ?? null;
		return file ? { file } : null;
	}
	if (specifier.startsWith("@/")) {
		const file = tsFileFor(join(ROOT, "apps/web/src", specifier.slice(2)));
		return file ? { file } : null;
	}
	// Everything else — `react`, `decimal.js`, a scoped dependency — is resolved by
	// node_modules from here out, so the walk carries its name and never follows it.
	return { bare: specifier };
}

// ── The walk ───────────────────────────────────────────────────────────────────
interface GraphResult {
	/** Every source file reachable from the SPA entry, statically or by a route chunk. */
	reachable: Set<string>;
	/** How many files entered the graph only through a dynamic `import()` — the route chunks. */
	viaDynamicImport: number;
	/** File → specifier: the decimal/fees imports the walk found. */
	hits: { importer: string; specifier: string }[];
	/** Relative/alias specifiers the resolver could not turn into a file. Unbundlable. */
	unresolved: { importer: string; specifier: string }[];
}

function walkWebGraph(): GraphResult {
	const reachable = new Set<string>();
	const viaDynamicImport = new Set<string>();
	const hits: GraphResult["hits"] = [];
	const unresolved: GraphResult["unresolved"] = [];
	const queue: Array<{ file: string; dynamic: boolean }> = [{ file: ENTRY, dynamic: false }];
	reachable.add(ENTRY);
	while (queue.length > 0) {
		const { file, dynamic } = queue.shift()!;
		if (dynamic) viaDynamicImport.add(file);
		const source = readFileSync(file, "utf8");
		const loader = file.endsWith(".tsx")
			? "tsx"
			: file.endsWith(".jsx")
				? "jsx"
				: file.endsWith(".ts")
					? "ts"
					: "js";
		const transpiler = new Bun.Transpiler({ loader });
		for (const imported of transpiler.scanImports(source)) {
			const resolved = resolveSpecifier(imported.path, file);
			if (resolved === null) {
				if (!/\.(css|svg|png|jpg|webp|woff2?|txt|html)$|(\?raw|\?.+=)/.test(imported.path)) {
					unresolved.push({ importer: file, specifier: imported.path });
				}
				continue;
			}
			if (resolved.bare !== undefined) {
				if (DECIMAL_SPECIFIERS.includes(resolved.bare)) {
					hits.push({ importer: file, specifier: resolved.bare });
				}
				continue;
			}
			if (resolved.file) {
				if (resolved.file === FEES_FILE) hits.push({ importer: file, specifier: imported.path });
				if (!reachable.has(resolved.file)) {
					reachable.add(resolved.file);
					queue.push({
						file: resolved.file,
						dynamic: dynamic || imported.kind === "dynamic-import",
					});
				}
			}
		}
	}
	return { reachable, viaDynamicImport: viaDynamicImport.size, hits, unresolved };
}

describe("decimal.js out of the web SPA bundle", () => {
	it("walks a substantial graph, so a broken resolver cannot pass this vacuously", () => {
		const graph = walkWebGraph();
		expect(graph.reachable.size).toBeGreaterThan(100);
		// Static reach: the shared-constants module every page imports.
		expect(graph.reachable.has(join(ROOT, "packages/shared/src/constants.ts"))).toBe(true);
		// Dynamic reach: route-level chunks must be followed, or a decimal import in a lazy
		// page would sit below the walk's waterline while the bundler ships it anyway.
		expect(graph.viaDynamicImport).toBeGreaterThan(0);
	});

	it("resolves every relative and workspace specifier it sees, or the walk was blind", () => {
		const graph = walkWebGraph();
		expect(
			graph.unresolved.map((u) => `${u.importer}: ${u.specifier}`),
			"an unresolvable relative/workspace import means the walk skipped a subtree silently",
		).toEqual([]);
	});

	it("🚨 never reaches decimal.js, by name, from any module it bundles", () => {
		const graph = walkWebGraph();
		expect(
			graph.hits
				.filter((h) => DECIMAL_SPECIFIERS.includes(h.specifier))
				.map((h) => `${h.importer}: ${h.specifier}`),
			"decimal.js rides the SPA bundle through this import. Exact money arithmetic belongs in @anthers/shared/fees, which the web app's bundle graph never reaches; see `packages/shared/src/figures.ts`'s docblock",
		).toEqual([]);
	});

	it("🚨 never reaches @anthers/shared/fees — the one module allowed to import decimal.js", () => {
		const graph = walkWebGraph();
		expect(
			graph.hits
				.filter((h) => !DECIMAL_SPECIFIERS.includes(h.specifier))
				.map((h) => `${h.importer}: ${h.specifier}`),
			"@anthers/shared/fees is the only home of decimal.js, so reaching it from the web graph is the leak one step removed. Read the constant you need from figures.ts instead, or move the arithmetic API-side",
		).toEqual([]);
	});
});
