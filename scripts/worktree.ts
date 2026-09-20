// SPDX-License-Identifier: Apache-2.0
/**
 * One worktree per task, created and removed the same way from any harness or a plain terminal.
 *
 *   bun run scripts/worktree.ts create signup-page             # .worktrees/signup-page on a new branch
 *   bun run scripts/worktree.ts list                           # every worktree with its branch and state
 *   bun run scripts/worktree.ts remove signup-page             # remove it, refusing on unpushed work
 *
 * The Makefile front doors pass `--from <ref>` and `--force` for the two overrides.
 *
 * A worktree isolates *files and branches* per task, on top of the disposable sessions that
 * isolate *data and processes* per run — the two together are what several agent or human
 * sessions in parallel need, and they were designed together in the worktrees plan. This script
 * is the whole of the harness-agnostic half: it names no tool, so Claude Code, OpenCode, the
 * next harness and a person at a terminal all build the same environment from the same command.
 *
 * 🚨 **The branch is named exactly for the task and tracks nothing.** `--no-track` is load-
 * bearing, not tidy: a branch created from `origin/main` otherwise tracks it, and a bare
 * `git pull` in the worktree would then pull `main` into the task branch. The branch is also a
 * task's identity, so the worktree's directory, its branch and (by convention) the task's name
 * stay one word — there is no `worktree-` prefix, which is the harness's convention rather than
 * this repository's.
 *
 * 🚨 **Removal refuses rather than loses work.** `remove` declines a worktree with uncommitted
 * changes or untracked files, and declines to delete a branch whose work is not already on
 * `origin/main` — judged by a file-level diff, because an Anthers branch squash-merges, after
 * which every commit-level check (`git branch --merged` included) reports it as unmerged
 * forever. The single failure in this design that costs real work is a removal that deletes
 * unpushed work, so both refusals list what they found rather than assuming `--force`.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const SCRIPT_DIR = import.meta.dir;

/** Where worktrees nest, relative to the main checkout — overridable for a sibling layout. */
const WORKTREES_DIR = process.env.WORKTREES ?? ".worktrees";
const INCLUDE_FILE = ".worktreeinclude";

/** A name may be lowercase letters, digits and hyphens — safe as a directory and a branch. */
const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Git refuses to run a repository command while another repository's hook environment is set —
 * `GIT_DIR`/`GIT_WORK_TREE` (and friends) from a pre-push hook redirect every `git` at the repo
 * that pushed, not the one this script means. A worktree created in the middle of somebody's
 * push therefore has to scrub them, or `git rev-parse` answers about the wrong repository.
 */
function cleanGitEnv(): Record<string, string> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("GIT_"),
		),
	);
}

function run(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync(args, { cwd, env: cleanGitEnv() });
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout.toString().trim(),
		// git prints worktree progress ("Preparing worktree", "HEAD is now at …") to stderr even
		// on success, so this is not only an error channel.
		stderr: result.stderr.toString().trim(),
	};
}

const git = (cwd: string, ...args: string[]) => run(["git", ...args], cwd);

/** The main repository's `.git`, from inside any worktree of it. */
function gitCommonDir(from: string): string {
	const result = git(from, "rev-parse", "--git-common-dir");
	if (!result.ok) {
		throw new Error(
			`not inside a git repository reachable from ${from}: ${result.stderr || result.stdout}`,
		);
	}
	return resolve(from, result.stdout);
}

/** The main checkout's root — the directory this repository's real `.git` lives in. */
export function mainRoot(from: string): string {
	return dirname(gitCommonDir(from));
}

/** Where a named worktree would live, whether or not it exists yet. */
export function worktreePath(root: string, name: string): string {
	return join(root, WORKTREES_DIR, name);
}

/**
 * 🚨 **A name may not end in `-Wiki`.** The vault tooling identifies a wiki by that suffix, and
 * a worktree named `foo-Wiki` would be discovered as one — and scanned as a vault it is not.
 */
export function validateName(name: string): void {
	if (name.toLowerCase().endsWith("-wiki")) {
		throw new Error(
			`invalid worktree name "${name}" — a name ending in "-Wiki" is discovered as a vault ` +
				`by the wiki tooling, so a worktree must not carry the suffix`,
		);
	}
	if (!NAME_PATTERN.test(name)) {
		throw new Error(
			`invalid worktree name "${name}" — use lowercase letters, digits and hyphens only`,
		);
	}
}

interface PorcelainEntry {
	path: string;
	branch: string;
	detached: boolean;
}

/** `git worktree list --porcelain`, parsed into one record per worktree. */
export function listWorktrees(root: string): PorcelainEntry[] {
	const result = git(root, "worktree", "list", "--porcelain");
	if (!result.ok) throw new Error(`git worktree list failed: ${result.stderr}`);
	const entries: PorcelainEntry[] = [];
	for (const block of result.stdout.split("\n\n")) {
		if (!block.trim()) continue;
		let path = "";
		let branch = "";
		let detached = false;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
			else if (line.startsWith("branch ")) branch = line.slice("branch refs/heads/".length);
			else if (line === "detached") detached = true;
		}
		if (path) entries.push({ path, branch, detached });
	}
	return entries;
}

/** The gitignored files a fresh worktree cannot get from git, listed in `.worktreeinclude`. */
function includedFiles(root: string): string[] {
	const file = join(root, INCLUDE_FILE);
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

function copyIncluded(root: string, target: string, log: (line: string) => void): void {
	for (const rel of includedFiles(root)) {
		const source = join(root, rel);
		if (!existsSync(source)) continue;
		const dest = join(target, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(source, dest);
		log(`[worktree] copied ${rel}`);
	}
}

/** Bun hardlinks packages from its global cache, so this is seconds rather than minutes. */
function install(target: string, log: (line: string) => void): void {
	// The tests exercise the script against throwaway repositories that have no manifest to
	// install against; the real thing always runs the install.
	if (process.env.WORKTREE_NO_INSTALL) return;
	log("[worktree] bun install…");
	const result = Bun.spawnSync(["bun", "install"], { cwd: target });
	if (result.exitCode !== 0) {
		throw new Error(`bun install failed in ${target}:\n${result.stderr.toString()}`);
	}
}

/**
 * Restore the relative hooks path so each worktree runs its own branch's `pre-push`.
 *
 * A harness's worktree feature (Claude Code's `--worktree`) rewrites `core.hooksPath` to an
 * absolute path into the main checkout, which would make this worktree verify whatever branch
 * the main checkout holds. Pointing it back at the relative `.githooks` — which git resolves
 * from the worktree's own root — keeps each branch's own hook in force.
 */
function restoreHooksPath(target: string, log: (line: string) => void): void {
	const current = git(target, "config", "--local", "core.hooksPath");
	if (current.ok && current.stdout !== "" && current.stdout !== ".githooks") {
		git(target, "config", "--local", "core.hooksPath", ".githooks");
		log(`[worktree] hooks path → .githooks (was ${current.stdout})`);
	}
}

/**
 * Create a worktree, or finish a half-made / reopen an existing one.
 *
 * Idempotent by design: running it again on a worktree that already exists reattaches it,
 * re-copies the included files and re-runs the install, finishing whichever steps are missing
 * rather than failing on the ones already done.
 */
export function createWorktree(
	name: string,
	opts: { from?: string; cwd?: string; log?: (line: string) => void } = {},
): string {
	validateName(name);
	const log = opts.log ?? (() => {});
	const cwd = opts.cwd ?? SCRIPT_DIR;
	const root = mainRoot(cwd);
	const target = worktreePath(root, name);
	mkdirSync(dirname(target), { recursive: true });

	if (existsSync(target)) {
		log(`[worktree] ${name} already exists — reopening it`);
	} else {
		const branches = listWorktrees(root);
		const holder = branches.find((w) => w.branch === name);
		if (holder) {
			throw new Error(
				`branch "${name}" is already checked out in ${holder.path} — ` +
					`pick it up there, or remove that worktree first`,
			);
		}
		// A branch by this name that no worktree holds belongs to a paused task: reattach to it
		// rather than `-b`-creating it anew (which git would refuse as a duplicate).
		const branchExists = git(root, "rev-parse", "--verify", "--quiet", name).ok;
		const base = opts.from ?? "origin/main";
		let add: { ok: boolean; stdout: string; stderr: string };
		if (branchExists) {
			add = git(root, "worktree", "add", target, name);
		} else {
			// --no-track: see the header. Without it the new branch tracks origin/main and a bare
			// `git pull` in the worktree pulls main into the task branch.
			git(root, "fetch", "origin", "main");
			add = git(root, "worktree", "add", "--no-track", "-b", name, target, base);
		}
		if (!add.ok) {
			throw new Error(`git worktree add failed:\n${add.stderr || add.stdout}`);
		}
		log(
			branchExists
				? `[worktree] reattached ${target} to the existing branch ${name}`
				: `[worktree] created ${target} on branch ${name} from ${base}`,
		);
	}

	copyIncluded(root, target, log);
	install(target, log);
	restoreHooksPath(target, log);
	return target;
}

/** What `remove` refuses to lose without `--force`. */
export interface RemovalBlockers {
	dirty: string[];
	untracked: string[];
	/** True when the branch's tree differs from origin/main and it was not force-allowed. */
	notOnMain: boolean;
	unmergedCommits: string[];
}

export function inspectForRemoval(root: string, name: string, force: boolean): RemovalBlockers {
	const target = worktreePath(root, name);
	const status = git(target, "status", "--porcelain");
	if (!status.ok) throw new Error(`git status failed in ${target}: ${status.stderr}`);
	const dirty: string[] = [];
	const untracked: string[] = [];
	for (const line of status.stdout.split("\n")) {
		if (!line) continue;
		if (line.startsWith("?? ")) untracked.push(line.slice(3));
		else dirty.push(line);
	}

	git(root, "fetch", "origin", "main");
	// A squash-merged branch reads as unmerged to every commit-level check, so the question is
	// whether the branch's TREE differs from origin/main, not whether its commits landed.
	const treeDiff = git(target, "diff", "--quiet", "origin/main", name);
	const notOnMain = !treeDiff.ok && !force;
	// Names the commits that exist nowhere on the remote, for the message when the branch survives.
	const unpushed = git(target, "log", "--oneline", `origin/main..${name}`);
	const unmergedCommits = unpushed.ok && unpushed.stdout !== "" ? unpushed.stdout.split("\n") : [];

	const blocked = force ? { dirty: [], untracked: [] } : { dirty, untracked };
	return { ...blocked, notOnMain, unmergedCommits };
}

/**
 * Remove a worktree and, when its work is already on `origin/main`, its branch.
 *
 * 🚨 **Break this on purpose before you trust it** — the tests do. A removal that deletes
 * unpushed work is the one failure in this design that costs real work, so the refusal path is
 * the one tested hardest.
 */
export function removeWorktree(
	name: string,
	opts: { force?: boolean; cwd?: string; log?: (line: string) => void } = {},
): { branchDeleted: boolean; message: string } {
	validateName(name);
	const log = opts.log ?? (() => {});
	const force = opts.force ?? false;
	const cwd = opts.cwd ?? SCRIPT_DIR;
	const root = mainRoot(cwd);
	const target = worktreePath(root, name);

	if (!existsSync(target)) {
		throw new Error(`no worktree at ${target}`);
	}

	const blockers = inspectForRemoval(root, name, force);
	if (blockers.dirty.length > 0 || blockers.untracked.length > 0) {
		throw new Error(
			`refusing to remove ${name} — it holds work that would be lost:\n` +
				[...blockers.dirty, ...blockers.untracked.map((p) => `?? ${p}`)]
					.map((l) => `  ${l}`)
					.join("\n") +
				`\ncommit it, or pass --force to discard it`,
		);
	}

	const remove = git(root, "worktree", "remove", target, ...(force ? ["--force"] : []));
	if (!remove.ok) throw new Error(`git worktree remove failed: ${remove.stderr}`);
	log(`[worktree] removed ${target}`);

	let branchDeleted = false;
	let message = `removed ${name}`;
	if (blockers.notOnMain) {
		message +=
			`; kept branch ${name}, whose work is not on origin/main` +
			(blockers.unmergedCommits.length > 0
				? `:\n${blockers.unmergedCommits.map((c) => `  ${c}`).join("\n")}`
				: "");
	} else {
		// A squash-merged branch reads as unmerged, so -d refuses it even when every change
		// landed; the tree diff above is the verdict, and -D carries it out.
		const del = git(root, "branch", "-D", name);
		branchDeleted = del.ok;
		if (del.ok) message += ` and deleted branch ${name} (already on origin/main)`;
	}
	git(root, "worktree", "prune");
	return { branchDeleted, message };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const USAGE =
	"usage:\n" +
	"  bun run scripts/worktree.ts create <name> [--from <ref>]\n" +
	"  bun run scripts/worktree.ts list\n" +
	"  bun run scripts/worktree.ts remove <name> [--force]";

function parse(argv: string[]) {
	const command = argv[0];
	const positional = argv.filter((a) => !a.startsWith("--"));
	const fromIndex = argv.indexOf("--from");
	return {
		command,
		name: positional[1],
		from: fromIndex === -1 ? undefined : argv[fromIndex + 1],
		force: argv.includes("--force"),
	};
}

function main(): number {
	const { command, name, from, force } = parse(process.argv.slice(2));
	if (command === "create") {
		if (!name) throw new Error(USAGE);
		const target = createWorktree(name, { from, log: console.log });
		console.log(`\nworktree ready: ${target}`);
		console.log(`  branch: ${name}`);
		console.log(`  next:   cd ${target}`);
		return 0;
	}
	if (command === "list") {
		for (const w of listWorktrees(mainRoot(SCRIPT_DIR))) {
			const label = w.detached ? "(detached)" : w.branch;
			console.log(`${w.path}\t${label}`);
		}
		return 0;
	}
	if (command === "remove") {
		if (!name) throw new Error(USAGE);
		const { message } = removeWorktree(name, { force, log: console.log });
		console.log(message);
		return 0;
	}
	throw new Error(USAGE);
}

if (import.meta.main) {
	try {
		process.exit(main());
	} catch (err) {
		console.error(`[worktree] ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}
