// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The CI dedupe, and the one mistake it must never make.
 *
 * 🚨 **Skipping a run that should have happened is the only failure here that matters.**
 * Running twice is waste; not running is untested code on `main` with a green tick beside
 * it, and nothing downstream would ever say otherwise. So every case below that expects
 * `skip=false` is load-bearing, and the two that expect `skip=true` are the narrow ones.
 *
 * ⭐ **This is why the decision left `ci.yml`.** It was sixty lines of shell embedded in
 * YAML — unreachable by any test, on a repository whose own `deploy-state.ts` exists
 * because untestable branches in deploy tooling had already gone wrong once. The stub
 * below is a `gh` that answers from a fixture, which is all the script needs to be driven
 * through every branch.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "ci-precheck.sh");

interface Answers {
	/** `total_count` for a runs query, keyed by the `head_sha=` in the URL. */
	greenFor?: string[];
	/** PR number → head sha. */
	prHead?: Record<string, string>;
	/** commit sha → tree sha. */
	tree?: Record<string, string>;
}

/**
 * A `gh` that answers from a fixture. Written as a shell script because that is how the
 * real one is invoked, so the stub exercises the same quoting and the same `|| echo 0`
 * fallbacks the script relies on.
 */
function stubGh(dir: string, answers: Answers): string {
	const path = join(dir, "gh");
	const green = (answers.greenFor ?? []).join(" ");
	const prHead = Object.entries(answers.prHead ?? {})
		.map(([pr, sha]) => `${pr}:${sha}`)
		.join(" ");
	const trees = Object.entries(answers.tree ?? {})
		.map(([sha, tree]) => `${sha}:${tree}`)
		.join(" ");
	writeFileSync(
		path,
		`#!/usr/bin/env bash
url="$2"
case "$url" in
  *actions/workflows/ci.yml/runs*)
    sha=$(printf '%s' "$url" | sed -n 's/.*head_sha=\\([^&]*\\).*/\\1/p')
    for g in ${green}; do [ "$g" = "$sha" ] && { echo 1; exit 0; }; done
    echo 0 ;;
  */pulls/*)
    pr=\${url##*/}
    for e in ${prHead}; do
      [ "\${e%%:*}" = "$pr" ] && { echo "\${e#*:}"; exit 0; }
    done
    exit 1 ;;
  */commits/*)
    sha=\${url##*/}
    for e in ${trees}; do
      [ "\${e%%:*}" = "$sha" ] && { echo "\${e#*:}"; exit 0; }
    done
    exit 1 ;;
esac
exit 1
`,
		{ mode: 0o755 },
	);
	chmodSync(path, 0o755);
	return path;
}

async function decide(env: Record<string, string>, answers: Answers = {}): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "precheck-"));
	const outPath = join(dir, "out");
	writeFileSync(outPath, "");
	const proc = Bun.spawn([SCRIPT], {
		env: {
			...process.env,
			GH: stubGh(dir, answers),
			GITHUB_OUTPUT: outPath,
			REPO: "anthers-inc/anthers",
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	expect(code, await new Response(proc.stderr).text()).toBe(0);
	const out = readFileSync(outPath, "utf8").trim();
	return out.replace("skip=", "");
}

describe("the CI dedupe", () => {
	it("always runs a pull request, which is the run everything else defers to", async () => {
		expect(await decide({ EVENT: "pull_request", BRANCH: "some-branch", SHA: "aaa" })).toBe(
			"false",
		);
	});

	it("always runs a push to a branch that is neither main nor release", async () => {
		expect(await decide({ EVENT: "push", BRANCH: "a-feature", SHA: "aaa" })).toBe("false");
	});

	// ── release: keyed on the SHA, because a fast-forward preserves it ─────────

	it("skips a release push whose SHA already passed on main", async () => {
		expect(
			await decide({ EVENT: "push", BRANCH: "release", SHA: "abc" }, { greenFor: ["abc"] }),
		).toBe("true");
	});

	it("🚨 runs a release push that is not a fast-forward, which is what the trigger is for", async () => {
		// A hotfix branch or a cherry-pick pushed straight to release has no run on main,
		// and that push would otherwise be the first time the code was ever checked.
		expect(
			await decide({ EVENT: "push", BRANCH: "release", SHA: "hotfix" }, { greenFor: ["abc"] }),
		).toBe("false");
	});

	// ── main: keyed on the TREE, because a squash merge does not preserve the SHA ──

	it("skips a squash merge whose tree is exactly what the pull request tested", async () => {
		expect(
			await decide(
				{ EVENT: "push", BRANCH: "main", SHA: "squash1", HEAD_MESSAGE: "Do the thing (#118)" },
				{
					prHead: { "118": "prhead1" },
					tree: { prhead1: "T1", squash1: "T1" },
					greenFor: ["prhead1"],
				},
			),
		).toBe("true");
	});

	it("🚨 runs when the trees differ, because main moved and this combination is untested", async () => {
		// The case the whole design turns on. Two independently-green branches can produce
		// a broken tree together, and the merged tree is the only thing that shows it.
		expect(
			await decide(
				{ EVENT: "push", BRANCH: "main", SHA: "squash2", HEAD_MESSAGE: "Do the thing (#118)" },
				{
					prHead: { "118": "prhead1" },
					tree: { prhead1: "T1", squash2: "T2" },
					greenFor: ["prhead1"],
				},
			),
		).toBe("false");
	});

	it("🚨 runs when the pull request has no green run, even with a matching tree", async () => {
		// A run still in progress reads as "not passed" here, which errs toward running
		// twice rather than not at all.
		expect(
			await decide(
				{ EVENT: "push", BRANCH: "main", SHA: "squash1", HEAD_MESSAGE: "Do the thing (#118)" },
				{ prHead: { "118": "prhead1" }, tree: { prhead1: "T1", squash1: "T1" }, greenFor: [] },
			),
		).toBe("false");
	});

	it("🚨 runs a direct push to main, which has no pull request behind it", async () => {
		for (const message of ["Fix it directly", "Merge pull request #118 from x/y", "(#) nope"]) {
			expect(
				await decide({ EVENT: "push", BRANCH: "main", SHA: "direct", HEAD_MESSAGE: message }),
				message,
			).toBe("false");
		}
	});

	it("reads the number off the SUBJECT only, never a body that happens to mention one", async () => {
		// A commit body routinely cites other pull requests — "supersedes (#12)" — and
		// keying on one of those would compare against a tree that has nothing to do with
		// this merge.
		expect(
			await decide(
				{
					EVENT: "push",
					BRANCH: "main",
					SHA: "squash1",
					HEAD_MESSAGE: "Do the thing\n\nSupersedes the approach in (#12)",
				},
				{
					prHead: { "12": "prhead1" },
					tree: { prhead1: "T1", squash1: "T1" },
					greenFor: ["prhead1"],
				},
			),
		).toBe("false");
	});

	it("runs in full when GitHub cannot answer at all", async () => {
		// Every lookup failing must fall to running, never to skipping. An API outage that
		// silently disabled CI would be indistinguishable from CI passing.
		expect(
			await decide({
				EVENT: "push",
				BRANCH: "main",
				SHA: "squash1",
				HEAD_MESSAGE: "Do the thing (#118)",
			}),
		).toBe("false");
	});
});
