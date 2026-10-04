// SPDX-License-Identifier: Apache-2.0
/**
 * No e2e spec may import a module that reaches `bun:test` — Playwright's workers run under
 * Node, and `bun:test` resolves through the `bun:` protocol, which Node's ESM loader refuses
 * at worker boot: "Only URLs with a scheme in: file, data, and node are supported by the
 * default ESM loader. Received protocol 'bun:'". The failure is total and early — every
 * worker dies before running a single spec, so CI shows a red job with no test names in it,
 * which is exactly how it looked on 2026-10-04 when two authed specs imported
 * `purgeAccountIds` from `cleanup.ts` (PR #351, `browser-media` red identically on two runs).
 *
 * The honest shape is a blocklist of the modules that are KNOWN to hook bun's lifecycle —
 * chief among them `cleanup.ts`, whose `purge*CreatedHere` registrars call `beforeAll`/
 * `afterAll` from `bun:test` at import time — with a message pointing at the Node-safe
 * split (`purge.ts`) rather than at this test. New API test helpers that import `bun:test`
 * in any form belong on the list when an e2e first reaches for them; a spec that fails this
 * test is one CI run away from failing the way this file's header describes.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Modules under `apps/api/src/__tests__/` that reach `bun:test` and must not reach Node. */
const BUN_ONLY_MODULES = ["cleanup"];

/** A spec file, anywhere under tests/e2e, that Playwright's Node workers load. */
function e2eSpecs(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...e2eSpecs(full));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".setup.ts")) out.push(full);
	}
	return out;
}

const HERE = import.meta.dir;

describe("e2e specs never import a bun:test module", () => {
	it("no spec under tests/e2e imports from a module that hooks Bun's test lifecycle", () => {
		const specs = e2eSpecs(join(HERE, "e2e"));
		expect(specs.length).toBeGreaterThan(20);
		const offenders: string[] = [];
		for (const spec of specs) {
			const text = readFileSync(spec, "utf8");
			for (const module of BUN_ONLY_MODULES) {
				// The module is imported by its path fragment; assert on the fragment so an
				// alias or a relative depth both match.
				if (new RegExp(`__tests__/${module}(\\.js)?["']`).test(text)) {
					offenders.push(`${spec} imports ${module}`);
				}
			}
		}
		// A hit names the Node-safe split, not just the rule — the fix is one import away.
		expect(offenders).toBeEmpty();
		if (offenders.length > 0) {
			throw new Error(
				`These specs run under Node (Playwright), which cannot load bun:test:\n  ${offenders.join("\n  ")}\n` +
					"The purge functions live in purge.ts — a module with no test-framework imports. " +
					"Import teardown helpers from there, never from cleanup.ts.",
			);
		}
	});
});
