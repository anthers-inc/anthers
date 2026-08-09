// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Diff the **committed** App Platform spec against the **live** one.
 *
 * Pushing to `release` ships code and never the spec, so `.do/app.yaml` and what is
 * actually running drift silently and by default — only `doctl apps spec get` can tell
 * you. That is not hypothetical: production ran for weeks with Stripe keys the committed
 * file didn't mention (which silently disabled seven `503 Payments are not configured`
 * guards), and as of 2026-08-09 it still carried `STRIPE_SUBSCRIPTION_WEBHOOK_SECRET`
 * (whose last consumer PR #118 removed) and `SESSION_SECRET` (which **no file in this
 * repository reads at all**), while `STUDIO_URL` ran in production undeclared here.
 *
 * The fix Parker chose is not to make the committed spec authoritative — pushing it on
 * deploy can clobber live config that exists only in App Platform, including the whole
 * `anthers-studio` app, whose spec has never been in this repo. It is to make the drift
 * **loud**: accept that the two diverge, and have something say so out loud.
 *
 * WHAT IT COMPARES, and why not a raw diff: live SECRET values come back encrypted
 * (`EV[1:...]`), so a textual diff is pure noise and would be ignored within a week.
 * This compares the **set of env keys** per component — the failure class every real
 * incident above belongs to — plus the *values* of non-secret keys, where a drifted
 * `STRIPE_PRICE_SEED` would matter. Secrets are compared on presence alone.
 *
 * It also compares each component's **`deploy_on_push` and branch**, added when the CI
 * deploy gate landed: `false` in this file is worthless if the live app says `true`, and
 * an env-only diff would have called that agreement.
 *
 * Usage:  make spec-diff            (or: bun run scripts/spec-diff.ts)
 * Needs:  doctl, authenticated. Exits 0 with a notice when it is absent, so this is
 *         safe to call from a machine that cannot reach DigitalOcean.
 */

const COMMITTED = ".do/app.yaml";

type EnvEntry = { key?: string; value?: string; type?: string; scope?: string };
type GitHubSource = { repo?: string; branch?: string; deploy_on_push?: boolean };
type Component = { name?: string; envs?: EnvEntry[]; github?: GitHubSource };
type Spec = {
	name?: string;
	envs?: EnvEntry[];
	services?: Component[];
	workers?: Component[];
	jobs?: Component[];
	static_sites?: Component[];
	functions?: Component[];
};

const COMPONENT_KINDS = ["services", "workers", "jobs", "static_sites", "functions"] as const;

/** Flatten a spec to `component/KEY` → entry, so a key is compared where it lives. */
function envMap(spec: Spec): Map<string, EnvEntry> {
	const out = new Map<string, EnvEntry>();
	for (const e of spec.envs ?? []) if (e.key) out.set(`(app)/${e.key}`, e);
	for (const kind of COMPONENT_KINDS) {
		for (const component of spec[kind] ?? []) {
			const where = component.name ?? kind;
			for (const e of component.envs ?? []) if (e.key) out.set(`${where}/${e.key}`, e);
		}
	}
	return out;
}

const isSecret = (e: EnvEntry) => e.type === "SECRET" || (e.value ?? "").startsWith("EV[");

/**
 * Per-component source settings — `deploy_on_push` above all.
 *
 * Env keys were the whole comparison until 2026-08-09, and that left the tool blind to
 * the single field the deploy gate rests on. `deploy_on_push: false` in the committed
 * spec means nothing if the live app still has `true`: App Platform would keep building
 * on every push, the `deploy` job would be a second deploy racing the first, and CI's
 * verdict would quietly stop deciding anything — with this tool reporting agreement the
 * entire time. Anything that can silently un-gate production belongs in the diff.
 */
function sourceMap(spec: Spec): Map<string, string> {
	const out = new Map<string, string>();
	for (const kind of COMPONENT_KINDS) {
		for (const component of spec[kind] ?? []) {
			const g = component.github;
			if (!g) continue;
			const where = component.name ?? kind;
			out.set(`${where}/deploy_on_push`, String(g.deploy_on_push ?? false));
			out.set(`${where}/branch`, g.branch ?? "");
		}
	}
	return out;
}

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { ok: (await proc.exited) === 0, stdout, stderr };
}

const committedText = await Bun.file(COMMITTED).text();
const committed = Bun.YAML.parse(committedText) as Spec;

if (!(await run(["which", "doctl"])).ok) {
	console.log("spec-diff: doctl not installed — skipping the live comparison.");
	process.exit(0);
}

// The app id isn't in the committed spec (it's assigned at creation), so resolve it by
// the spec's own name rather than making every caller pass one.
const appName = committed.name ?? "anthers";
let appId = process.env.DO_APP_ID ?? "";
if (!appId) {
	const list = await run(["doctl", "apps", "list", "--format", "ID,Spec.Name", "--no-header"]);
	if (!list.ok) {
		console.log(`spec-diff: doctl could not list apps — skipping.\n${list.stderr.trim()}`);
		process.exit(0);
	}
	appId =
		list.stdout
			.split("\n")
			.map((l) => l.trim().split(/\s+/))
			.find(([, name]) => name === appName)?.[0] ?? "";
	if (!appId) {
		console.error(`spec-diff: no App Platform app named "${appName}".`);
		process.exit(1);
	}
}

const live = await run(["doctl", "apps", "spec", "get", appId]);
if (!live.ok) {
	console.log(`spec-diff: could not fetch the live spec — skipping.\n${live.stderr.trim()}`);
	process.exit(0);
}

const repoEnvs = envMap(committed);
const liveSpec = Bun.YAML.parse(live.stdout) as Spec;
const liveEnvs = envMap(liveSpec);

const onlyLive: string[] = [];
const onlyRepo: string[] = [];
const differs: string[] = [];

for (const [id, entry] of liveEnvs) {
	if (!repoEnvs.has(id)) onlyLive.push(id);
	else {
		const mine = repoEnvs.get(id) as EnvEntry;
		if (isSecret(entry) || isSecret(mine)) continue; // encrypted live — presence only
		if ((entry.value ?? "") !== (mine.value ?? "")) {
			differs.push(`${id}\n      live: ${entry.value ?? ""}\n      repo: ${mine.value ?? ""}`);
		}
	}
}
for (const id of repoEnvs.keys()) if (!liveEnvs.has(id)) onlyRepo.push(id);

/**
 * The same key at two different scopes is the dangerous case, and reporting it as one
 * "only live" plus one "only repo" line buries it — those read as two unrelated
 * placement nits, and no value comparison runs because the paths don't match.
 *
 * That is not hypothetical. `COOKIE_DOMAIN` sat app-level and valueless in the repo
 * while production ran `.anthers.org` on the api component, and this tool's first
 * report described it as a scope mismatch. Acting on that reading would have removed
 * a domain-scoped session cookie: every live session stranded (a cookie set with a
 * domain can only be cleared with the same domain) and the Studio subdomain, which
 * authenticates with it, signed out.
 */
const relocated: string[] = [];
const bare = (id: string) => id.split("/")[1] ?? id;
for (const liveId of onlyLive.slice()) {
	const twin = onlyRepo.find((r) => bare(r) === bare(liveId));
	if (!twin) continue;
	const live = liveEnvs.get(liveId) as EnvEntry;
	const repo = repoEnvs.get(twin) as EnvEntry;
	const same = isSecret(live) || isSecret(repo) || (live.value ?? "") === (repo.value ?? "");
	relocated.push(
		`${bare(liveId)}\n      live: ${liveId}${isSecret(live) ? " (secret)" : ` = ${live.value ?? ""}`}` +
			`\n      repo: ${twin}${isSecret(repo) ? " (secret)" : ` = ${repo.value ?? ""}`}` +
			(same
				? ""
				: "\n      ⚠ SAME KEY, DIFFERENT SCOPE **AND** DIFFERENT VALUE — read both before changing either"),
	);
	onlyLive.splice(onlyLive.indexOf(liveId), 1);
	onlyRepo.splice(onlyRepo.indexOf(twin), 1);
}

const repoSource = sourceMap(committed);
const liveSource = sourceMap(liveSpec);
const sourceDiffs: string[] = [];
for (const [id, mineValue] of repoSource) {
	const theirs = liveSource.get(id);
	if (theirs === undefined) {
		sourceDiffs.push(`${id}\n      live: (component absent)\n      repo: ${mineValue}`);
	} else if (theirs !== mineValue) {
		const gate = id.endsWith("/deploy_on_push")
			? "\n      ⚠ THIS IS THE DEPLOY GATE — `true` in production means pushes deploy without CI"
			: "";
		sourceDiffs.push(`${id}\n      live: ${theirs}\n      repo: ${mineValue}${gate}`);
	}
}

const clean =
	!onlyLive.length &&
	!onlyRepo.length &&
	!differs.length &&
	!relocated.length &&
	!sourceDiffs.length;
console.log(`\n## Spec diff — ${appName} (${appId})\n`);

if (onlyLive.length) {
	console.log("  Running in production, absent from .do/app.yaml:");
	for (const id of onlyLive.sort()) console.log(`    + ${id}`);
	console.log("    → either declare it here, or remove it from the live spec if it is dead.\n");
}
if (onlyRepo.length) {
	console.log("  Declared in .do/app.yaml, absent from production:");
	for (const id of onlyRepo.sort()) console.log(`    - ${id}`);
	console.log("    → `doctl apps update --spec` if it should be live. Pushing never applies it.\n");
}
if (relocated.length) {
	console.log("  Declared at different scopes in each spec:");
	for (const r of relocated.sort()) console.log(`    ≠ ${r}`);
	console.log("");
}
if (sourceDiffs.length) {
	console.log("  Component source settings that disagree:");
	for (const d of sourceDiffs.sort()) console.log(`    ! ${d}`);
	console.log("");
}
if (differs.length) {
	console.log("  Same key, different value (non-secret):");
	for (const d of differs.sort()) console.log(`    ~ ${d}`);
	console.log("");
}
if (clean) console.log("  Committed and live specs agree ✓\n");

process.exit(clean ? 0 : 1);
