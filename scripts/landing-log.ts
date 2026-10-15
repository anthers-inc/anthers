// SPDX-License-Identifier: Apache-2.0
/**
 * The landing front half's event log — the append-only ledger the local merge-queue
 * design's step-3 metrics are computed from, and nothing else.
 *
 * Everything here is measurement, never gating: the log records what the landing
 * machinery did (radar runs and holds, gate runs, arms, bounces, ejections, lands, and
 * the landing lock's waits and acquisitions), and a reader derives the design's decision
 * inputs from it. A malformed or absent log degrades the *metrics*, never the pipeline —
 * the ceremony's correctness lives in its steps and its lock, not in this file's health,
 * so every write is cheap and every read is tolerant: a malformed line is reported and
 * skipped, never discarded with the ledger around it.
 *
 * The file is one JSON line per event at the repository's shared `cache/landing-events.jsonl` —
 * (`ANTHERS_LANDING_LOG` overrides for the CLI and the pipeline; functions take an
 * explicit path option, which is what the tests pass — runtime `process.env` mutation
 * does not reach another module's view here, and `verify-stamp`'s options pattern is
 * the same answer), appended by a single `write()` on a file
 * opened `O_APPEND` — atomic at these line sizes, which is what lets the arm ceremony and
 * the finisher's probe (stage four) append concurrently without an interleaved line.
 * Lines are never rewritten by anything. Events are keyed loosely by `ts` (ISO-8601 UTC,
 * millisecond precision, filled at write time when the caller omits it) rather than by a
 * global sequence, because two writers' clocks are the only ordering they share and a
 * millisecond is finer than any two landing acts are apart in practice.
 *
 * The thirteen event families and what each carries are the event-log schema of
 * *Local Merge Queue Design*; this docblock names only the load-bearing choices. Two
 * families exist purely for the ledger's own arithmetic: `radar-run` (a hold issued
 * without its report cannot be resolved as a true collision or a false alarm) and
 * `hold-resolution` (a false-alarm ceiling needs every hold answered — the ceremony writes
 * `collision-avoided` automatically when a later gate for the held entry goes green, and
 * the remaining outcomes are derived from raw events at analysis time). `lock-release` is
 * best-effort: a run that dies holding the landing lock writes no release, the log
 * tolerates its absence, and the next actor's wait reports are the evidence a too-fat
 * lock leaves behind.
 */

import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoCacheDir } from "./repo-cache.ts";

/** Reads and writes resolve their file here: an explicit option wins, then `ANTHERS_LANDING_LOG`, then the default — the same direction `verify-stamp`'s options take. */
export interface LogOptions {
	/** The log file's path (tests pass one; the pipeline relies on the env or the default). */
	path?: string;
}

export function logPath(options: LogOptions = {}): string {
	return (
		options.path ?? process.env.ANTHERS_LANDING_LOG ?? join(repoCacheDir(), "landing-events.jsonl")
	);
}

export type EnvironmentLabel =
	| "runner-infrastructure"
	| "external-service"
	| "version-drift"
	| "unknown";
export type RadarMode = "shadow" | "blocking";
export type RadarScope = "arm" | "hand" | "probe";
export type HoldOutcome = "collision-avoided" | "false-alarm" | "overtaken";
export type BounceReason = "radar-hold" | "gate-red" | "construct-conflict" | "pr-state";
export type LockKind = "landing";

/**
 * An entry name in a finding or a composition: the pr when one exists, the branch either
 * way, and the head the pair was tested at. A ref without a pr is a local worktree
 * branch that has not reached GitHub yet.
 */
export interface EntryRef {
	pr?: number;
	branch: string;
	head: string;
}

/** One in-flight entry as a radar run saw it. `armedRank` is the entry's 1-based position in arm order, or null when it has not armed. */
export interface RadarEntry extends EntryRef {
	armedRank: number | null;
}

/** One textual collision between two entries: the pair and the paths that conflict. `paths` is empty when the pair could not be tested at all (see `errors`). */
export interface RadarFinding {
	a: EntryRef;
	b: EntryRef;
	paths: string[];
}

export interface RadarRunEvent {
	event: "radar-run";
	ts: string;
	scope: RadarScope;
	mode: RadarMode;
	entries: RadarEntry[];
	findings: RadarFinding[];
	errors: { a: EntryRef; b: EntryRef; message: string }[];
}

export interface RadarHoldEvent {
	event: "radar-hold";
	ts: string;
	/** The resolution's handle; the ceremony reuses it when the held entry later gates green. */
	id: string;
	finding: RadarFinding;
	/** False through the radar's shadow week; the flip to blocking authority is what turns it true. */
	blocking: boolean;
}

export interface HoldResolutionEvent {
	event: "hold-resolution";
	ts: string;
	holdId: string;
	outcome: HoldOutcome;
}

export interface GateRunEvent {
	event: "gate-run";
	ts: string;
	projectedTip: string;
	/** The tip's branches in arm order, the candidate last. */
	composition: string[];
	install: "real" | "reused";
	result: "green" | "red";
	durationMs: number;
	/** Named only on red, when the caller could name it. */
	failedStep?: string;
}

export interface ArmEvent {
	event: "arm";
	ts: string;
	pr: number;
	branch: string;
	head: string;
	/** The gate's durable receipt: the projected-tip sha the queue will build. */
	projectedTip: string;
	reusedGate: boolean;
}

export interface BounceEvent {
	event: "bounce";
	ts: string;
	/** The pr being bounced, when the bounce is PR-bound; a worktree-side bounce may have none. */
	pr?: number;
	reason: BounceReason;
	detail: string;
	disposition: "2 - In Progress";
}

export interface EjectionEvent {
	event: "ejection";
	ts: string;
	pr: number;
	head: string;
	reason: string;
	radarPredicted: boolean;
	environment: EnvironmentLabel;
}

/**
 * A pull request sitting armed outside the queue with a concluded-bad mergeable state —
 * the probe's stuck-armed leg (BLOCKED on armed-but-unadmitted, UNSTABLE, DIRTY), the
 * #517 class. This is the PR window's own detection record: an ejection has an event for
 * why the queue removed an entry, and until this family existed an armed head red the
 * same way left no ledger record at all, which is why flake versus regression in the PR
 * window could be argued but not measured. `failingCheck` is named only when the
 * detecting run could read it (the finisher's rerun discovery can; the probe's
 * mergeStateStatus read cannot), so its absence means nothing.
 */
export interface StuckArmedEvent {
	event: "stuck-armed";
	ts: string;
	pr: number;
	head: string;
	mergeStateStatus: "UNSTABLE" | "DIRTY" | "BLOCKED";
	failingCheck?: string;
	environment: EnvironmentLabel;
}

/**
 * One bounded failed-job rerun the finisher granted itself (one per (pr, head), per the
 * rules document); `requested` is written when the finisher re-rolls the job, and a
 * later pass that reads the rerun's result appends `green` or `red` at the same (pr,
 * head, check). `green` is the ledger's own definition of a transient red — a flake the
 * gate re-roll cleared, counted per check rather than argued — and a red that parks is
 * the park's evidence, readable as two `rerun` events plus the `stuck-armed` record.
 */
export interface RerunEvent {
	event: "rerun";
	ts: string;
	pr: number;
	head: string;
	check: string;
	outcome: "requested" | "green" | "red";
}

export interface LandEvent {
	event: "land";
	ts: string;
	pr: number;
	mergedSha: string;
}

export interface LockWaitEvent {
	event: "lock-wait";
	ts: string;
	lock: LockKind;
	/** Milliseconds waited so far, cumulative — one event per wait report, not per poll. */
	waitedMs: number;
}

export interface LockAcquireEvent {
	event: "lock-acquire";
	ts: string;
	lock: LockKind;
	waitedMs: number;
}

export interface LockReleaseEvent {
	event: "lock-release";
	ts: string;
	lock: LockKind;
	/** Milliseconds the lock is believed held; absent when the holder could not know. */
	heldMs?: number;
}

export type LandingEvent =
	| RadarRunEvent
	| RadarHoldEvent
	| HoldResolutionEvent
	| GateRunEvent
	| ArmEvent
	| BounceEvent
	| EjectionEvent
	| StuckArmedEvent
	| RerunEvent
	| LandEvent
	| LockWaitEvent
	| LockAcquireEvent
	| LockReleaseEvent;

/**
 * Append one event to the log, filling `ts` when omitted. Never throws for a writeable
 * directory it did not create: a log the machine cannot write must not break the act it
 * was recording — the failure is printed and the caller continues ungated.
 */
/**
 * The appendable shape of a landing event, distributed over the union so each member
 * contributes its own field set — a collapsed `Omit<LandingEvent, "ts">` keeps only the
 * keys every member shares, and every call site's pr or receipt then errors as an
 * excess property against the shared-keys view.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AppendableEvent = DistributiveOmit<LandingEvent, "ts"> & { ts?: string };

export function appendEvent(event: AppendableEvent, options: LogOptions = {}): void {
	const line = JSON.stringify({ ts: event.ts ?? new Date().toISOString(), ...event });
	try {
		writeLogLine(line, options);
	} catch (error) {
		console.error(
			`→ the landing event log could not be written at ${logPath(options)}: ${errorText(error)}`,
		);
	}
}

function writeLogLine(line: string, options: LogOptions): void {
	const path = logPath(options);
	mkdirSync(dirname(path), { recursive: true });
	const fd = openSync(path, "a");
	try {
		// One write on an O_APPEND descriptor: concurrent writers never interleave a line.
		writeFileSync(fd, `${line}\n`);
	} finally {
		closeSync(fd);
	}
}

export interface LedgerRead {
	events: LandingEvent[];
	/** One string per malformed line: the line number and what was wrong with it. Lines are skipped, never discarded with the file. */
	malformed: string[];
}

const KNOWN_EVENTS = new Set([
	"radar-run",
	"radar-hold",
	"hold-resolution",
	"gate-run",
	"arm",
	"bounce",
	"ejection",
	"stuck-armed",
	"rerun",
	"land",
	"lock-wait",
	"lock-acquire",
	"lock-release",
]);

/**
 * Read the whole ledger. A missing file is an empty ledger — nothing has landed yet —
 * and a malformed line is reported and skipped: the log is measurement, so half of it
 * remaining readable beats none of it, and the malformed report is how the defect is
 * noticed instead of absorbed.
 */
export function readEvents(options: LogOptions = {}): LedgerRead {
	const events: LandingEvent[] = [];
	const malformed: string[] = [];
	let text: string;
	try {
		text = readFileSync(logPath(options), "utf8");
	} catch {
		return { events, malformed };
	}
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line === "") continue;
		try {
			const parsed = JSON.parse(line) as { ts?: unknown; event?: unknown };
			if (
				typeof parsed?.ts !== "string" ||
				typeof parsed?.event !== "string" ||
				!KNOWN_EVENTS.has(parsed.event)
			) {
				malformed.push(`line ${index + 1}: not a landing event shape`);
				continue;
			}
			events.push(parsed as LandingEvent);
		} catch (error) {
			malformed.push(`line ${index + 1}: unparseable JSON (${errorText(error)})`);
		}
	}
	return { events, malformed };
}

/** The armed half of the ledger: an entry is armed from its latest `arm` event until a `land` or `ejection` for the same pr is recorded after it. Arm order is the `ts` of those events. */
export interface ArmedEntry {
	pr: number;
	branch: string;
	head: string;
	projectedTip: string;
	armedAt: string;
}

export function armedLedger(events: LandingEvent[]): ArmedEntry[] {
	// Latest arm per pr, and the unarming event (if any) that postdates it.
	const lastArm = new Map<number, ArmEvent>();
	for (const event of events) {
		if (event.event === "arm") lastArm.set(event.pr, event);
	}
	const unarmingAfter = new Set<number>();
	for (const event of events) {
		if (event.event !== "land" && event.event !== "ejection") continue;
		const arm = lastArm.get(event.pr);
		if (arm && event.ts > arm.ts) unarmingAfter.add(event.pr);
	}
	const armed: ArmedEntry[] = [];
	for (const [pr, arm] of lastArm) {
		if (unarmingAfter.has(pr)) continue;
		armed.push({
			pr,
			branch: arm.branch,
			head: arm.head,
			projectedTip: arm.projectedTip,
			armedAt: arm.ts,
		});
	}
	return armed;
}

/** The latest `arm` event for one pr — the receipt lookup a re-arm compares against. Returns undefined when the pr has never armed. */
export function lastArmFor(events: LandingEvent[], pr: number): ArmEvent | undefined {
	let latest: ArmEvent | undefined;
	for (const event of events) {
		if (event.event === "arm" && event.pr === pr) latest = event;
	}
	return latest;
}

/** Whether a pr is recorded as merged at exactly this sha — the idempotency check a reconcile writer uses before appending a second `land`. */
export function isRecordedLand(events: LandingEvent[], pr: number, mergedSha: string): boolean {
	return events.some(
		(event) => event.event === "land" && event.pr === pr && event.mergedSha === mergedSha,
	);
}

/** Whether a pr is already recorded ejected at exactly this head, for the same idempotency on `ejection`. */
export function isRecordedEjection(events: LandingEvent[], pr: number, head: string): boolean {
	return events.some(
		(event) => event.event === "ejection" && event.pr === pr && event.head === head,
	);
}

/** Holds issued and not yet resolved — the ledger's open side, which the flip's decision reads. */
export function unresolvedHolds(events: LandingEvent[]): RadarHoldEvent[] {
	const issued = events.filter((event): event is RadarHoldEvent => event.event === "radar-hold");
	const resolvedIds = new Set(
		events
			.filter((event) => event.event === "hold-resolution")
			.map((event) => (event as HoldResolutionEvent).holdId),
	);
	return issued.filter((hold) => !resolvedIds.has(hold.id));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The door a non-bun writer walks to append one event — the finisher's run agent and the
 * machine-side probe write the events their roles produce (the probe's ejection tagging,
 * a finisher run's refined attribution), and neither carries a second copy of the
 * append: the JSON lands here, is checked against the known event set, and rides the one
 * `appendEvent` above. A shape the reader would skip is refused here instead of
 * silently polluting the ledger.
 */
export function main(): number {
	const args = process.argv.slice(2);
	if (args[0] !== "append" || args.length !== 2) {
		console.error("usage: bun run scripts/landing-log.ts append '<event json, ts optional>'");
		return 64;
	}
	try {
		const parsed = JSON.parse(args[1]) as { event?: unknown };
		if (typeof parsed?.event !== "string" || !KNOWN_EVENTS.has(parsed.event)) {
			throw new Error(
				`"${parsed?.event ?? String(parsed)}" is not one of the landing event shapes`,
			);
		}
		if (parsed.event === "radar-run") {
			throw new Error(
				"a radar-run event is the radar's writer to produce (scripts/landing-radar.ts)",
			);
		}
		appendEvent(parsed as AppendableEvent);
		console.log("→ appended");
		return 0;
	} catch (error) {
		console.error(`landing-log: ${errorText(error)}`);
		return 64;
	}
}

if (import.meta.main) {
	process.exit(main());
}
