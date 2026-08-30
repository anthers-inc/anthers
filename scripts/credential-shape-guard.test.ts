// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Nothing tracked in this repository may look like a real credential.
 *
 * 🚨 **This exists because it already happened.** On 2026-08-26 a test fixture in
 * `standard-webhooks.test.ts` used `whsec_` followed by 32 alphanumerics — Stripe's
 * webhook-secret format exactly. The string was invented and nothing had leaked, but this
 * is a **public** repository, so GitHub secret scanning fired and a person had to stop and
 * verify every real secret against it before anyone could know that.
 *
 * ⭐ **The cost of a false positive is the point, not a reason to shrug.** It spends
 * someone's attention on a non-event, and a scanner that cries wolf teaches people to wave
 * the next alert through — which is expensive exactly once, on the day the alert is real.
 * So the rule is not "do not commit secrets", which everyone already agrees with; it is
 * **do not commit strings shaped like secrets**, which is easy to do by accident while
 * writing a fixture.
 *
 * ⚠️ **A guard, not a scanner.** GitHub's own secret scanning is the real defense and runs
 * against the pushed repository; this catches the same class before it ever gets there, on
 * the machine that wrote it. It knows only the formats this project actually handles —
 * Stripe, Resend, AWS-style keys — and a pattern for a vendor we do not use would be
 * decoration. Add one when a vendor is added.
 *
 * The patterns below are assembled from fragments so that this file does not match itself.
 * That is not obfuscation to hide from a scanner: the whole file is about the patterns, so
 * a literal here would be a guaranteed false positive in the one place that cannot afford
 * one.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");

/** Extensions worth scanning — source and config, not lockfiles or binaries. */
const SCANNED = /\.(ts|tsx|js|jsx|json|yaml|yml|md|sh|sql|toml|env\.example)$/;

/**
 * Tracked files that carry no extension at all, matched by name.
 *
 * 🚨 **`SCANNED` requires a dot, so every one of these was invisible until 2026-08-30** —
 * and a Dockerfile is among the likeliest places in a repository to paste a credential,
 * because `ENV` and `ARG` read as configuration rather than as source and both images here
 * are built in CI with a real secret in scope. The extension was never the point; the
 * question is whether a person edits the file as text, and all of these are edited as text.
 *
 * Matched on the **basename** so a Dockerfile added under a new path is covered on the day
 * it is added rather than on the day somebody remembers this list.
 */
const SCANNED_NAMES = new Set(["Dockerfile", "Makefile", "pre-push", "pre-commit"]);

function isScanned(path: string): boolean {
	return SCANNED.test(path) || SCANNED_NAMES.has(path.split("/").pop() ?? "");
}

/**
 * Credential formats this project actually handles.
 *
 * Each is built from parts so the pattern never appears whole in this file. `SAFE` marks
 * the substrings a deliberate placeholder uses, which is how a fixture declares itself.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
	{ name: "Stripe webhook secret", re: new RegExp(`wh${"sec"}_[A-Za-z0-9]{24,}`) },
	{ name: "Stripe live secret key", re: new RegExp(`sk${"_live_"}[A-Za-z0-9]{16,}`) },
	{ name: "Stripe live restricted key", re: new RegExp(`rk${"_live_"}[A-Za-z0-9]{16,}`) },
	{ name: "Stripe test secret key", re: new RegExp(`sk${"_test_"}[A-Za-z0-9]{16,}`) },
	{ name: "Resend API key", re: new RegExp(`re${"_"}[A-Za-z0-9]{8}_[A-Za-z0-9]{16,}`) },
	{ name: "AWS access key id", re: new RegExp(`AK${"IA"}[0-9A-Z]{16}`) },
	{ name: "Bitwarden access token", re: /0\.[0-9a-f-]{36}\.[A-Za-z0-9+/=]{40,}/ },
];

/**
 * A placeholder announces itself. Any candidate containing one of these is a fixture
 * rather than a credential — which is the convention this guard is asking people to
 * follow, and the reason a fixture should never be a plausible random string.
 */
const PLACEHOLDER_MARKERS = ["EXAMPLE", "PLACEHOLDER", "REDACTED", "not_a_real", "FAKE", "xxxx"];

function trackedFiles(): string[] {
	const out = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
	return out.split("\n").filter((f) => f && isScanned(f));
}

describe("nothing tracked looks like a credential", () => {
	it("finds files to scan at all, so a broken walk cannot pass silently", () => {
		// Guard the guard. A scan that silently matched nothing would be a green test
		// asserting the absence of everything, which is the failure mode this whole file
		// is about.
		const files = trackedFiles();
		expect(files.length).toBeGreaterThan(200);
	});

	it("🚨 reaches the extensionless files too, which a dot-anchored pattern cannot", () => {
		// A total over hundreds of files says nothing about whether the four files with no
		// extension were among them, and those are the ones a `\.(…)$` pattern structurally
		// cannot reach. Named individually rather than counted, because the point is which
		// files are covered rather than how many.
		const files = trackedFiles();
		for (const path of ["apps/api/Dockerfile", "Makefile"]) {
			expect(files, `${path} is not being scanned`).toContain(path);
		}
	});

	it("🚨 still recognizes each format it claims to watch, so a pattern cannot rot", () => {
		/*
		 * Guard the guard, the other way round. The corpus check above proves files were
		 * read; this proves the patterns can still see anything in them. Without it, a
		 * broken escape or a changed fragment leaves every pattern matching nothing and the
		 * guard reports a clean repository forever — which is indistinguishable from
		 * working, and was the actual state: disabling all seven patterns kept this file
		 * green.
		 *
		 * ⚠️ **The samples are assembled at runtime and are runs of one character**, for the
		 * same reason the patterns are: a plausible-looking literal here would be a real
		 * finding for GitHub's own scanner in the one file that cannot afford one.
		 */
		const samples: Record<string, string> = {
			"Stripe webhook secret": `wh${"sec"}_${"a".repeat(24)}`,
			"Stripe live secret key": `sk${"_live_"}${"a".repeat(16)}`,
			"Stripe live restricted key": `rk${"_live_"}${"a".repeat(16)}`,
			"Stripe test secret key": `sk${"_test_"}${"a".repeat(16)}`,
			"Resend API key": `re${"_"}${"a".repeat(8)}_${"a".repeat(16)}`,
			"AWS access key id": `AK${"IA"}${"A".repeat(16)}`,
			"Bitwarden access token": `0.${"a".repeat(36)}.${"a".repeat(40)}`,
		};
		// Every pattern needs a sample, so adding a format without one is a failure rather
		// than a silent hole in the liveness check itself.
		expect(Object.keys(samples).sort()).toEqual(PATTERNS.map((p) => p.name).sort());
		for (const { name, re } of PATTERNS) {
			expect(re.test(samples[name]), `${name} no longer matches its own format`).toBe(true);
		}
	});

	it("carries no string shaped like a real secret", () => {
		const offenders: string[] = [];
		for (const file of trackedFiles()) {
			// This file names every pattern by construction; skipping it is safe because the
			// fragments above mean it contains no whole match to find.
			if (file.endsWith("credential-shape-guard.test.ts")) continue;
			let content: string;
			try {
				content = readFileSync(join(REPO_ROOT, file), "utf8");
			} catch {
				continue; // Unreadable or binary — nothing to scan.
			}
			for (const { name, re } of PATTERNS) {
				const hit = re.exec(content);
				if (!hit) continue;
				// A marked placeholder is the convention working, not a violation.
				if (PLACEHOLDER_MARKERS.some((m) => hit[0].includes(m))) continue;
				offenders.push(`${file}: looks like a ${name} (${hit[0].slice(0, 12)}…)`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
