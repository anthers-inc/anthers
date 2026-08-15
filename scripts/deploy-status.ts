// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Compare the commit App Platform is actually serving against what `release`
 * points at, and fail if they disagree.
 *
 * `deploy_on_push` is false on every component, so the CI `deploy` job is the
 * only path to production — and if that job does not run for any reason, the
 * push to `release` succeeds and nothing deploys. Git reports success, the
 * branch moves, the site keeps serving the old build. A successful push is
 * indistinguishable from a successful deploy, and nothing local or in CI could
 * tell the difference: `make verify` does not build images, and `apps
 * list-deployments` returns the *previous* deployment as `ACTIVE`, which reads
 * as success. The verification that actually works, used on 2026-08-14 to
 * recover from a silent stale-deploy: assert the **commit hash** the live
 * deployment was built from, against what `release` points at. See the task:
 * 00-09 Meta/Tasks/Active/A push to release can succeed while nothing deploys.md
 *
 * Two modes:
 *
 *   make deploy-status               Compare live vs local `release` (default).
 *   make deploy-status REF=origin/release   Compare live vs an arbitrary ref.
 *
 * Exits 0 when they agree, 1 when they disagree, and 2 when the live state
 * cannot be determined (doctl missing/unauthenticated, or no deployment with a
 * `source_commit_hash` at all). The 2-vs-1 split is deliberate: a disagreement
 * is a finding worth a human; an unreachable API is a tooling gap, not a
 * finding, and should not read as "drift detected".
 *
 * Needs: doctl, authenticated. Exits 0 with a notice when it is absent, so this
 *        is safe to call from a machine that cannot reach DigitalOcean — the
 *        scheduled workflow gates on doctl availability separately.
 */
import { $ } from "bun";

/** Which `doctl` account to compare against, via `DOCTL_CONTEXT`. Same rule as
 * `spec-diff.ts`: production is under an Anthers-owned account, and without this
 * the tool silently compares against whichever account `doctl` is pointed at. */
const CONTEXT = (process.env.DOCTL_CONTEXT ?? "").trim();
const ctxArgs = CONTEXT ? ["--context", CONTEXT] : [];

/** The app-id comes from the `DO_APP_ID` env var (CI) or is resolved by name
 * (local), exactly as `spec-diff.ts` resolves it — the id is assigned at
 * creation and is not in the committed spec. */
const APP_NAME = "anthers";

type Deployment = {
	id: string;
	cause: string;
	phase: string;
	created_at: string;
	services?: { name?: string; source_commit_hash?: string }[];
	static_sites?: { name?: string; source_commit_hash?: string }[];
	workers?: { name?: string; source_commit_hash?: string }[];
	jobs?: { name?: string; source_commit_hash?: string }[];
};

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { ok: (await proc.exited) === 0, stdout, stderr };
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

// The live deployment is the one with phase ACTIVE. There is at most one; if a
// rebuild is in flight there may be zero, which is a state worth surfacing too.
const active = deployments.find((d) => d.phase === "ACTIVE");
if (!active) {
	console.error(
		`deploy-status: no ACTIVE deployment for ${APP_NAME}. A rebuild may be in flight, or the app is unhealthy.`,
	);
	process.exit(1);
}

/** Every component kind that can carry a `source_commit_hash`. */
const COMPONENT_KINDS = ["services", "static_sites", "workers", "jobs"] as const;

/** Collect the distinct commit hashes the live deployment was built from.
 *
 * App Platform stamps each component with the SHA it built from, and a
 * deployment carries one logical SHA for all four (api, web, worker, migrate)
 * in the normal case. Collecting the set rather than reading one means a
 * partial-failure state — some components built, some not — surfaces as a
 * disagreement with itself before it can disagree with `release`. */
const liveCommits = new Set<string>();
for (const kind of COMPONENT_KINDS) {
	for (const c of active[kind] ?? []) {
		if (c.source_commit_hash && c.source_commit_hash.length >= 7) {
			liveCommits.add(c.source_commit_hash);
		}
	}
}

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

// The ref to compare against: `release` locally by default, overridable via REF.
// CI passes `REF=origin/release` because the scheduled check has no local branch
// state worth trusting — only the remote ref is what App Platform builds from.
const REF = process.env.REF ?? "release";
const refResult = await run(["git", "rev-parse", `--short=7`, REF]);
if (!refResult.ok) {
	console.error(`deploy-status: could not resolve ref "${REF}".\n${refResult.stderr.trim()}`);
	process.exit(2);
}
const refCommit = refResult.stdout.trim();

// Short hashes for display; full hashes for the comparison, so a 7-char collision
// can never read as agreement. App Platform returns 40-char SHAs.
const refFull = (await run(["git", "rev-parse", REF])).stdout.trim();
const agree = refFull === liveCommit || refCommit === liveCommit.slice(0, 7);

const ageMs = Date.now() - new Date(active.created_at).getTime();
const ageHours = (ageMs / 3_600_000).toFixed(1);

if (agree) {
	console.log(`deploy-status: in sync ✓`);
	console.log(`  release: ${refCommit}  (${REF})`);
	console.log(
		`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
	);
	process.exit(0);
}

console.error(`deploy-status: DRIFT — production is serving a stale build.`);
console.error(`  release: ${refCommit}  (${REF})`);
console.error(
	`  live:    ${liveCommit.slice(0, 7)}  (deployed ${ageHours}h ago, cause: ${active.cause})`,
);
console.error("");
console.error("  The push to release succeeded; nothing deployed. Likely causes:");
console.error("    - the CI `deploy` job did not run (billing, a failing upstream job, etc.)");
console.error("    - the deploy was created manually but from a different SHA");
console.error("  Recover: doctl apps create-deployment <app-id>  (CI's escape hatch, by hand)");
console.error("          or merge the missing work into release and push again.");
process.exit(1);
