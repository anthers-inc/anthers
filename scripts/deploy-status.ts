import {
	type CiSituation,
	type Deployment,
	readDeployments,
	readWorkflowRuns,
	repoSlugFromRemote,
	type WorkflowRun,
} from "./deploy-state.js";

/** Which `doctl` account to compare against, via `DOCTL_CONTEXT`. Same rule as
 * `spec-diff.ts`: production is under an Anthers-owned account, and without this
 * the tool silently compares against whichever account `doctl` is pointed at. */
const CONTEXT = (process.env.DOCTL_CONTEXT ?? "").trim();
const ctxArgs = CONTEXT ? ["--context", CONTEXT] : [];

/** The app-id comes from the `DO_APP_ID` env var (CI) or is resolved by name
 * (local), exactly as `spec-diff.ts` resolves it — the id is assigned at
 * creation and is not in the committed spec. */
const APP_NAME = "anthers";

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { ok: (await proc.exited) === 0, stdout, stderr };
}

/**
 * Ask GitHub whether CI is still working on this commit.
 *
 * ⚠️ **Every failure here returns `situation: null` with a reason, and none of them is
 * fatal.** This is a second opinion on a question DigitalOcean cannot answer, and a tool
 * that refused to run because an optional lookup failed would be worse than the confident
 * wrongness it replaces. What matters is that the caller prints *"could not ask"* rather
 * than *"nothing is coming"*.
 *
 * Unauthenticated works on a public repo and is rate-limited by IP, which is fine for a
 * laptop; `GH_TOKEN` or `GITHUB_TOKEN` raises that and is what CI passes.
 */
async function ciRunsFor(sha: string): Promise<{ situation: CiSituation | null; why: string }> {
	let repo = (process.env.GITHUB_REPOSITORY ?? "").trim();
	if (!repo) {
		const remote = await run(["git", "remote", "get-url", "origin"]);
		repo = remote.ok ? repoSlugFromRemote(remote.stdout) : "";
	}
	if (!repo) return { situation: null, why: "no GitHub repository in the origin remote" };

	const token = (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "").trim();
	const headers: Record<string, string> = {
		Accept: "application/vnd.github+json",
		"User-Agent": "anthers-deploy-status",
	};
	if (token) headers.Authorization = `Bearer ${token}`;

	try {
		const res = await fetch(
			`https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`,
			{ headers, signal: AbortSignal.timeout(8000) },
		);
		if (!res.ok) {
			const hint = token ? "" : " (unauthenticated — set GH_TOKEN to raise the rate limit)";
			return { situation: null, why: `the Actions API answered ${res.status}${hint}` };
		}
		const body = (await res.json()) as { workflow_runs?: WorkflowRun[] };
		return { situation: readWorkflowRuns(body.workflow_runs ?? [], sha), why: "" };
	} catch (e) {
		return { situation: null, why: e instanceof Error ? e.message : String(e) };
	}
}

if (!(await run(["which", "doctl"])).ok) {
	console.log("deploy-status: doctl not installed — nothing to compare.");
	process.exit(2);
}

// Resolve the app-id: the DO_APP_ID env var wins (CI), then list-by-name (local).
let appId = process.env.DO_APP_ID ?? "";
if (!appId) {
	const list = await run([
		"doctl",
		"apps",
		"list",
		"--format",
		"ID,Spec.Name",
		"--no-header",
		...ctxArgs,
	]);
	if (!list.ok) {
		console.log(`deploy-status: doctl could not list apps — skipping.\n${list.stderr.trim()}`);
		process.exit(2);
	}
	appId =
		list.stdout
			.split("\n")
			.map((l) => l.trim().split(/\s+/))
			.find(([, name]) => name === APP_NAME)?.[0] ?? "";
}
if (!appId) {
	console.error(`deploy-status: no App Platform app named "${APP_NAME}" found.`);
	process.exit(2);
}

const deploys = await run(["doctl", "apps", "list-deployments", appId, "-o", "json", ...ctxArgs]);
if (!deploys.ok) {
	console.log(
		`deploy-status: could not list deployments for ${APP_NAME}.\n${deploys.stderr.trim()}`,
	);
	process.exit(2);
}

const deployments = JSON.parse(deploys.stdout) as Deployment[];

// The ref to compare against, overridable via REF.
//
// ⚠️ Resolved BEFORE the ACTIVE lookup, because the no-ACTIVE branch below has to be
// able to say whether the thing currently deploying is the thing we asked for.
//
// 🚨 The default is the REMOTE ref, because that is what App Platform builds from and the
// local branch is not. `git push origin main:release` — the documented way to promote —
// never moves local `release`, so a default of `release` compared production against a
// branch that had been stale since the last checkout. The tool's own comments record that
// misfiring on 2026-08-15, and the trap survived the fix that recorded it. Same for
// `PROMOTE_FROM`: counting `release..main` against a stale local `main` reports work as
// unshipped that shipped days ago.
let REF = process.env.REF ?? "origin/release";
// Best-effort, because being offline must not break a check that can still answer from
// the last fetch. Failure here is silent by design; a stale `origin/release` is caught by
// the fallback below only when the ref is missing entirely.
await run(["git", "fetch", "origin", "release", "main", "--quiet"]);

let refResult = await run(["git", "rev-parse", "--short=7", REF]);
if (!refResult.ok && !process.env.REF && REF.startsWith("origin/")) {
	// A clone that has never fetched has no remote-tracking ref. Fall back rather than
	// refusing to run, and say which ref the answer is actually about.
	const local = REF.slice("origin/".length);
	const fallback = await run(["git", "rev-parse", "--short=7", local]);
	if (fallback.ok) {
		console.log(`deploy-status: no ${REF} — comparing against local ${local} instead.`);
		REF = local;
		refResult = fallback;
	}
}
if (!refResult.ok) {
	console.error(`deploy-status: could not resolve ref "${REF}".\n${refResult.stderr.trim()}`);
	process.exit(2);
}
const refCommit = refResult.stdout.trim();
// Short hashes for display; full hashes for the comparison, so a 7-char collision
// can never read as agreement. App Platform returns 40-char SHAs.
const refFull = (await run(["git", "rev-parse", REF])).stdout.trim();

/**
 * Is a deployment already on its way up, and is it the one this ref asks for?
 *
 * Computed before anything is decided, because **both** failure branches need it: the
 * no-ACTIVE case immediately below, and the drift case much further down.
 */
const situation = readDeployments(deployments, refFull);
const { inFlight, inFlightCommits, inFlightIsRef } = situation;
const inFlightShort = inFlightCommits.map((c) => c.slice(0, 7)).join(", ") || "no readable commit";

// The live deployment is the one with phase ACTIVE. There is at most one — and during a
// rebuild there is briefly NONE, which is the state this branch exists for.
const active = situation.active;
if (!active) {
	// 🚨 There being no ACTIVE deployment is the NORMAL state for part of every deploy,
	// not evidence of a problem. This branch used to exit 1 unconditionally, which made it
	// the earlier of two ways the drift watch cried wolf during a deploy window — and the
	// one that fires first, so fixing only the later one changes nothing.
	if (inFlight && inFlightIsRef) {
		console.log(`deploy-status: deploy in flight ✓`);
		console.log(`  ${REF.padEnd(8)} ${refCommit}`);
		console.log(`  live:    none yet  (no ACTIVE deployment during a rebuild)`);
		console.log(`  in flight: ${refCommit}  (${inFlight.phase.toLowerCase()})`);
		console.log("");
		console.log(`  ${REF} is deploying now. Re-run when it reaches ACTIVE.`);
		console.log("  (Exit 4, distinct from drift, so a scheduled check can tolerate it.)");
		process.exit(4);
	}
	if (inFlight) {
		console.error(
			`deploy-status: no ACTIVE deployment, and the one ${inFlight.phase.toLowerCase()} is ${inFlightShort}, not ${refCommit}.`,
		);
		console.error("  An older push may still be landing, or a deploy was created from the wrong");
		console.error("  SHA. Wait for it to settle, then re-run before acting.");
		process.exit(1);
	}
	console.error(
		`deploy-status: no ACTIVE deployment for ${APP_NAME}, and nothing is in flight. The app is unhealthy.`,
	);
	process.exit(1);
}

/** Collect the distinct commit hashes the live deployment was built from.
 *
 * App Platform stamps each component with the SHA it built from, and a
 * deployment carries one logical SHA for all four (api, web, worker, migrate)
 * in the normal case. Collecting the set rather than reading one means a
 * partial-failure state — some components built, some not — surfaces as a
 * disagreement with itself before it can disagree with `release`. */
const liveCommits = new Set(situation.liveCommits);

if (liveCommits.size === 0) {
	console.error(
		`deploy-status: ACTIVE deployment ${active.id} carries no component commit hashes.`,
	);
	process.exit(1);
}
if (liveCommits.size > 1) {
	console.error(
		`deploy-status: ACTIVE deployment ${active.id} was built from multiple commits: ${[...liveCommits].join(", ")}.`,
	);
	console.error("  This is a partial-failure state — some components built, some did not.");
	process.exit(1);
}

const liveCommit = [...liveCommits][0];

const agree = refFull === liveCommit || refCommit === liveCommit.slice(0, 7);

const ageMs = Date.now() - new Date(active.created_at).getTime();
const ageHours = (ageMs / 3_600_000).toFixed(1);

/**
 * How far `release` trails the branch work is merged to — the question this tool could not
 * previously ask.
 *
 * 🚨 On 2026-08-15 twenty commits sat on `main` while production ran the morning's build,
 * and this command reported **"in sync ✓"** the entire time — correctly, because live and
 * `release` agreed. The invariant it held was *"`release` deployed"*, never *"the work
 * shipped"*, and nothing anywhere held the second one. The gap surfaced only when a probe
 * against production returned 400 for a secret that should have worked.
 *
 * Behind-ness is NOT a fault on its own: promoting `main` to `release` is a deliberate act,
 * and merged-but-unshipped is a normal mid-flight state. So this reports rather than fails —
 * with its own exit code, so a caller can decide. Making it red by default would put the
 * hourly watcher in a permanent alarm state during ordinary development, and a watcher that
 * cries wolf gets muted, which is how this repo lost the last one.
 */
const PROMOTE_FROM =
	process.env.PROMOTE_FROM ?? (REF.startsWith("origin/") ? "origin/main" : "main");
let unshipped = 0;
let promoteHead = "";
if (REF !== PROMOTE_FROM) {
	const head = await run(["git", "rev-parse", "--short=7", PROMOTE_FROM]);
	const countResult = await run(["git", "rev-list", "--count", `${REF}..${PROMOTE_FROM}`]);
	if (head.ok && countResult.ok) {
		promoteHead = head.stdout.trim();
		unshipped = Number.parseInt(countResult.stdout.trim(), 10) || 0;
	}
	// Failure here is not fatal: a shallow clone or a missing local `main` makes this
	// unanswerable, and an unanswerable extra question must not break the primary check.
}

if (agree && unshipped > 0) {
	console.log(
		`deploy-status: live matches ${REF} ✓ — but ${REF} is ${unshipped} commit(s) behind ${PROMOTE_FROM}.`,
	);
	console.log(`  ${PROMOTE_FROM.padEnd(8)} ${promoteHead}`);
	console.log(`  ${REF.padEnd(8)} ${refCommit}`);
	console.log(
		`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
	);
	console.log("");
	console.log(`  🚨 Production does NOT contain work merged to ${PROMOTE_FROM}. This is not a`);
	console.log("     deploy failure — it is work that was never promoted. Ship it with:");
	console.log(`       git push origin ${PROMOTE_FROM}:${REF}`);
	console.log("  (Exit 3, distinct from drift, so a scheduled check can tolerate it.)");
	process.exit(3);
}

if (agree) {
	console.log(`deploy-status: in sync ✓`);
	if (promoteHead) console.log(`  ${PROMOTE_FROM.padEnd(8)} ${promoteHead}`);
	console.log(`  ${REF.padEnd(8)} ${refCommit}`);
	console.log(
		`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
	);
	process.exit(0);
}

/**
 * Which side leads, because a mismatch is not always production's fault.
 *
 * This used to report every disagreement as *"production is serving a stale build"* and
 * recommend pushing again. On 2026-08-15 the mismatch ran the other way: the LOCAL `release`
 * branch was stale (this compares against the local ref unless `REF=origin/release`), so
 * live was **ahead**, and both the diagnosis and the suggested recovery were backwards.
 * Confidently wrong about a deploy is worse than silent about one.
 */
const liveIsDescendant = (await run(["git", "merge-base", "--is-ancestor", REF, liveCommit])).ok;

// 🚨 The in-flight facts are only CONSULTED here, after live and the ref are known to
// disagree — so a deploy in progress can soften a mismatch and can never hide one. It is
// an explanation only when the thing being deployed is precisely the commit we asked for.
if (inFlightIsRef) {
	console.log(`deploy-status: deploy in flight ✓`);
	console.log(`  ${REF.padEnd(8)} ${refCommit}`);
	console.log(
		`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
	);
	console.log(`  in flight: ${refCommit}  (${inFlight?.phase.toLowerCase()})`);
	console.log("");
	console.log(`  Production has not caught up to ${REF} YET, and is on its way. Nothing to do`);
	console.log("  but wait — re-run when the deployment reaches ACTIVE.");
	console.log("  (Exit 4, distinct from drift, so a scheduled check can tolerate it.)");
	process.exit(4);
}

console.error(`deploy-status: DRIFT — live and ${REF} disagree.`);
console.error(`  ${REF.padEnd(8)} ${refCommit}`);
console.error(
	`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
);
console.error("");
if (liveIsDescendant) {
	console.error(`  Live is AHEAD of ${REF} — production has commits your ref does not.`);
	console.error("  Usually a stale local branch rather than a deploy problem.");
	// Only suggest the refresh when REF is a plain local branch. For `origin/release` or
	// `release~1` the command would be malformed, and printing a broken recovery is how a
	// tool teaches people to stop reading its output.
	if (/^[\w.-]+$/.test(REF)) {
		console.error("  Check with:");
		console.error(`    git fetch origin && git branch -f ${REF} origin/${REF}`);
		console.error(`  or re-run against the remote: REF=origin/${REF} make deploy-status`);
	}
} else if (inFlight) {
	// Something IS deploying — just not this. Saying "nothing deployed" here would be the
	// same class of confidently-wrong the live-is-ahead branch above exists to prevent.
	console.error(
		`  A deployment is ${inFlight.phase.toLowerCase()}, but from ${inFlightShort} rather than ${refCommit}.`,
	);
	console.error("  Either an older push is still landing, or a deploy was created by hand from");
	console.error(`  the wrong SHA. Wait for it to settle, then re-run before acting.`);
} else {
	// 🚨 The old text ended with "Nothing is in flight — this is a real stale build, not a
	// deploy in progress", which is a confident denial of the thing most likely to be
	// happening. DigitalOcean has no deployment for the few minutes CI spends on `test`,
	// `browser`, `browser-media` and `images` before `deploy` runs, and the script knew
	// only what DigitalOcean had. So ask GitHub before concluding anything, and when the
	// answer cannot be had, say that instead of asserting the opposite.
	const ci = await ciRunsFor(refFull);
	if (ci.situation?.pending) {
		const runName = ci.situation.pending.name ?? "a workflow";
		console.log(`deploy-status: CI still running ✓`);
		console.log(`  ${REF.padEnd(8)} ${refCommit}`);
		console.log(
			`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
		);
		console.log(
			`  ${runName} is ${ci.situation.pending.status.replace("_", " ")} for ${refCommit} — the deploy job has not reached`,
		);
		console.log("  DigitalOcean yet, so there is nothing in flight there to see.");
		if (ci.situation.pending.html_url) console.log(`  ${ci.situation.pending.html_url}`);
		console.log("  (Exit 5, distinct from drift, so a scheduled check can tolerate it.)");
		process.exit(5);
	}
	console.error("  Production is serving a stale build: the push succeeded, nothing deployed.");
	if (ci.situation?.failed) {
		// The most useful thing this branch can say, and it could not say it before.
		const failed = ci.situation.failed;
		console.error(
			`  CI ran for ${refCommit} and finished ${failed.conclusion} — that is why nothing deployed.`,
		);
		if (failed.html_url) console.error(`    ${failed.html_url}`);
	} else if (ci.situation) {
		console.error(`  GitHub has no workflow run for ${refCommit} at all. Likely causes:`);
		console.error("    - the push did not trigger CI (a workflow condition, or a disabled run)");
		console.error("    - the deploy was created manually but from a different SHA");
	} else {
		// The honest version of the sentence this branch used to end on.
		console.error(`  GitHub could not be asked whether CI is still running: ${ci.why}`);
		console.error("  So this may be a stale build, or a deploy that has not reached");
		console.error("  DigitalOcean yet. Check the Actions tab before acting.");
	}
	console.error("  Recover: doctl apps create-deployment <app-id>  (CI's escape hatch, by hand)");
	console.error("          or merge the missing work into release and push again.");
}
process.exit(1);
