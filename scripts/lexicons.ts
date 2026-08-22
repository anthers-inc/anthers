// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generate TypeScript from the `org.anthers.*` Lexicon documents, and verify the committed
 * output still matches them.
 *
 * The JSON under `lexicons/` is the source; everything under
 * `packages/shared/src/generated/lexicons/` is derived and must never be hand-edited — the
 * build runs with `--clear`, so anything hand-written there is deleted on the next run.
 * The curated surface is `packages/shared/src/lexicons.ts`, which sits outside it. `--check` regenerates into a temporary
 * directory and compares, which is the same shape as `econ:figures --check` and exists for
 * the same reason: a generated artefact that nothing re-derives is a second description of
 * the truth, free to drift.
 *
 * 🚨 A published Lexicon is a public API commitment — a breaking change becomes other
 * people's breakage — so drift here is not a formatting nit. If this check fails, the JSON
 * and the types disagree about a schema someone else may already be consuming.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

const LEXICONS = "lexicons";
const OUT = "packages/shared/src/generated/lexicons";
const check = process.argv.includes("--check");

async function generate(outDir: string) {
	// ⚠️ The output is left exactly as the generator wrote it — no prettier (this repo does
	// not use it) and no Biome (`biome.json` excludes `**/src/generated` on purpose). That
	// is what makes `--check` meaningful: both runs produce byte-identical raw output, so a
	// difference is a real difference rather than a formatter disagreeing with itself.
	// An earlier cut did run Biome and the check failed against output it had just produced,
	// because the temporary directory sits outside the repo where the exclusion does not
	// apply and Biome reformatted with its own defaults.
	const build = Bun.spawn(
		[
			"bun",
			"./node_modules/.bin/lex",
			"build",
			"--lexicons",
			LEXICONS,
			"--out",
			outDir,
			"--pretty",
			"false",
			"--clear",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [err, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
	if (code !== 0) {
		console.error(err || "lex build failed");
		process.exit(1);
	}
}

/** Every generated file, as path → contents, so two trees can be compared directly. */
async function readTree(dir: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	const glob = new Bun.Glob("**/*.ts");
	for await (const rel of glob.scan({ cwd: dir })) {
		files.set(rel, await Bun.file(join(dir, rel)).text());
	}
	return files;
}

if (!check) {
	await generate(OUT);
	const written = await readTree(OUT);
	console.log(`lexicons: generated ${written.size} file(s) from ${LEXICONS}/ ✓`);
	process.exit(0);
}

const tmp = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", `anthers-lex-check-${process.pid}`);
try {
	await generate(tmp);
	const [fresh, committed] = await Promise.all([readTree(tmp), readTree(OUT)]);

	const problems: string[] = [];
	for (const [path, body] of fresh) {
		if (!committed.has(path)) problems.push(`missing:  ${path}`);
		else if (committed.get(path) !== body) problems.push(`stale:    ${path}`);
	}
	for (const path of committed.keys()) {
		if (!fresh.has(path)) problems.push(`orphaned: ${path}`);
	}

	if (problems.length > 0) {
		console.error(
			"lexicons: generated types do not match the Lexicon documents.\n" +
				"Run `bun run lex:build` and commit the result.\n",
		);
		for (const p of problems) console.error(`  ✗ ${p}`);
		process.exit(1);
	}
	console.log(`lexicons: ${committed.size} generated file(s) match ${LEXICONS}/ ✓`);
} finally {
	await rm(tmp, { recursive: true, force: true });
}
