// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Noun Project integration runs at AUTHORING time and never at build time.
 *
 * 🚨 **This is the one rule the whole arrangement rests on, so it is a test rather
 * than a paragraph.** `packages/brand` commits `src/generated/icons.ts`, and the
 * codegen states outright that the app builds identically with the source library
 * absent — which is what lets somebody clone this repository and build a working
 * site with no API key, no network call and no access to anything private. Wiring a
 * fetch into the build would put a credential and a third-party dependency on the
 * deploy path for artwork that changes twice a year, cost an icon call per asset on
 * every cold build, and give away the property that makes the repository forkable.
 *
 * ⚠️ **A future Badge Maker will need a runtime key, and it will not be this one.**
 * That is a creator-facing product surface with its own credential, spend cap and
 * blocklist. If this test ever has to change, the change is a deliberate product
 * decision and not a tidy-up.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const REPO = join(import.meta.dir, "..", "..");
const CREDENTIAL = "NOUN_PROJECT";

/** Every matching file under the repository, with dependency and build trees left out. */
function scan(pattern: string): string[] {
	return [...new Glob(pattern).scanSync({ cwd: REPO, dot: true })].filter(
		(p) => !/(^|\/)(node_modules|dist|build|\.git)(\/|$)/.test(p),
	);
}

const read = (p: string) => readFileSync(join(REPO, p), "utf8");

describe("the credential never reaches the deploy path", () => {
	it("🚨 is named in nothing that ships", () => {
		// Anything the server, the web app or the desktop shell can see is on the deploy
		// path by definition, whether or not it is read.
		const shipped = [...scan("apps/**/*.{ts,tsx}"), ...scan("packages/*/src/**/*.{ts,tsx}")];
		expect(shipped.length).toBeGreaterThan(50); // the scan itself has to be working
		const offenders = shipped.filter((p) => read(p).includes(CREDENTIAL));
		expect(offenders).toEqual([]);
	});

	it("🚨 is named in no deployment or CI configuration", () => {
		// A secret declared in the app spec is injected into every running container,
		// which is the state this rule exists to prevent — and it is invisible in code.
		const config = [
			...scan(".do/*.yaml"),
			...scan(".github/workflows/*.yml"),
			...scan("Dockerfile*"),
			...scan("apps/*/Dockerfile*"),
		];
		expect(config.length).toBeGreaterThan(0);
		expect(config.filter((p) => read(p).includes(CREDENTIAL))).toEqual([]);
	});

	it("🚨 is reachable only from the authoring scripts", () => {
		const everywhere = scan("**/*.ts").filter((p) => read(p).includes(CREDENTIAL));
		for (const p of everywhere) expect(p.startsWith("scripts/")).toBe(true);
	});
});

describe("no build step talks to the API", () => {
	it("🚨 keeps the API client out of every package's build script", () => {
		for (const manifest of ["package.json", ...scan("{apps,packages}/*/package.json")]) {
			const scripts = (JSON.parse(read(manifest)) as { scripts?: Record<string, string> }).scripts;
			for (const [name, cmd] of Object.entries(scripts ?? {})) {
				if (name !== "build" && !name.startsWith("build:")) continue;
				// `brand:build` is the codegen, which reads the private library from disk;
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
	it("⭐ builds the brand package with the private icon library absent", async () => {
		// The generated markup is committed precisely so this works. `build-icons.ts`
		// degrades with a pointer rather than failing, the same way `econ:figures` skips
		// its wiki blocks when the vault is not there.
		const generated = join(REPO, "packages/brand/src/generated/icons.ts");
		const before = readFileSync(generated, "utf8");
		const proc = Bun.spawn(["bun", "run", "scripts/build-icons.ts"], {
			cwd: join(REPO, "packages/brand"),
			env: { ...process.env, BRAND_SOURCE: join(REPO, "no-such-icon-library") },
			stdout: "pipe",
			stderr: "pipe",
		});
		const out = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(out).toContain("icon source not found");
		// And it left the committed markup exactly as it was, which is the half that
		// makes the degradation safe rather than merely quiet.
		expect(readFileSync(generated, "utf8")).toBe(before);
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
	 * the API documentation. Writing an API-fetched SVG into the private library is the
	 * clearest instance of it, so `brand:add` takes the file from `--file` and the
	 * subscription supplies it.
	 *
	 * ⚠️ **This is a test because the violation reintroduces itself.** The download
	 * endpoint also refuses us today (`403 You are not authorized to edit this icon`),
	 * so a reader meeting only that reads a plan limitation and writes a fallback for
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
