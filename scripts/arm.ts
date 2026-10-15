// SPDX-License-Identifier: Apache-2.0
/**
 * The arm ceremony — the landing front half's gate, run in place of today's bare
 * enqueue: fetch, reconcile the arm ledger, radar, construct the projected tip, the
 * whole suite against that tip, and only then arm the pull request and hand the receipt
 * back to the calling session. Usage: `bun run scripts/arm.ts <PR number>` (also
 * `make arm PR=<n>`; the `/arm` command front door is the session's path).
 *
 * The gate is `make verify` — typecheck, lint, the unit suites and the full browser
 * suite — because the composite is the whole point: the browser suites are where the
 * pipeline's reds actually came from, and an arm that left them to CI re-creates the
 * PR-window red class the landing front half exists to close (2026-10-15, the
 * browser-suite-at-the-gate task). The receipt-reuse rule and the lockfile install
 * gate are what keep the added cost bounded.
 *
 * The ceremony holds the landing lock (the repository's shared `cache/landing.lock`, flock, kernel-
 * released on death) across its whole sequence — two builders finishing in the same
 * minute are the pre-queue race it exists to close — and the heavy-run lock needs no
 * ceremony-level handling, because `make verify` takes it inside itself, which
 * lands the design's fixed acquisition order (landing, then heavy-run) by construction.
 *
 * **The script owns git and GitHub only.** The board is the calling session's channel:
 * on green this script prints the projected-tip receipt and the stamp instruction, and
 * the session stamps `0 - Queued` + `pr-ref` through the vault tooling exactly as
 * today's enqueue protocol; on a bounce it prints what the tooling said and the session
 * writes the dated task line and moves the task to `2 - In Progress`. This split keeps
 * every board write behind the vault CLI layer the rules guard, and keeps this file
 * runnable headless if the step-3 landing loop ever wants it.
 *
 * **Fail closed is structural.** Every pre-green failure exits nonzero without arming;
 * there is no skip-the-gate flag and no env door to the gate — the rework-actor guard
 * (a bounced builder may not green the gate by touching tests or CI budgets) is
 * enforced by this surface being too small to bypass, and the emergency bypass is
 * Parker's explicit call in a knowingly-red push, the same relationship a deploy has to
 * a gate.
 *
 * The residuals this gate does not catch — an ejection ahead invalidating the receipt,
 * and a semantic conflict against a not-yet-armed entry — are stated in the design
 * document and measured by the event log's step-3 metrics; this file claims neither is
 * eliminated.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AppendableEvent,
	type ArmEvent,
	type ArmedEntry,
	appendEvent,
	armedLedger,
	type EjectionEvent,
	isRecordedEjection,
	isRecordedLand,
	type LockReleaseEvent,
	type LogOptions,
	lastArmFor,
	readEvents,
	unresolvedHolds,
} from "./landing-log.ts";
import {
	authorityMode,
	type RadarReport,
	REPO,
	runRadar,
	summarize,
	toRadarRunEvent,
} from "./landing-radar.ts";
import { repoCacheDir } from "./repo-cache.ts";

function landingLockDefault(): string {
	return join(repoCacheDir(), "landing.lock");
}

export interface ArmOptions {
	/** The pr being armed. */
	pr: number;
	/**
	 * The ceremony's mode: `arm` is the builder's gate-then-enqueue; `rearm` is the
	 * finisher's door — an already-armed pr whose head moved (the receipt the board
	 * recorded is stale) and the re-enqueue of an ejected pr both ride it. The re-arm
	 * recomputes the receipt under the same lock, the same radar, the same gate, and
	 * accepts GitHub's "already enqueued" refusal as the queue still owning the pr.
	 */
	mode?: "arm" | "rearm";
	/** The repository root the ceremony runs against (the branch's own worktree is the normal caller). */
	cwd?: string;
	/** Overrides for tests. */
	landingLockPath?: string;
}

export interface ArmDecision {
	outcome: "armed" | "bounce" | "refuse";
	/** The projected-tip sha on arm — the receipt the board's progress line carries. */
	receipt?: string;
	/** True when the gate was skipped because the exact composite already gated green. */
	reusedGate?: boolean;
	/** The session-facing lines: what the ceremony did, or what bounced it. */
	lines: string[];
	/** The board action the calling session performs once this outcome is known. */
	stamp?: { status: string; prRef: string };
}

function log(line: string): void {
	console.log(line);
}

/** Git runner: GIT_* scrubbed (the verify-stamp trap), argv-level, failures as data. */
function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status === null ? 1 : result.status,
	};
}

function gitEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
}

function gh(
	args: string[],
	options: { pin?: boolean } = {},
): { stdout: string; stderr: string; status: number } {
	// The exception is `api graphql`: its query carries owner and name itself, and gh's
	// flag parser rejects a prefixed shorthand -R there — those calls stay pinned by
	// their query instead.
	const full = options.pin === false ? args : ["-R", REPO, ...args];
	const result = spawnSync("gh", full, { encoding: "utf8" });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status === null ? 1 : result.status,
	};
}

interface PrView {
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
	headRefName: string;
	headRefOid: string;
	baseRefName: string;
	autoMergeRequest: object | null;
	mergeCommit?: { oid: string } | null;
}

/** The pr's truth from GitHub, or null when GitHub cannot answer — a null refuses the ceremony rather than arming blind. */
function prView(pr: number): PrView | null {
	const result = gh([
		"pr",
		"view",
		String(pr),
		"--json",
		"state,headRefName,headRefOid,baseRefName,autoMergeRequest,mergeCommit",
	]);
	if (result.status !== 0) return null;
	try {
		return JSON.parse(result.stdout) as PrView;
	} catch {
		return null;
	}
}

/** The merge queue's in-flight pr numbers; a failure is null, which refuses the reconcile rather than faking a membership. */
function queuedPrNumbers(): Set<number> | null {
	const query =
		"query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ mergeQueue { entries(first:50){ nodes { pr: pullRequest { number } } } } } }";
	const result = gh(
		["api", "graphql", "-f", `query=${query}`, "-f", "owner=anthers-inc", "-f", "name=anthers"],
		{ pin: false },
	);
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(result.stdout) as {
			data?: {
				repository?: { mergeQueue?: { entries?: { nodes?: { pr?: { number?: number } }[] } } };
			};
		};
		const nodes = parsed.data?.repository?.mergeQueue?.entries?.nodes ?? [];
		return new Set(
			nodes.map((node) => node.pr?.number).filter((n): n is number => n !== undefined),
		);
	} catch {
		return null;
	}
}

/**
 * The landing lock: flock LOCK_EX, polled so a waiting session can see it is queueing
 * (the heavy-run lane's report shape), held for the process's lifetime. `lock-wait` and
 * `lock-acquire` ride the event log; the caller writes `lock-release` best-effort. The
 * fd is deliberately never closed — the kernel releases the lock when this process
 * ends, however it ends. Never throws for an unavailable libc: a ceremony that cannot
 * lock is *reported* and refused, because arming without the lock is the race this file
 * exists to close — the lock is a correctness layer here, not an optimization.
 */
export async function holdLandingLock(
	append: (event: AppendableEvent) => void,
	options: { path?: string; pollMs?: number } = {},
): Promise<number | null> {
	const path = options.path ?? landingLockDefault();
	const LOCK_EX = 2;
	const LOCK_NB = 4;
	const pollMs = options.pollMs ?? 15_000;
	let flock: (fd: number, operation: number) => number;
	try {
		const { dlopen, FFIType } = await import("bun:ffi");
		const libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		});
		flock = libc.symbols.flock;
	} catch (error) {
		log(
			`→ libc's flock is unavailable (${(error as Error).message.split("\n")[0]}) — refusing to arm without the landing lock`,
		);
		return null;
	}
	mkdirSync(join(path, ".."), { recursive: true });
	const fd = openSync(path, "a");
	let waited = 0;
	if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
		log("→ another landing actor holds the landing lock — waiting (this report repeats every 15s)");
		append({ event: "lock-wait", lock: "landing", waitedMs: 0 });
		while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			await Bun.sleep(pollMs);
			waited += pollMs;
			log(`→ the landing lock still held (${Math.round(waited / 1000)}s of waiting so far)`);
			append({ event: "lock-wait", lock: "landing", waitedMs: waited });
		}
	}
	append({ event: "lock-acquire", lock: "landing", waitedMs: waited });
	return fd;
}

/**
 * Whether the ledger saw the radar flag this pr after its arm — the `radarPredicted`
 * half the ejection taxonomy is subtracted against. Unknown is the honest default when
 * no run recorded the pair.
 */
function radarPredictedFrom(
	events: ReturnType<typeof readEvents>["events"],
	pr: number,
	afterTs: string,
): boolean {
	return events.some(
		(event) =>
			event.event === "radar-run" &&
			event.ts > afterTs &&
			event.findings.some((finding) => finding.a.pr === pr || finding.b.pr === pr),
	);
}

function ejectionFor(
	events: ReturnType<typeof readEvents>["events"],
	entry: ArmedEntry,
	reason: string,
): Omit<EjectionEvent, "ts"> {
	return {
		event: "ejection",
		pr: entry.pr,
		head: entry.head,
		reason,
		radarPredicted: radarPredictedFrom(events, entry.pr, entry.armedAt),
		environment: "unknown",
	};
}

/**
 * Reconcile the arm ledger against GitHub: a merged arm-ahead becomes `land`, anything
 * that left the queue without landing becomes `ejection`, and what survives returns as
 * the armed set the projection composes. Any answer it cannot get (unreadable queue,
 * unreadable pr) is fatal — refusing to project is the fail-closed direction, since a
 * stale armed-ahead entry is exactly the combination no ceremony ever tested.
 */
export function reconcile(): {
	armed: ArmedEntry[];
	lines: string[];
	fatal?: string;
} {
	let events = readEvents().events;
	const armedBefore = armedLedger(events);
	const queue = queuedPrNumbers();
	const lines: string[] = [];
	if (queue === null) {
		return {
			armed: [],
			lines,
			fatal:
				"the merge queue could not be read — refusing to project onto an unreconciled armed set",
		};
	}
	for (const entry of armedBefore) {
		const view = prView(entry.pr);
		if (view === null) {
			return {
				armed: [],
				lines,
				fatal: `armed #${entry.pr} could not be read from GitHub — refusing to project`,
			};
		}
		if (view.state === "MERGED") {
			const sha = view.mergeCommit?.oid ?? "";
			if (!isRecordedLand(events, entry.pr, sha)) {
				appendEvent({ event: "land", pr: entry.pr, mergedSha: sha });
				lines.push(
					`→ armed-ahead #${entry.pr} has landed (${sha.slice(0, 7)}) — recorded, no longer projecting`,
				);
				events = readEvents().events;
			}
			continue;
		}
		if (view.state === "CLOSED") {
			if (!isRecordedEjection(events, entry.pr, entry.head)) {
				appendEvent(ejectionFor(events, entry, "pr closed without landing"));
				lines.push(
					`→ armed-ahead #${entry.pr} was closed without landing — recorded, no longer projecting`,
				);
				events = readEvents().events;
			}
			continue;
		}
		// OPEN: ejected when neither queued nor still auto-merging — the finisher's
		// predicate, which the autoMergeRequest-alone false alarm taught (the queue
		// clears the field while a merge group is being tested, so both halves must agree).
		const stillAuto = view.autoMergeRequest !== null && view.autoMergeRequest !== undefined;
		if (!queue.has(entry.pr) && !stillAuto) {
			if (!isRecordedEjection(events, entry.pr, entry.head)) {
				appendEvent(ejectionFor(events, entry, "left the merge queue with auto-merge cleared"));
				lines.push(
					`→ armed-ahead #${entry.pr} was ejected from the queue — recorded, no longer projecting`,
				);
				events = readEvents().events;
			}
		}
	}
	return { armed: armedLedger(readEvents().events), lines };
}

function refusal(outcomeLines: string[]): ArmDecision {
	return { outcome: "refuse", lines: outcomeLines };
}

function bounce(
	reason: "radar-hold" | "gate-red" | "construct-conflict" | "pr-state",
	detail: string,
	pr: number | undefined,
	lines: string[],
): ArmDecision {
	if (pr !== undefined) {
		appendEvent({ event: "bounce", pr, reason, detail, disposition: "2 - In Progress" });
	} else {
		appendEvent({ event: "bounce", reason, detail, disposition: "2 - In Progress" });
	}
	return { outcome: "bounce", lines };
}

/**
 * GitHub refusals that mean "the arm is already set", which a `rearm` accepts as
 * success: the queue already owns the pr, the auto-merge needs no second act, and the
 * re-arm's fresh receipt is the ledger's new truth. Matched by message, never by exit
 * code alone (gh's exit for it is nonzero like every other refusal).
 */
export function armRefusalIsAlreadyArm(stderr: string): boolean {
	return /already enqueued|auto-merge is already enabled|already been enqueued/i.test(stderr);
}

/** Preconditions that need only the pr's own view and the calling checkout. Each refusal names its fix. */
export function preconditions(options: ArmOptions): { view: PrView } | ArmDecision {
	const pr = options.pr;
	const view = prView(pr);
	if (view === null)
		return refusal([
			`→ PR #${pr} could not be read from GitHub — fix gh's auth or the number, and retry`,
		]);
	if (view.state === "MERGED") return refusal([`→ PR #${pr} is already merged — nothing to arm`]);
	if (view.state === "CLOSED")
		return refusal([`→ PR #${pr} is closed — arm nothing; reopen or open a fresh PR`]);
	if (view.baseRefName !== "main")
		return refusal([
			`→ PR #${pr} targets \`${view.baseRefName}\` — the ceremony projects onto origin/main, and it does not arm work aimed elsewhere`,
		]);
	const cwd = options.cwd ?? process.cwd();
	const currentBranch = git(["branch", "--show-current"], cwd).stdout.trim();
	if (currentBranch !== view.headRefName) {
		return refusal([
			`→ the calling checkout is on \`${currentBranch || "(detached)"}\` but #${pr} is \`${view.headRefName}\` — run the ceremony from the branch's own worktree`,
		]);
	}
	const head = git(["rev-parse", "HEAD"], cwd).stdout.trim();
	if (head !== view.headRefOid) {
		return refusal([
			`→ this worktree's HEAD (${head.slice(0, 7)}) is not the pr's pushed head (${view.headRefOid.slice(0, 7)}) — push first; the gate verifies what will merge`,
		]);
	}
	if (view.autoMergeRequest !== null && view.autoMergeRequest !== undefined) {
		if (options.mode !== "rearm") {
			return refusal([
				`→ #${pr} is already armed — the queue owns it now; it is stuck, \`/finish-train\` is the path`,
			]);
		}
		// A re-arm of an already-armed pr is the head-moved-while-armed case the finisher
		// owns: the auto-merge stays the queue's to finish, and the receipt below is what
		// the re-arm restores.
		log(
			`→ #${pr} is already armed (a head move superseded its receipt) — the re-arm refreshes the receipt`,
		);
	}
	return { view };
}

/**
 * The re-arm receipt, as a rule rather than inline arithmetic: the gate is skipped only
 * when the pushed head and the freshly constructed tip both equal the last arm's —
 * meaning the exact composite gated green before, and nothing anywhere moved. A landing
 * ahead moves `main`, moves the tip, and re-gates by construction; that is why this
 * check takes no pr-shortcut and no flag.
 */
export function isReusableReceipt(
	lastArm: ArmEvent | undefined,
	pushedHead: string,
	projectedTip: string,
): boolean {
	return (
		lastArm !== undefined && lastArm.head === pushedHead && lastArm.projectedTip === projectedTip
	);
}

/**
 * Construct the projected tip in the fixed scratch worktree: `origin/main`, then every
 * armed entry ahead in arm order, then the candidate. The worktree is dedicated to the
 * ceremony (single-user by the landing lock, detached at each run's tip), so a force
 * checkout here can never touch a builder's tree; its node_modules is why the path is
 * fixed rather than per-invocation. A conflict at construction is a textual collision
 * the radar missed — returned as `conflict`, never resolved by guessing.
 */
export function constructProjectedTip(options: {
	cwd: string;
	gatePath: string;
	armed: ArmedEntry[];
	candidateBranch: string;
}): { tip: string; composition: string[] } | { conflict: { branch: string; message: string } } {
	const { cwd, gatePath, armed, candidateBranch } = options;
	const createdFresh = !existsSync(join(gatePath, ".git"));
	if (createdFresh) {
		const created = git(["worktree", "add", "--detach", gatePath, "origin/main"], cwd);
		if (created.status !== 0) {
			return {
				conflict: {
					branch: "(scratch worktree)",
					message:
						(created.stderr || "could not create the arm-gate worktree")
							.split("\n")
							.filter(Boolean)[0] ?? "",
				},
			};
		}
	} else if (git(["checkout", "--force", "--detach", "origin/main"], gatePath).status !== 0) {
		return {
			conflict: {
				branch: "(scratch worktree)",
				message: "could not reset the arm-gate worktree to origin/main",
			},
		};
	}
	const ordered = [...armed].sort((a, b) => a.armedAt.localeCompare(b.armedAt));
	for (const entry of ordered) {
		const merged = git(["merge", "--no-edit", `origin/${entry.branch}`], gatePath);
		if (merged.status !== 0) {
			return {
				conflict: {
					branch: `${entry.branch} (#${entry.pr})`,
					message:
						(merged.stderr || merged.stdout).split("\n").filter(Boolean)[0] ?? "merge failed",
				},
			};
		}
	}
	const last = git(["merge", "--no-edit", `origin/${candidateBranch}`], gatePath);
	if (last.status !== 0) {
		return {
			conflict: {
				branch: `${candidateBranch} (the candidate)`,
				message: (last.stderr || last.stdout).split("\n").filter(Boolean)[0] ?? "merge failed",
			},
		};
	}
	const tip = git(["rev-parse", "HEAD"], gatePath).stdout.trim();
	const composition = [
		"origin/main",
		...ordered.map((entry) => `${entry.branch} (#${entry.pr})`),
		`${candidateBranch} (candidate)`,
	];
	return { tip, composition };
}

/**
 * The install gate: real `bun install` in the scratch tree only when the constructed
 * tip's lockfile content differs from the one this tree last installed for — the common
 * re-arm pays no install. The key is the blob sha of `HEAD:bun.lock`, so the comparison
 * is content, never timestamps.
 *
 * The stamp lives **inside the tree** (`.arm-install-stamp` at its root), not beside it
 * in a cache directory: a stamp that can outlive the tree it vouches for is worse than
 * no stamp, and there are two ways a tree dies without its cache knowing — the scratch
 * worktree is removed when the task ships, and a ceremony can exit mid-construction
 * leaving a tree that exists but never installed. Both are closed structurally by
 * binding the record to the tree's own lifetime: no tree, no stamp; a tree without a
 * stamp simply installs.
 */
export function installGate(options: { gatePath: string }): {
	install: "real" | "reused";
	error?: string;
} {
	const lockfile = git(["rev-parse", "HEAD:bun.lock"], options.gatePath);
	const lockSha = lockfile.status === 0 ? lockfile.stdout.trim() : "";
	if (lockSha === "")
		return { install: "real", error: "could not read HEAD:bun.lock in the arm-gate worktree" };
	const stamp = join(options.gatePath, ".arm-install-stamp");
	if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === lockSha)
		return { install: "reused" };
	const install = spawnSync("bun", ["install"], { cwd: options.gatePath, encoding: "utf8" });
	if (install.status !== 0) {
		return {
			install: "real",
			error:
				(install.stderr || install.stdout || "bun install failed")
					.split("\n")
					.filter(Boolean)
					.slice(-1)[0] ?? "bun install failed",
		};
	}
	writeFileSync(stamp, `${lockSha}\n`);
	return { install: "real" };
}

function gateTier(gatePath: string): { result: "green" | "red"; durationMs: number } {
	const started = Date.now();
	const result = spawnSync("make", ["verify"], { cwd: gatePath, stdio: "inherit" });
	return { result: result.status === 0 ? "green" : "red", durationMs: Date.now() - started };
}

/**
 * The gate's other skip: the tip already carries a full green stamp, from any tracked-
 * clean checkout that ran the suite at exactly that commit within the stamp window —
 * which is the re-arm-after-a-dropped-arm case in practice (a bounced arm's gate wrote
 * its stamp at this same tip). The tier rule is the pre-push hook's own: a full stamp
 * satisfies only the full tier, and this gate IS the full tier; a fast stamp never
 * stands in.
 */
export function fullStampAt(tip: string): boolean {
	const check = spawnSync("bun", ["run", "scripts/verify-stamp.ts", "check", tip, "verify"], {
		encoding: "utf8",
	});
	return check.status === 0;
}

/**
 * The queue's own answer for whether an armed pr was ingested — read from
 * `repository.mergeQueue.entries`, never from the PR's auto-merge field: the field
 * clears while a merge group is being tested (the 2026-10-12 predicate incident), and
 * it alone both false-alarms in-flight groups and false-confirms an arm that was
 * silently dropped.
 */
export interface QueueEntry {
	pullRequest: { number: number };
}

export function entryInQueue(entries: QueueEntry[], pr: number): boolean {
	return entries.some((entry) => entry.pullRequest.number === pr);
}

export function readQueueEntries(): { nodes: QueueEntry[] } | undefined {
	const result = gh(
		[
			"api",
			"graphql",
			"-f",
			'query={ repository(owner: "anthers-inc", name: "anthers") { mergeQueue { entries(first: 60) { nodes { pullRequest { number } } } } } }',
		],
		{ pin: false },
	);
	if (result.status !== 0) return undefined;
	try {
		return (
			JSON.parse(result.stdout) as {
				data?: { repository?: { mergeQueue?: { entries?: { nodes: QueueEntry[] } } } };
			}
		).data?.repository?.mergeQueue?.entries;
	} catch {
		return undefined;
	}
}

/**
 * How long the ceremony waits for the queue to show an arm it was handed. Ingestion is
 * near-instant when it happens at all; the polls exist so a slow GraphQL read is not
 * mistaken for a dropped arm. A check still pending minutes away is the bounce's
 * business, never the poller's.
 */
const INGEST_POLLS = 6;
const INGEST_POLL_SECONDS = 5;

export async function awaitIngest(pr: number): Promise<boolean> {
	for (let attempt = 0; attempt < INGEST_POLLS; attempt++) {
		if (attempt > 0)
			await new Promise((resolve) => setTimeout(resolve, INGEST_POLL_SECONDS * 1000));
		const read = readQueueEntries();
		if (read && entryInQueue(read.nodes, pr)) return true;
	}
	return false;
}

/**
 * When this candidate gates green, every radar hold whose finding named this entry is
 * answered `collision-avoided`: the pair was either tested clean in the composite or
 * made moot by the other side's landing, which is what "dodged" means in the ledger.
 * Holds about other entries stay unresolved — they are not this ceremony's to answer.
 */
export function resolveGreenHolds(pr: number, lines: string[], logOptions: LogOptions = {}): void {
	const events = readEvents(logOptions).events;
	const answered = unresolvedHolds(events).filter(
		(hold) => hold.finding.a.pr === pr || hold.finding.b.pr === pr,
	);
	for (const hold of answered) {
		appendEvent(
			{ event: "hold-resolution", holdId: hold.id, outcome: "collision-avoided" },
			logOptions,
		);
		lines.push(`→ hold ${hold.id.slice(0, 8)} resolved: collision-avoided`);
	}
}

async function runCeremony(pr: number, options: ArmOptions): Promise<ArmDecision> {
	const precondition = preconditions(options);
	if ("lines" in precondition) return precondition;
	const view = precondition.view;
	const branch = view.headRefName;
	const cwd = options.cwd ?? process.cwd();

	log(`→ the arm ceremony for #${pr} (branch \`${branch}\`)`);
	const lockFd = await holdLandingLock((event) => appendEvent(event), {
		path: options.landingLockPath,
	});
	if (lockFd === null)
		return refusal(["→ cannot arm without the landing lock — see the line above"]);
	const lockStarted = Date.now();
	const lines: string[] = [];
	try {
		const fetched = git(["fetch", "origin"], cwd);
		if (fetched.status !== 0) {
			return bounce(
				"pr-state",
				`git fetch origin failed: ${fetched.stderr.split("\n").filter(Boolean)[0] ?? ""}`,
				pr,
				["→ could not fetch origin; the projection needs current refs"],
			);
		}

		const reconciled = reconcile();
		for (const line of reconciled.lines) log(line);
		lines.push(...reconciled.lines);
		if (reconciled.fatal !== undefined) {
			return bounce("pr-state", reconciled.fatal, pr, [line(reconciled.fatal)]);
		}
		const armed = reconciled.armed.filter((entry) => entry.pr !== pr);
		if (armed.length > 0) {
			log(
				`→ armed ahead (in arm order): ${armed.map((entry) => `#${entry.pr} (${entry.branch})`).join(", ")}`,
			);
		} else {
			log("→ nothing armed ahead; the projected tip composes origin/main and the candidate only");
		}

		// The radar: advisory through the shadow week, holding after the flip. Whether it
		// holds is decided here, at arm time — a run's authority is whoever asked for it.
		const report: RadarReport = runRadar({ cwd, fetch: false });
		appendEvent(toRadarRunEvent(report, "arm"));
		for (const line of summarize(report)) log(line);
		const mode = authorityMode();
		const involved = report.findings.filter(
			(finding) => finding.a.pr === pr || finding.b.pr === pr,
		);
		if (mode === "blocking" && involved.length > 0) {
			const holdId = globalThis.crypto.randomUUID();
			for (const finding of involved)
				appendEvent({ event: "radar-hold", id: holdId, finding, blocking: true });
			const detail = involved
				.map(
					(finding) =>
						`${describeRef(finding.a.pr === pr ? finding.b : finding.a)} on ${finding.paths.join(", ")}`,
				)
				.join("; ");
			return bounce("radar-hold", detail, pr, [
				`→ the radar holds this arm: ${detail}`,
				"→ the arm is not set; answer the collision in code or merge the named arm-ahead's landing first, then `/arm` again after it lands",
			]);
		}

		// Construct the projected tip — the combination GitHub's merge group will build.
		const constructed = constructProjectedTip({
			cwd,
			gatePath: armGatePath(options),
			armed,
			candidateBranch: branch,
		});
		if ("conflict" in constructed) {
			return bounce(
				"construct-conflict",
				`${constructed.conflict.branch}: ${constructed.conflict.message}`,
				pr,
				[
					`→ the projection conflicts at ${constructed.conflict.branch}: ${constructed.conflict.message}`,
					"→ a conflict at construction is textual and local to this machine — merge the named entry or current main into this branch, resolve, push, and `/arm` again",
				],
			);
		}
		const { tip, composition } = constructed;
		log(`→ projected tip ${tip.slice(0, 7)} = ${composition.join(" + ")}`);

		// The re-arm receipt: the exact composite already gated green, so the gate is
		// skipped — reconcile and radar still ran, and any landing ahead would have
		// moved the tip and re-gated by construction.
		const reusable = isReusableReceipt(lastArmFor(readEvents().events, pr), view.headRefOid, tip);

		if (reusable) {
			log(
				`→ the tip is the receipt of the last arm — the composite already gated green, no second ticket`,
			);
		} else if (fullStampAt(tip)) {
			log(
				`→ the tip carries a full verify stamp — the composite already ran green, no second ticket`,
			);
		} else {
			const install = installGate({
				gatePath: armGatePath(options),
			});
			if (install.error !== undefined) {
				return bounce("gate-red", install.error, pr, [
					`→ the install gate failed: ${install.error}`,
				]);
			}
			log(
				`→ bun.lock ${install.install === "reused" ? "unchanged — install reused" : "moved — installing for real"}`,
			);
			const gate = gateTier(armGatePath(options));
			appendEvent({
				event: "gate-run",
				projectedTip: tip,
				composition,
				install: install.install,
				result: gate.result,
				durationMs: gate.durationMs,
			});
			if (gate.result === "red") {
				return bounce("gate-red", `the suite is red at the projected tip`, pr, [
					`→ the gate is red: make verify failed against the projected tip (${tip.slice(0, 7)}), not this branch's own push`,
					"→ the composition includes the armed entries ahead, so the failure may be an interaction — read the run's output above before touching this branch",
					"→ answered in code or argued back with a reason; the gate is greened by fixing the tree, never by touching tests to pass",
				]);
			}
			log(`→ the suite is green at the projected tip (${Math.round(gate.durationMs / 1000)}s)`);
		}

		const armResult = gh(["pr", "merge", String(pr), "--squash", "--auto"]);
		if (
			armResult.status !== 0 &&
			!(options.mode === "rearm" && armRefusalIsAlreadyArm(armResult.stderr || armResult.stdout))
		) {
			return bounce(
				"pr-state",
				(armResult.stderr || "gh refused").split("\n").filter(Boolean)[0] ?? "gh refused",
				pr,
				[
					line(
						`GitHub refused the arm: ${(armResult.stderr || armResult.stdout).split("\n").filter(Boolean)[0] ?? ""}`,
					),
				],
			);
		}
		if (armResult.status !== 0) {
			log(
				"→ GitHub says the pr is already enqueued — the auto-merge stands, the receipt is the re-arm's product",
			);
		}
		// ⭐ The arm is an enqueue only when the queue says so. `gh pr merge --squash
		// --auto` on a queued repository can silently do nothing and exit 0: an arm
		// issued while the PR's own checks are still pending is accepted and dropped,
		// leaving no entry and no auto-merge field — a green composite that no queue
		// ever ingests (#520, 2026-10-15, the trap's first live occurrence here; the
		// settled remedy is re-issue on green, verified against entries). So the ceremony
		// verifies the entry before it records or reports an arm: the arm event and the
		// receipt are written only for a PR the queue actually took, and an un-ingested
		// arm bounces with the re-arm door named.
		const ingested = await awaitIngest(pr);
		if (!ingested) {
			return bounce(
				"pr-state",
				"the arm's gh pr merge was accepted but the queue never ingested the pr — the pending-checks silent no-op",
				pr,
				[
					line(
						`→ the arm ran while #${pr}'s own checks were still pending; GitHub accepted the request and dropped it silently`,
					),
					line(
						`→ re-run /arm (or arm.ts <n> --rearm) once #${pr}'s checks report green — the gate at the same tip reuses this run's full verify stamp, so the re-arm is seconds`,
					),
				],
			);
		}
		appendEvent({
			event: "arm",
			pr,
			branch,
			head: view.headRefOid,
			projectedTip: tip,
			reusedGate: reusable,
		});
		const postLines: string[] = [];
		resolveGreenHolds(pr, postLines);
		for (const postLine of postLines) log(postLine);
		return {
			outcome: "armed",
			receipt: tip,
			reusedGate: reusable,
			stamp: { status: "0 - Queued", prRef: `anthers-inc/anthers#${pr}` },
			lines: [
				line(
					`armed #${pr} at the projected tip ${tip.slice(0, 7)} — the receipt the board's progress line carries`,
				),
			],
		};
	} finally {
		const release: Omit<LockReleaseEvent, "ts"> & { heldMs?: number } = {
			event: "lock-release",
			lock: "landing",
			heldMs: Date.now() - lockStarted,
		};
		appendEvent(release);
	}
}

function armGatePath(options: ArmOptions): string {
	const cwd = options.cwd ?? process.cwd();
	const toplevel = git(["rev-parse", "--show-toplevel"], cwd).stdout.trim() || cwd;
	return join(toplevel, ".worktrees", "arm-gate");
}

function describeRef(entry: { pr?: number; branch: string; head: string }): string {
	return entry.pr !== undefined ? `#${entry.pr} (${entry.branch})` : entry.branch;
}

function line(text: string): string {
	return `→ ${text}`;
}

export async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const pr = Number(argv[0]);
	if (
		!argv[0] ||
		!Number.isInteger(pr) ||
		pr <= 0 ||
		argv.some((a) => a !== argv[0] && a !== "--rearm")
	) {
		console.error("usage: bun run scripts/arm.ts <PR number> [--rearm]   (or: make arm PR=<n>)");
		return 64;
	}
	const mode = argv.includes("--rearm") ? "rearm" : "arm";
	if (mode === "rearm")
		log(
			"→ rearm: the finisher's door — the receipt is recomputed under the landing lock, and GitHub's already-enqueued answer is accepted",
		);
	const decision = await runCeremony(pr, { pr, mode });
	for (const l of decision.lines) console.log(l);
	if (decision.outcome === "armed" && decision.stamp) {
		console.log(
			line(
				`stamp the board now, then end the session: ${decision.stamp.status} + \`${decision.stamp.prRef}\`, the dated progress line carrying the projected-tip sha ${decision.receipt?.slice(0, 7)}`,
			),
		);
	}
	if (decision.outcome === "armed") return 0;
	return decision.outcome === "refuse" ? 2 : 1;
}

if (import.meta.main) {
	process.exit(await main());
}
