// SPDX-License-Identifier: Apache-2.0
/**
 * The radar — a read-only pairwise conflict report over every in-flight entry, so the
 * landing front half sees textual collisions while they are still local work.
 *
 * The radar's reach is textual by construction: `git merge-tree --write-tree` composes
 * two heads and reports whether the composition conflicts and on which paths. It cannot
 * see a rename that makes one branch's new caller stop matching another's export — that
 * class is the gate's to catch, in the arm ceremony, and the design document carries the
 * division. What the radar gives the pipeline is the earlier, cheaper half: a branch that
 * would collide with an armed entry is held before it arms into a doomed queue slot,
 * instead of discovering the collision at GitHub's expense.
 *
 * **The in-flight set** is the union of remote branches with open PRs and local worktree
 * branches, taken by branch name. When a branch has both, the head tested is the
 * worktree's HEAD — the furthest committed state on this machine, which is what the next
 * push will carry — and the pr is kept for display; with only one side, that side's head
 * is tested. This is why the report reads the same whichever side runs it: one machine
 * holds every branch, so the local and remote views are two names for the same set.
 *
 * **Authority lives at the callsite, not here.** The radar reports; it holds nothing. In
 * the design's steps 1–2 it runs in shadow mode — findings are recorded and nobody waits
 * on them — and the flip to blocking authority is the single edit to
 * `RADAR_HOLD_BLOCKING` below, made as stage three after the shadow week's ledger. The
 * ceremony passes the mode through so every `radar-run` event records which regime was
 * live when it ran.
 *
 * The output format that the conflict parser reads is pinned empirically on this
 * machine's git (2.43.0, 2026-10-14): a clean pair prints the merged tree OID alone and
 * exits 0; a conflicted pair exits 1 and prints the tree OID, then one conflicted path
 * per line, then a blank line, then human messages ("Auto-merging …", "CONFLICT …");
 * and a pair git cannot test at all (a missing head) also exits 1 — but with nothing on
 * stdout, which is the line between the two: a conflict is status 1 with a tree OID,
 * anything else with a nonzero status is an untestable error the report shows rather
 * than hides. Parsing therefore reads the lines between the first and the first blank. A future git
 * that changes this shape fails the tests that run real `merge-tree` calls in fixtures,
 * which is the notice this file needs to be re-pinned.
 */

import { spawnSync } from "node:child_process";
import {
	appendEvent,
	armedLedger,
	type EntryRef,
	type LandingEvent,
	type RadarEntry,
	type RadarFinding,
	type RadarMode,
	type RadarRunEvent,
	type RadarScope,
	readEvents,
} from "./landing-log.ts";

/** The repository every GitHub call is pinned to — the finisher's hygiene applies to the radar too. */
export const REPO = "anthers-inc/anthers";

/**
 * The flip point for the radar's hold authority. `false` through the shadow week; stage
 * three edits this to `true`, once the ledger holds a week of would-have-held data. This
 * is deliberately a constant rather than configuration: the authority flip is a decision
 * taken on evidence by a commit, not a switch a session can flip by exporting a variable.
 */
export const RADAR_HOLD_BLOCKING = false;

export function authorityMode(): RadarMode {
	return RADAR_HOLD_BLOCKING ? "blocking" : "shadow";
}

export interface RadarOptions {
	/** The repository root the git calls run in (a worktree works). */
	cwd?: string;
	/** Which regime to record on the report; defaults to `authorityMode()`. Tests pass one. */
	mode?: RadarMode;
	/** Fetch `origin` first so the PR heads are current (default true). */
	fetch?: boolean;
	/** Read open PRs from GitHub (default true). Tests turn it off. */
	useGh?: boolean;
	/** The event log's path, passed through to the ledger read (tests). */
	logPath?: string;
	/** Injected PR list, for tests; when absent and `useGh`, GitHub is asked. */
	prs?: GhPr[];
	/** Now, overridable for tests. */
	now?: Date;
}

export interface RadarReport {
	generated: string;
	mode: RadarMode;
	entries: RadarEntry[];
	findings: RadarFinding[];
	errors: { a: RadarEntry; b: RadarEntry; message: string }[];
	warnings: string[];
}

interface GhPr {
	number: number;
	headRefName: string;
	headRefOid: string;
}

export type { GhPr };

/**
 * Git's environment, stripped of `GIT_*` variables — the same trap `verify-stamp`'s
 * `gitEnv` documents: inside a hook or a session-spawned child, `GIT_DIR` can point into
 * another checkout's gitdir, and a radar that consulted the wrong tree would misreport
 * conflicts that do not exist.
 */
function gitEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

/** Open PRs with their head refs and OIDs. A failed call is a warning, not a report-stopper — the caller decides whether to arm without the GitHub half. */
function ghPrEntries(): { entries: GhPr[]; warning?: string } {
	const result = spawnSync(
		"gh",
		["pr", "list", "-R", REPO, "--state", "open", "--json", "number,headRefName,headRefOid"],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 || !result.stdout) {
		return {
			entries: [],
			warning: `gh pr list failed (${(result.stderr ?? "no output").split("\n")[0]})`,
		};
	}
	try {
		return { entries: JSON.parse(result.stdout) as GhPr[] };
	} catch (error) {
		return {
			entries: [],
			warning: `gh pr list returned unparseable JSON (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

/** Branches checked out in worktrees on this machine, with their HEAD shas. Detached and bare worktrees contribute nothing. */
function localWorktreeEntries(cwd: string): { branch: string; head: string }[] {
	const { stdout, status } = git(["worktree", "list", "--porcelain"], cwd);
	if (status !== 0 || !stdout) return [];
	const entries: { branch: string; head: string }[] = [];
	let branch: string | undefined;
	let head: string | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			// A new record begins; the previous one is complete when it named a branch.
			if (branch && head) entries.push({ branch, head });
			branch = undefined;
			head = undefined;
		} else if (line.startsWith("branch refs/heads/")) {
			branch = line.slice("branch refs/heads/".length);
		} else if (line.startsWith("HEAD ")) {
			head = line.slice("HEAD ".length);
		}
	}
	if (branch && head) entries.push({ branch, head });
	return entries;
}

export interface UnionEntry {
	pr?: number;
	branch: string;
	head: string;
}

/**
 * The in-flight set: gh's PR branches and the local worktree branches, unioned by branch
 * name. When both sides name the branch, the worktree's head wins (it is the furthest
 * committed state; the docblock carries the reasoning) and the pr is kept. The result is
 * sorted by branch so pair construction is deterministic and, being over unordered
 * pairs, symmetric.
 */
export function inFlightEntries(
	prs: GhPr[],
	worktrees: { branch: string; head: string }[],
): UnionEntry[] {
	const byBranch = new Map<string, UnionEntry>();
	for (const worktree of worktrees) {
		byBranch.set(worktree.branch, { branch: worktree.branch, head: worktree.head });
	}
	for (const pr of prs) {
		const existing = byBranch.get(pr.headRefName);
		if (existing) {
			existing.pr = pr.number;
		} else {
			byBranch.set(pr.headRefName, { pr: pr.number, branch: pr.headRefName, head: pr.headRefOid });
		}
	}
	return [...byBranch.values()].sort((a, b) => a.branch.localeCompare(b.branch));
}

/**
 * Every unordered pair, tested both ways is one test: `merge-tree` is asymmetric in
 * ours/theirs detail but a conflict is a conflict from either side, so each pair runs
 * once. Exit 0 is clean; exit 1 is the conflict format the docblock pins; anything else
 * is an error the report shows rather than hides.
 */
/** Exported for the tests, which can fabricate heads a fixture cannot: an untestable pair must surface as an error, never a silent clean. */
export function pairwise(
	entries: UnionEntry[],
	cwd: string,
): { findings: RadarFinding[]; errors: { a: UnionEntry; b: UnionEntry; message: string }[] } {
	const findings: RadarFinding[] = [];
	const errors: { a: UnionEntry; b: UnionEntry; message: string }[] = [];
	for (let i = 0; i < entries.length; i++) {
		for (let j = i + 1; j < entries.length; j++) {
			const a = entries[i]!;
			const b = entries[j]!;
			const result = git(["merge-tree", "--write-tree", "--name-only", a.head, b.head], cwd);
			if (result.status === 1 && result.stdout.trim() !== "") {
				findings.push({ a: { ...a }, b: { ...b }, paths: conflictedPaths(result.stdout) });
			} else if (result.status !== 0) {
				const message =
					(result.stderr || result.stdout || "no output").split("\n").filter(Boolean)[0] ?? "";
				errors.push({ a: { ...a }, b: { ...b }, message: message.slice(0, 200) });
			}
		}
	}
	return { findings, errors };
}

/** The conflicted paths: the lines between the tree OID and the blank line that ends the conflicts section (the pinned format's only stable boundary). */
function conflictedPaths(mergeTreestdout: string): string[] {
	const lines = mergeTreestdout.split("\n");
	const paths: string[] = [];
	for (const line of lines.slice(1)) {
		if (line.trim() === "") break;
		paths.push(line);
	}
	return paths.filter((path) => path !== "");
}

interface ArmedByNumber {
	rankByBranch: Map<string, { rank: number; pr: number }>;
}

/** Arm order for the report: armed entries by pr, ordered by arm time, mapped onto in-flight entries by branch. */
function armedRanks(events: LandingEvent[]): ArmedByNumber {
	const rankByBranch = new Map<string, { rank: number; pr: number }>();
	armedLedger(events)
		.sort((a, b) => a.armedAt.localeCompare(b.armedAt))
		.forEach((entry, index) => {
			rankByBranch.set(entry.branch, { rank: index + 1, pr: entry.pr });
		});
	return { rankByBranch };
}

/** Compose the `radar-run` event a caller appends to the ledger, without the caller rebuilding the shape. */
export function toRadarRunEvent(
	report: RadarReport,
	scope: RadarRunEvent["scope"],
): Omit<RadarRunEvent, "ts"> {
	return {
		event: "radar-run",
		scope,
		mode: report.mode,
		entries: report.entries,
		findings: report.findings,
		errors: report.errors,
	};
}

export function runRadar(options: RadarOptions = {}): RadarReport {
	const cwd = options.cwd ?? process.cwd();
	const mode = options.mode ?? authorityMode();
	const warnings: string[] = [];

	if (options.fetch !== false) {
		const fetched = git(["fetch", "origin"], cwd);
		if (fetched.status !== 0)
			warnings.push(
				`git fetch origin failed: ${fetched.stderr.split("\n").filter(Boolean)[0] ?? ""}`,
			);
	}

	let prList: GhPr[] = [];
	if (options.prs) {
		prList = options.prs;
	} else if (options.useGh !== false) {
		const { entries, warning } = ghPrEntries();
		prList = entries;
		if (warning) warnings.push(warning);
	}
	const worktrees = localWorktreeEntries(cwd);
	const union = inFlightEntries(prList, worktrees);
	const { findings, errors } = pairwise(union, cwd);

	const events = readEvents(options.logPath ? { path: options.logPath } : {}).events;
	const ranks = armedRanks(events);
	const entryShape = (entry: UnionEntry): RadarEntry => ({
		pr: entry.pr,
		branch: entry.branch,
		head: entry.head,
		armedRank: entry.pr !== undefined ? (ranks.rankByBranch.get(entry.branch)?.rank ?? null) : null,
	});

	return {
		generated: (options.now ?? new Date()).toISOString(),
		mode,
		entries: union.map(entryShape),
		findings,
		errors: errors.map((error) => ({
			a: entryShape(error.a),
			b: entryShape(error.b),
			message: error.message,
		})),
		warnings,
	};
}

/** The report as a session reads it: one summary line, findings with their paths, errors and warnings beneath. */
export function summarize(report: RadarReport): string[] {
	const lines = [
		`→ the landing radar (${report.mode} mode): ${report.entries.length} entries in flight, ${report.entries.filter((entry) => entry.armedRank !== null).length} armed, ${report.findings.length} textual collision(s)`,
	];
	for (const finding of report.findings) {
		lines.push(
			`  ✱ collision: ${describe(finding.a)} ↔ ${describe(finding.b)} — ${finding.paths.slice(0, 6).join(", ")}${finding.paths.length > 6 ? `, and ${finding.paths.length - 6} more` : ""}`,
		);
	}
	for (const error of report.errors) {
		lines.push(
			`  ⚠ untestable pair: ${describe(error.a)} ↔ ${describe(error.b)} — ${error.message}`,
		);
	}
	for (const warning of report.warnings) {
		lines.push(`  ⚠ ${warning}`);
	}
	if (report.findings.length === 0 && report.errors.length === 0)
		lines.push("  the in-flight set is textually clean");
	if (report.mode === "shadow") lines.push("  shadow week: findings are recorded, nothing is held");
	return lines;
}

function describe(entry: EntryRef & { armedRank?: number | null }): string {
	const pr = entry.pr !== undefined ? `#${entry.pr} ` : "";
	const rank = entry.armedRank !== null ? ` (armed ${entry.armedRank})` : "";
	return `${pr}${entry.branch}@${entry.head.slice(0, 7)}${rank}`;
}

interface RadarCliOptions {
	/** The ledger path the CLI's recording writes to (tests pass one). */
	logPath?: string;
	/** Overrides for the underlying radar run (tests pass `useGh: false`); the plain CLI leaves the defaults. */
	runOptions?: Partial<Parameters<typeof runRadar>[0]>;
}

/**
 * The CLI's body, exported so the tests drive it directly with the GitHub side off.
 * One recording rule, from the front-half doc: every run lands on the ledger under its
 * scope — a plain call is a session's own hand run, the probe passes `--scope probe`,
 * and the ceremony keeps appending through its direct `runRadar` call, which is the
 * division that stops one act being recorded twice.
 */
export function radarCli(args: string[], cliOptions: RadarCliOptions = {}): number {
	const json = args.includes("--json");
	const fetch = !args.includes("--no-fetch");
	let scope: RadarScope | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--scope") {
			const value = args[i + 1];
			if (value !== "hand" && value !== "probe") {
				console.error(
					"usage: bun run scripts/landing-radar.ts [--json] [--no-fetch] [--scope hand|probe]",
				);
				return 64;
			}
			scope = value;
			args.splice(i, 2);
			break;
		}
	}
	if (args.some((arg) => !arg.startsWith("--") || !["--json", "--no-fetch"].includes(arg))) {
		console.error(
			"usage: bun run scripts/landing-radar.ts [--json] [--no-fetch] [--scope hand|probe]",
		);
		return 64;
	}
	const report = runRadar({ fetch, ...cliOptions.runOptions });
	appendEvent(
		toRadarRunEvent(report, scope ?? "hand"),
		cliOptions.logPath ? { path: cliOptions.logPath } : {},
	);
	if (json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		for (const line of summarize(report)) console.log(line);
	}
	return 0;
}

async function main(): Promise<number> {
	return radarCli(process.argv.slice(2));
}

if (import.meta.main) {
	process.exit(await main());
}
