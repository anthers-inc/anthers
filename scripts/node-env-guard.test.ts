// SPDX-License-Identifier: Apache-2.0
/**
 * Nothing may branch on `NODE_ENV`, except to ask whether the test runner is running.
 *
 * 🚨 **`NODE_ENV` is set nowhere in the Anthers app**, so every `NODE_ENV === "production"`
 * is false in production and silently takes its development branch. Three security branches
 * and two ATProto deploys went wrong that way before `isPublicDeployment()` replaced them,
 * and a fourth — the OAuth base-URL refusal — survived the sweep because the rule was only
 * written down. This makes it a build failure instead.
 *
 * ⭐ **`NODE_ENV === "test"` is the one sound read**, because Bun's test runner sets it itself:
 * it is a fact about the process rather than a label a deployment has to remember. Anything
 * else — `"production"`, `"development"`, or an inequality against either — is the proxy the
 * Agents Hub forbids. Detect the thing itself: `isPublicDeployment()` for "deployed somewhere
 * public", `isDevCheckout()` for "running from a repository checkout".
 *
 * Comments are stripped before the scan, because the reasoning behind this rule is written
 * beside the code it replaced and names the forbidden branch in order to warn against it.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const ROOTS = ["apps/api/src", "apps/web/src", "apps/admin/src", "packages", "scripts"] as const;
const SELF = "node-env-guard.test.ts";

/**
 * Test files are exempt: they set and delete `NODE_ENV` to prove the code ignores it, which
 * is the opposite of branching on it.
 */
function isTestFile(rel: string): boolean {
	return rel.includes("__tests__/") || /\.(test|e2e)\.tsx?$/.test(rel);
}

async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for (const root of ROOTS) {
		for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root })) {
			if (rel.includes("node_modules/") || rel.endsWith(SELF) || isTestFile(rel)) continue;
			found.push(join(root, rel));
		}
	}
	return found;
}

/**
 * Drops block and line comments. A block comment must open at a line start or after
 * whitespace, so a glob such as `**` + `/*.ts` in a string is not read as one. Naive about
 * `//` inside a string, which can only remove text after it on the same line — so it can
 * hide a violation that shares a line with a URL, never invent one.
 */
export function stripComments(source: string): string {
	return source.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Any comparison involving `NODE_ENV`, in either operand order. */
const COMPARISON =
	/NODE_ENV["'\]]*\s*[!=]==?\s*(["'`])([^"'`]*)\1|(["'`])([^"'`]*)\3\s*[!=]==?\s*[\w.[\]"']*NODE_ENV/g;

/** The value each `NODE_ENV` comparison in `source` tests against. */
export function comparedValues(source: string): string[] {
	const values: string[] = [];
	for (const match of stripComments(source).matchAll(COMPARISON)) {
		values.push(match[2] ?? match[4] ?? "");
	}
	return values;
}

describe("no branch on NODE_ENV", () => {
	it("scans every root, so a broken glob cannot pass silently", async () => {
		const files = await sourceFiles();
		expect(files.length).toBeGreaterThan(100);
		for (const root of ROOTS) {
			const mine = files.filter((f) => f.startsWith(`${root}/`));
			expect(mine.length, `${root} contributed no files — check its glob`).toBeGreaterThan(0);
		}
	});

	it("🚨 still recognizes a forbidden branch when it sees one", () => {
		// A pattern that stopped matching would leave the scan below green while the rule it
		// enforces quietly stopped being enforced, so each shape is proven here.
		expect(comparedValues(`if (process.env.NODE_ENV === "production") {}`)).toEqual(["production"]);
		expect(comparedValues(`if ("development" !== process.env.NODE_ENV) {}`)).toEqual([
			"development",
		]);
		expect(comparedValues(`const x = process.env["NODE_ENV"] != 'production';`)).toEqual([
			"production",
		]);
		expect(comparedValues(`// if (process.env.NODE_ENV === "production") {}`)).toEqual([]);
		expect(comparedValues(`/* NODE_ENV === "production" */ const y = 1;`)).toEqual([]);
	});

	it("⭐ sees the sanctioned test-runner reads, so the corpus is really being read", async () => {
		// `email.ts` and `dev-spec-env.ts` ask whether Bun's test runner is running. If the
		// scan cannot find them it is not reading source at all, and its silence below means
		// nothing.
		let sanctioned = 0;
		for (const path of await sourceFiles()) {
			sanctioned += comparedValues(await Bun.file(path).text()).filter((v) => v === "test").length;
		}
		expect(sanctioned).toBeGreaterThan(0);
	});

	it("contains no branch on NODE_ENV other than the test runner's", async () => {
		const hits: string[] = [];
		for (const path of await sourceFiles()) {
			for (const value of comparedValues(await Bun.file(path).text())) {
				if (value !== "test") hits.push(`${path} → NODE_ENV compared to "${value}"`);
			}
		}
		if (hits.length > 0) {
			console.error(
				"\nNODE_ENV is set nowhere in the Anthers app, so this branch takes its development\n" +
					"side in production. Use isPublicDeployment() or isDevCheckout() instead.\n",
			);
			for (const h of hits) console.error(`  ✗ ${h}`);
		}
		expect(hits).toEqual([]);
	});
});
