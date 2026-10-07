// SPDX-License-Identifier: Apache-2.0
/**
 * The gate that ties the release notes to the promote: every released version must
 * have an entry in `apps/web/src/content/release-notes.ts`.
 *
 * 🚨 **This is the first step of CI's deploy job, before the deploy itself.** The
 * release-notes pass is judgment, and judgment that is not scheduled silently stops
 * happening — which is exactly what happened: 2026.10.10 shipped with no entry, and
 * anything written after a promote would not reach users until the *next* promote
 * carried it. Making the entry a deploy precondition closes both gaps at once: the
 * entry rides the version bump's PR (where the audit's failure names it), the promote
 * carries version, entry and deployment together, and a re-run self-heals — adding the
 * missing entry to the release already on the tag is the remedy, so the gate passes
 * on the second attempt without any state to unwind.
 *
 * What it reads:
 *   - the calver tags on `origin`, from git (`git ls-remote` — the checkout is shallow
 *     and a promote's tags may postdate it);
 *   - the versions in `release-notes.ts`, from the source, by the same awk shape the
 *     tag step uses rather than an import — so the check cannot be defeated by a
 *     bundler detail of how the module is loaded;
 *   - which GitHub release is `latest` (informational only).
 *
 * A tag with no entry exits 1 and names the version and the remedy. A version with an
 * entry but no tag exits 0 with a note — that is the bump PR itself, checked in CI
 * before it merges, where the discrepancy is exactly the signal wanted.
 *
 * Run by hand as `bun run scripts/release-notes-audit.ts`; wired into `.github/workflows/ci.yml`.
 */
import { readFileSync } from "node:fs";

const NOTES_FILE = "apps/web/src/content/release-notes.ts";

function fail(message: string): never {
	console.error(`release-notes-audit: ${message}`);
	process.exit(1);
}

/** The checkouts of the versions the content module declares, in file order. */
function declaredVersions(): string[] {
	let source: string;
	try {
		source = readFileSync(NOTES_FILE, "utf8");
	} catch {
		return fail(`could not read ${NOTES_FILE}`);
	}
	const versions = [...source.matchAll(/version: "([^"]+)"/g)].map((m) => m[1]);
	if (versions.length === 0) {
		fail(`${NOTES_FILE} declares no versions — the page would render nothing.`);
	}
	return versions;
}

/** The calver tags on origin, newest last. */
function releasedTags(): string[] {
	const out = Bun.spawnSync(["git", "ls-remote", "--tags", "origin", "refs/tags/v*"]);
	if (out.exitCode !== 0) {
		return fail(`git ls-remote failed: ${new TextDecoder().decode(out.stderr).trim()}`);
	}
	return new TextDecoder()
		.decode(out.stdout)
		.split("\n")
		.filter((line) => /refs\/tags\/v\d{4}\.\d{1,2}\.\d+$/.test(line.trim()))
		.map((line) =>
			line
				.trim()
				.match(/refs\/tags\/(v\d{4}\.\d{1,2}\.\d+)$/)?.[1]
				?.replace(/^v/, ""),
		)
		.filter((v): v is string => Boolean(v))
		.sort();
}

const released = releasedTags();
const declared = declaredVersions();

// A version may be declared only once — the page forbids duplicates too, but the
// audit says so in its own terms, against the released set rather than the page's.
const duplicate = declared.filter((v, i) => declared.indexOf(v) !== i);
if (duplicate.length > 0) {
	fail(`${NOTES_FILE} declares ${duplicate[0]} more than once — a version is one release.`);
}

const declaredSet = new Set(declared);
const missing = released.filter((tag) => !declaredSet.has(tag));

if (missing.length > 0) {
	console.error(
		`release-notes-audit: ${missing.length} released version${missing.length === 1 ? " has" : "s have"} no entry in ${NOTES_FILE}:`,
	);
	for (const version of missing) {
		console.error(`  v${version} — released on GitHub, absent from /release-notes`);
	}
	console.error("");
	console.error("Remedy: write the missing entries (the anthers-release-notes skill's pass),");
	console.error("commit them to the version bump's PR, and re-run this gate. A re-run converges —");
	console.error("nothing has deployed, so there is nothing to unwind.");
	process.exit(1);
}

const taggedSet = new Set(released);
const ahead = declared.filter((v) => !taggedSet.has(v));
console.log(
	`release-notes-audit: ${released.length} released versions, all present in ${NOTES_FILE} ✓`,
);
if (ahead.length > 0) {
	console.log(
		`release-notes-audit: note — ${ahead.map((v) => `v${v}`).join(", ")} ${
			ahead.length === 1
				? "has an entry but no tag yet (the bump PR's own version; expected)"
				: "have entries but no tags yet (the bump PR's own versions; expected)"
		}`,
	);
}
