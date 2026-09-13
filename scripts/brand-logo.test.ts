// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The web-sized logo files are committed copies of the logo's exports, and this is what
// stops them drifting. `bun run brand:logo` writes them and records both hashes; a
// re-export from a PSD without a rerun changes a source hash, and an output edited or
// replaced by hand changes an output hash. Either one is a copy of the brand that no
// longer matches the brand, which nothing else in the build would notice.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST, OUTPUTS, sha256 } from "./brand-logo";

const REPO = join(import.meta.dir, "..");

type Entry = { file: string; source: string; sourceSha256: string; sha256: string };
const manifest = JSON.parse(readFileSync(join(REPO, MANIFEST), "utf8")) as { outputs: Entry[] };

describe("the web logo files", () => {
	test("the manifest lists exactly what brand:logo produces", () => {
		expect(manifest.outputs.map(({ file, source }) => ({ file, source }))).toEqual(
			OUTPUTS.map(({ file, source }) => ({ file, source })),
		);
	});

	for (const entry of manifest.outputs) {
		test(`${entry.file} still matches ${entry.source}`, () => {
			expect(existsSync(join(REPO, entry.source)), `missing source ${entry.source}`).toBe(true);
			expect(existsSync(join(REPO, entry.file)), `missing output ${entry.file}`).toBe(true);
			expect(sha256(entry.source), `${entry.source} changed — rerun \`bun run brand:logo\``).toBe(
				entry.sourceSha256,
			);
			expect(
				sha256(entry.file),
				`${entry.file} was edited by hand — rerun \`bun run brand:logo\``,
			).toBe(entry.sha256);
		});
	}

	test("nothing sits in logo/web that brand:logo did not write", () => {
		const dir = join(REPO, "packages/brand/logo/web");
		const listed = new Set(
			manifest.outputs
				.filter((e) => e.file.startsWith("packages/brand/logo/web/"))
				.map((e) => e.file.split("/").pop()),
		);
		const stray = readdirSync(dir).filter((f) => f !== "manifest.json" && !listed.has(f));
		expect(stray).toEqual([]);
	});
});
