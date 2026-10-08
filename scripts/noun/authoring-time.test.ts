// SPDX-License-Identifier: Apache-2.0
/**
 * The Noun Project integration's two LAYOUT rules, proved rather than restated:
 *
 * 🚨 **Nothing that ships may import from `scripts/noun/`.** `packages/brand` commits
 * `src/generated/icons.ts` and the SVGs it is made from, which is what lets somebody
 * clone this repository, build a working site and regenerate the icons with no API key,
 * no network call and no access to anything private. Wiring a fetch into the build would
 * put a credential and a third-party dependency on the deploy path for artwork that
 * changes twice a year, cost an icon call per asset on every cold build, and give away
 * the property that makes the repository forkable.
 *
 * ⭐ **Where the credential scans went, and why.** This test once also failed the build
 * on any mention of the credential's env names outside `scripts/` — a rule written to
 * keep provenance storytelling out of shipped surfaces, back when the integration was
 * authoring-only. The Badge Maker runs the API at runtime, and an env-var name carries
 * no secret (the value is what would), so the scan became noise with no point and was
 * removed on 2026-10-07 by Parker's ruling that it was antiquated: it was never a
 * security control, and the credential rule that IS one — values pass only through
 * environment injection — lives in spec-apply and the vault, which are unaffected. The
 * runtime client (`apps/api/src/lib/noun/client.ts`) reads the same vault names the
 * authoring scripts have always used.
 *
 * ⚠️ ASSET URLS EXPIRE WITHIN AN HOUR, so this is a sourcing API and can never be a
 * serving one. Every byte it returns has to be written to disk by the caller;
 * nothing Anthers renders may point at a Noun Project URL.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const REPO = join(import.meta.dir, "..", "..");

/**
 * Every matching file under the repository, with dependency and build trees left out, and
 * anything git ignores left out too.
 *
 * ⚠️ **An ignored path is not part of the repository, and a nested checkout lives in one.** A
 * session's worktree under `.claude/worktrees/` carries its own `scripts/noun/client.ts`, whose
 * path does not start with `scripts/`, so a scan that walked into it failed the build for a copy
 * of this repository that ships nothing. A fork with no `.git` gets no answer from git and keeps
 * every path, which is the stricter direction.
 */
function scan(pattern: string): string[] {
	const found = [...new Glob(pattern).scanSync({ cwd: REPO, dot: true })].filter(
		(p) => !/(^|\/)(node_modules|dist|build|\.git)(\/|$)/.test(p),
	);
	if (found.length === 0) return found;
	const ignored = Bun.spawnSync(["git", "check-ignore", "--stdin"], {
		cwd: REPO,
		stdin: Buffer.from(found.join("\n")),
	});
	const skip = new Set(ignored.stdout.toString().split("\n").filter(Boolean));
	return found.filter((p) => !skip.has(p));
}

const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("no build step talks to the API", () => {
	it("🚨 keeps the API client out of every package's build script", () => {
		for (const manifest of ["package.json", ...scan("{apps,packages}/*/package.json")]) {
			const scripts = (JSON.parse(read(manifest)) as { scripts?: Record<string, string> }).scripts;
			for (const [name, cmd] of Object.entries(scripts ?? {})) {
				if (name !== "build" && !name.startsWith("build:")) continue;
				// `brand:build` is the codegen, which reads packages/brand/svg from disk;
				// `brand:add` and `brand:search` are the ones that reach the network.
				expect({ manifest, name, reachesApi: /brand-(add|search|usage)|noun\//.test(cmd) }).toEqual(
					{ manifest, name, reachesApi: false },
				);
			}
		}
	});

	it("keeps the shipped package from importing the authoring scripts", () => {
		for (const p of scan("packages/brand/src/**/*.ts")) {
			expect({ p, importsScripts: /from\s+["'][^"']*scripts\//.test(read(p)) }).toEqual({
				p,
				importsScripts: false,
			});
		}
	});
});

describe("the fork property", () => {
	it("⭐ regenerates the committed markup from the committed SVGs", async () => {
		// The fork property in full: everything the codegen reads is in the repository, so
		// a fork can rebuild the icons as well as the app. `--check` compares in memory and
		// writes nothing, so a drift fails here without touching the working tree.
		const proc = Bun.spawn(["bun", "run", "scripts/build-icons.ts", "--check"], {
			cwd: join(REPO, "packages/brand"),
			stdout: "pipe",
			stderr: "pipe",
		});
		const err = await new Response(proc.stderr).text();
		expect({ exit: await proc.exited, err }).toEqual({ exit: 0, err: "" });
	});

	it("commits the generated markup rather than a manifest to resolve", () => {
		// Compared as booleans rather than with `toContain`, because the file is a
		// megabyte of path data and a failed assertion would print all of it.
		const generated = "packages/brand/src/generated/icons.ts";
		expect(existsSync(join(REPO, generated))).toBe(true);
		const source = read(generated);
		expect({
			inlinesGeometry: source.includes("viewBox:") && source.includes("inner:"),
			resolvesAtRuntime: /await\s+import|readFileSync|fetch\(/.test(source),
		}).toEqual({ inlinesGeometry: true, resolvesAtRuntime: false });
	});
});

describe("no authoring script writes an SVG the API handed over", () => {
	/**
	 * 🚨 **The key-creation flow required agreeing that the app will not cache SVG
	 * files** (Parker, 2026-09-04) — a term in neither the published Terms of Use nor
	 * the API documentation. Writing an API-fetched SVG into `packages/brand/svg` is the
	 * clearest instance of it, so `brand:add` takes the file from `--file` and the
	 * subscription supplies it.
	 *
	 * ⚠️ **This is a test because the violation reintroduces itself.** The download
	 * endpoint also refuses us today (`403 You are not authorized to edit this icon`),
	 * so a user meeting only that reads a plan limitation and writes a fallback for
	 * the day it lifts — which is what the first version of `brand-add.ts` did, in as
	 * many words. A latent breach that switches itself on when somebody upgrades a plan
	 * for unrelated reasons is worse than one that never worked at all.
	 */
	it("🚨 keeps downloadSvg out of every script that writes to the library", () => {
		for (const p of scan("scripts/**/*.ts")) {
			if (p.endsWith(".test.ts") || p === "scripts/noun/client.ts") continue;
			const source = read(p);
			expect({
				p,
				fetchesAndWrites: /downloadSvg/.test(source) && /writeFileSync/.test(source),
			}).toEqual({ p, fetchesAndWrites: false });
		}
	});

	it("requires --file rather than falling back to the API", () => {
		const source = read("scripts/brand-add.ts");
		expect({
			importsDownload: /\bdownloadSvg\b/.test(source),
			readsLocalFile: /values\.get\("file"\)/.test(source),
		}).toEqual({ importsDownload: false, readsLocalFile: true });
	});
});
