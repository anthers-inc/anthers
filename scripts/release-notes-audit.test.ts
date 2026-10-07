// SPDX-License-Identifier: Apache-2.0
/**
 * The release-notes audit's own logic, driven through stubs.
 *
 * The audit exists to refuse a promote whose version has no entry, so the branches
 * that matter are the ones a green deploy never reaches: a released version missing
 * from the module (the gate's whole reason), a duplicate declaration, a malformed or
 * unreadable module, and the healthy pass — including the bump-PR shape, where the
 * module carries an entry for a version the tag does not name yet (expected, exit 0).
 *
 * `git ls-remote` is stubbed rather than pointed at a fixture repo, because the
 * script's real call targets `origin` and the assertion that matters is that tags
 * on the remote — not in the local clone — are what get audited. The stub records
 * its invocation so the test can assert the script asked for the remote's tags.
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "release-notes-audit.ts");
const NOTES_FILE = "apps/web/src/content/release-notes.ts";

/** A `git` whose `ls-remote --tags` answers from a fixture tag list; everything else passes through. */
function stubGit(dir: string, tags: string[]): string {
	const path = join(dir, "git");
	writeFileSync(
		path,
		`#!/usr/bin/env bash
echo "git $*" >> "$RECORDED"
for arg in "$@"; do
	if [ "$arg" = "ls-remote" ]; then
		${tags.map((t) => `printf 'deadbeef\\trefs/tags/${t}\\n'`).join("\n\t\t")}
		exit 0
	fi
done
exec /usr/bin/git "$@"
`,
	);
	chmodSync(path, 0o755);
	return path;
}

async function runAudit(opts: { notes: string; tags: string[] }) {
	const dir = mkdtempSync(join(tmpdir(), "notes-audit-"));
	const gitDir = join(dir, "stubs");
	mkdirSync(gitDir, { recursive: true });
	mkdirSync(join(dir, "apps/web/src/content"), { recursive: true });
	writeFileSync(join(dir, NOTES_FILE), opts.notes);
	const recorded = join(gitDir, "recorded.txt");
	writeFileSync(recorded, "");
	stubGit(gitDir, opts.tags);
	const proc = Bun.spawn(["bun", "run", SCRIPT], {
		cwd: dir,
		env: { ...process.env, PATH: `${gitDir}:${process.env.PATH}`, RECORDED: recorded },
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

const entry = (version: string) =>
	`{ version: "${version}", date: "2026-10-07", lede: "Lede.", entries: ["One."] },\n`;
const moduleWith = (...versions: string[]) =>
	`export const RELEASE_NOTES = [\n${versions.map(entry).join("")}];\n`;

describe("release-notes-audit.ts", () => {
	it("passes when every released tag has an entry", async () => {
		const run = await runAudit({
			notes: moduleWith("2026.10.11", "2026.10.10"),
			tags: ["v2026.10.10", "v2026.10.11"],
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("all present");
		// The audit reads the REMOTE's tags, not a local clone's — that is the point
		// of ls-remote, and the recorded invocation proves it.
		expect(run.recorded).toContain("ls-remote --tags origin");
	});

	it("refuses a released version with no entry, naming it and the remedy", async () => {
		const run = await runAudit({
			notes: moduleWith("2026.10.11"),
			tags: ["v2026.10.10", "v2026.10.11"],
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("v2026.10.10");
		expect(run.stderr).toContain("no entry");
	});

	it("passes the bump-PR shape — an entry for a version not yet tagged is expected, not an error", async () => {
		const run = await runAudit({
			notes: moduleWith("2026.10.12", "2026.10.11"),
			tags: ["v2026.10.11"],
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("no tag yet");
	});

	it("refuses a version declared more than once", async () => {
		const run = await runAudit({
			notes: moduleWith("2026.10.11", "2026.10.11"),
			tags: ["v2026.10.11"],
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("more than once");
	});

	it("refuses a module that declares no versions at all", async () => {
		const run = await runAudit({
			notes: "export const RELEASE_NOTES = [];\n",
			tags: ["v2026.10.11"],
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("declares no versions");
	});
});
