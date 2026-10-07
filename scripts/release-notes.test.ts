// SPDX-License-Identifier: Apache-2.0
/**
 * The raw release notes, and the one mistake they must never make.
 *
 * 🚨 **Release notes that claim the wrong range are worse than none.** The list is the
 * audit trail of what a deploy changed — the public-pass skill edits upward from it,
 * never replaces it, and a release record that includes work shipped in an earlier
 * release (or silently drops the boundary of the first) poisons every layer above it.
 * So the range's base is load-bearing in every case below: the previous calver tag
 * when one exists, `github.event.before` for a first release, and a hard failure when
 * neither exists to diff against.
 *
 * ⭐ **This is why the logic left `ci.yml`.** It was sixty lines of shell embedded in
 * YAML — unreachable by any test, on a repository whose own `deploy-state.ts` exists
 * because untestable branches in deploy tooling had already gone wrong once. The stubs
 * below are a `git` with a fixture repo and a `gh` that answers from a fixture, which
 * is all the script needs to be driven through every branch — including the re-run
 * path (release exists → edit), which a green deploy reaches only via a no-op tag step,
 * and the two failure paths a green deploy can never reach at all.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

const SCRIPT = join(import.meta.dir, "release-notes.sh");

/** The committed constant the checkout carries — the awk the script runs reads this. */
const VERSION_FILE = "packages/shared/src/version.ts";
const VERSION = "2026.10.1";

interface GhAnswers {
	/** Does `gh release view` find the release (the re-run path)? */
	releaseExists?: boolean;
}

/** The fixture checkout the script runs against: real git, real commits, real tags. */
async function fixtureCheckout(): Promise<{ dir: string; baseSha: string; headSha: string }> {
	const dir = mkdtempSync(join(tmpdir(), "release-notes-checkout-"));
	const git = async (...args: string[]) => (await $`git -C ${dir} ${args}`.text()).trim();
	await git("init", "--initial-branch=main");
	await git("config", "user.email", "test@example.com");
	await git("config", "user.name", "test");
	mkdirSync(join(dir, "packages/shared/src"), { recursive: true });
	writeFileSync(join(dir, VERSION_FILE), `export const APP_VERSION = "${VERSION}";\n`);
	await git("add", "-A");
	await git("commit", "-m", "base commit");
	const baseSha = await git("rev-parse", "HEAD");
	writeFileSync(join(dir, "one.txt"), "one");
	await git("add", "-A");
	await git("commit", "-m", "First change (#10)");
	writeFileSync(join(dir, "two.txt"), "two");
	await git("add", "-A");
	await git("commit", "-m", "Second change (#11)");
	const headSha = await git("rev-parse", "HEAD");
	return { dir, baseSha, headSha };
}

/** A `gh` that answers from a fixture. Written as a shell script because that is how
 * the real one is invoked, so the stub exercises the same argument shapes. */
function stubGh(dir: string, answers: GhAnswers): string {
	const path = join(dir, "gh");
	writeFileSync(
		path,
		`#!/usr/bin/env bash
# Record every invocation, so the tests can assert the script called gh the
# way the real release flow does.
echo "gh $*" >> "$RECORDED"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
	${answers.releaseExists ? "exit 0" : "exit 1"}
fi
if [ "$1" = "release" ] && { [ "$2" = "create" ] || [ "$2" = "edit" ]; }; then
	exit 0
fi
exit 1
`,
	);
	chmodSync(path, 0o755);
	return path;
}

/** One run of the script inside the fixture checkout, with stubs on PATH. */
async function runScript(opts: {
	dir: string;
	before?: string;
	tags?: string[];
	releaseExists?: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string; recorded: string }> {
	const binDir = join(tmpdir(), `release-notes-bin-${Date.now()}-${Math.random()}`);
	mkdirSync(binDir);
	const recorded = join(binDir, "recorded.txt");
	writeFileSync(recorded, "");
	stubGh(binDir, { releaseExists: opts.releaseExists });
	// The real git stays available (the fixture repo is real); only gh is stubbed.
	const env = {
		...process.env,
		PATH: `${binDir}:${process.env.PATH}`,
		GITHUB_SHA: (await $`git -C ${opts.dir} rev-parse HEAD`.text()).trim(),
		GITHUB_REPOSITORY: "anthers-inc/anthers",
		BEFORE: opts.before ?? "",
		GH_TOKEN: "test-token",
		RECORDED: recorded,
	};
	const proc = Bun.spawn(["bash", SCRIPT], {
		cwd: opts.dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	return { exitCode, stdout, stderr, recorded: readFileSync(recorded, "utf8") };
}

describe("release-notes.sh", () => {
	it("falls back to the before-SHA when no previous calver tag exists, and reports the range it diffed", async () => {
		const { dir, baseSha } = await fixtureCheckout();
		// First release: no v* tag in the fixture, so the script must fall back to
		// BEFORE, which names the base commit — and the notice reports that exact
		// range, which is what makes the first release's boundary honest.
		const { exitCode, stdout, recorded } = await runScript({ dir, before: baseSha });
		expect(exitCode).toBe(0);
		expect(stdout).toContain(`${baseSha}..`);
		expect(recorded).toContain("release create");
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates the release when it does not exist", async () => {
		const { dir, baseSha } = await fixtureCheckout();
		const { exitCode, recorded } = await runScript({ dir, before: baseSha, releaseExists: false });
		expect(exitCode).toBe(0);
		expect(recorded).toContain("release create");
		expect(recorded).toContain(`v${VERSION}`);
		rmSync(dir, { recursive: true, force: true });
	});

	it("edits the release on a re-run instead of failing", async () => {
		const { dir, baseSha } = await fixtureCheckout();
		const { exitCode, recorded } = await runScript({ dir, before: baseSha, releaseExists: true });
		expect(exitCode).toBe(0);
		// The tag step no-opped on this re-run; the release already exists, and the
		// regenerated list converges on the same content, so edit is correct.
		expect(recorded).toContain("release edit");
		expect(recorded).not.toContain("release create");
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails when no base exists — no previous tag, no before-SHA", async () => {
		const { dir } = await fixtureCheckout();
		const { exitCode, stdout } = await runScript({ dir, before: "" });
		expect(exitCode).not.toBe(0);
		// `fail()` writes the ::error:: workflow command to stdout, which is where
		// Actions surfaces it — the test asserts on the same stream.
		expect(stdout).toContain("No previous calver tag");
		rmSync(dir, { recursive: true, force: true });
	});

	it("fails on empty notes — a release that changed nothing", async () => {
		const { dir, headSha } = await fixtureCheckout();
		// A before-SHA pointing at HEAD itself makes the range empty.
		const { exitCode, stdout } = await runScript({ dir, before: headSha });
		expect(exitCode).not.toBe(0);
		expect(stdout).toContain("is empty");
		rmSync(dir, { recursive: true, force: true });
	});

	it("drops merge commits, whose subjects carry no change information", async () => {
		const { dir, baseSha } = await fixtureCheckout();
		// Add a true two-parent merge commit on top, the pre-squash style the first
		// real batch carried, and confirm its subject never reaches the list. The
		// the notes live in release-body.md, not stdout — assert on the file.
		await $`git -C ${dir} checkout -q -b feature`;
		await $`git -C ${dir} commit --allow-empty -q -m "Merged feature change (#12)"`;
		await $`git -C ${dir} checkout -q main`;
		await $`git -C ${dir} merge --no-ff -q -m "Merge pull request #12 from anthers-inc/feature" feature`;
		const { exitCode } = await runScript({ dir, before: baseSha });
		const body = readFileSync(join(dir, "release-body.md"), "utf8");
		expect(exitCode).toBe(0);
		expect(body).toContain("Merged feature change (#12)");
		expect(body).not.toContain("Merge pull request");
		rmSync(dir, { recursive: true, force: true });
	});
});
