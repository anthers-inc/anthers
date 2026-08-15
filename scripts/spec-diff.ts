// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Diff each **committed** App Platform spec against the **live** one. Both apps are
 * covered: `anthers` (the hub) and `anthers-studio`.
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
 * deploy can clobber live config that exists only in App Platform. It is to make the
 * drift **loud**: accept that the two diverge, and have something say so out loud.
 *
 * This file used to name `anthers-studio` as the example of config living only in App
 * Platform, and on 2026-08-11 that stopped being tolerable rather than stopping being
 * true: apps cannot be transferred between DigitalOcean accounts, so the move to an
 * Anthers-owned account recreates each app from a spec — and the Studio had none. It is
 * captured in `.do/studio.app.yaml` now, and checked here so it cannot quietly rot into
 * a second document that lies.
 *
 * WHAT IT COMPARES, and why not a raw diff: live SECRET values come back encrypted
 * (`EV[1:...]`), so a textual diff is pure noise and would be ignored within a week.
 * This compares the **set of env keys** per component — the failure class every real
 * incident above belongs to — plus the *values* of non-secret keys, where a drifted
 * `STRIPE_PRICE_SEED` would matter. Secrets are compared on presence alone.
 *
 * 🚨 **"Presence alone" was not enough, and 2026-08-15 is what that cost.** A
 * `doctl apps update --spec .do/app.yaml` set all seven app-level secrets to the EMPTY
 * STRING — the committed file declares them valueless, and App Platform reads that as an
 * instruction rather than an omission. Every one came back from `spec get` as a
 * well-formed `EV[1:…]`, so it was *present*, so this tool reported "specs agree ✓" while
 * production could not boot. That is the identical shape as the custom-domains gap below,
 * and the fix is the same: an empty secret is detectable without decrypting anything
 * (see `isEmptySecret`), so it is now checked on the live side and fails the run.
 *
 * It also compares each component's **`deploy_on_push` and branch**, added when the CI
 * deploy gate landed: `false` in this file is worthless if the live app says `true`, and
 * an env-only diff would have called that agreement.
 *
 * Usage:  make spec-diff            (or: bun run scripts/spec-diff.ts)
 * Needs:  doctl, authenticated. Exits 0 with a notice when it is absent, so this is
 *         safe to call from a machine that cannot reach DigitalOcean.
 */

/**
 * Every committed spec, with the env var that overrides its app-id lookup.
 *
 * `anthers-studio` joined the list on 2026-08-11, when its spec was captured into this
 * repo for the first time. It had never been here — which this file's own header used
 * as the example of config that exists only in App Platform — and the Anthers-owned
 * account migration turned that from a documentation gap into a single point of loss,
 * since App Platform apps cannot be transferred between accounts and must be recreated
 * from a spec. Committing it without checking it would only have added a second
 * document free to drift; this is the half that keeps it honest.
 */
import {
	COMPONENT_KINDS,
	CONTEXT,
	ctxArgs,
	type EnvEntry,
	envMap,
	isEmptySecret,
	isSecret,
	resolveAppId,
	run,
	type Spec,
} from "./do-spec";

const SPECS: { path: string; idEnv: string }[] = [{ path: ".do/app.yaml", idEnv: "DO_APP_ID" }];

/**
 * Live secrets that are *deliberately* empty, each with the reason.
 *
 * Empty is a real posture for a couple of these — `SITE_PASSWORD` empty is how the
 * pre-launch gate gets retired at launch (`matchesSitePassword` fails closed on it, so the
 * gate stops opening rather than starts) — and a check with no way to say "yes, on purpose"
 * gets switched off wholesale the first time it is inconvenient.
 *
 * Every entry is PRINTED on every run, in both the clean and dirty paths, so an exemption
 * cannot go quiet the way the thing it exempts did. Same rule as `econ:allow-file`.
 */
const EXPECTED_EMPTY: Record<string, string> = {};

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
			const where = component.name ?? kind;
			// Compared for every component, not only ones with a github source. It was
			// added for a P2P hazard that no longer exists (the peer registry it guarded
			// was removed 2026-08-11), and it stays because a silent instance-count drift
			// is worth seeing on its own: it changes both the bill and the concurrency
			// assumptions of anything holding per-process state.
			out.set(`${where}/instance_count`, String(component.instance_count ?? 1));
			const g = component.github;
			if (!g) continue;
			out.set(`${where}/deploy_on_push`, String(g.deploy_on_push ?? false));
			out.set(`${where}/branch`, g.branch ?? "");
		}
	}
	return out;
}

/**
 * Custom domains, as `domain → type`.
 *
 * Added 2026-08-11, after this tool reported "specs agree ✓" throughout an outage it was
 * the designated check for. `anthers.org` returned 404 for everything on the rebuilt app:
 * DNS was correct and the app was healthy, but App Platform routes on the Host header and
 * the new app claimed no domains. The committed spec had never declared them either — so
 * the drift was invisible for as long as the old app existed, and surfaced only when
 * production was rebuilt from the file.
 *
 * A missing domain is not a cosmetic difference; it is the difference between an app that
 * serves and one that 404s. Comparing env keys and source settings while ignoring it made
 * the green tick actively misleading.
 */
function domainMap(spec: Spec): Map<string, string> {
	const out = new Map<string, string>();
	for (const d of spec.domains ?? []) if (d.domain) out.set(d.domain, d.type ?? "PRIMARY");
	return out;
}

if (!(await run(["which", "doctl"])).ok) {
	console.log("spec-diff: doctl not installed — skipping the live comparison.");
	process.exit(0);
}

if (CONTEXT) console.log(`spec-diff: using doctl context "${CONTEXT}"`);

/** Compare one committed spec against its live counterpart. Returns true when they agree. */
async function diffSpec({ path, idEnv }: { path: string; idEnv: string }): Promise<boolean> {
	const committed = Bun.YAML.parse(await Bun.file(path).text()) as Spec;

	// The app id isn't in the committed spec (it's assigned at creation), so resolve it by
	// the spec's own name rather than making every caller pass one.
	const appName = committed.name ?? "anthers";
	const appId = await resolveAppId(appName, idEnv);
	if (!appId) {
		// Dirty, not fatal: with more than one spec in play, a missing app is a finding
		// about that app and not a reason to stop reporting on the others. The run still
		// exits non-zero, which is what the old `process.exit(1)` was actually for.
		console.error(`\nspec-diff: no App Platform app named "${appName}" (declared in ${path}).`);
		return false;
	}

	const live = await run(["doctl", "apps", "spec", "get", appId, ...ctxArgs]);
	if (!live.ok) {
		console.log(
			`spec-diff: could not fetch the live spec for ${appName} — skipping.\n${live.stderr.trim()}`,
		);
		return true;
	}

	const repoEnvs = envMap(committed);
	const liveSpec = Bun.YAML.parse(live.stdout) as Spec;
	const liveEnvs = envMap(liveSpec);

	const onlyLive: string[] = [];
	const onlyRepo: string[] = [];
	const differs: string[] = [];

	/**
	 * 🚨 Live secrets whose value is the empty string — see `isEmptySecret`.
	 *
	 * Checked across EVERY live secret, not only the ones the committed file also declares.
	 * The clobber empties them all in a single command, and a key this file has forgotten to
	 * mention is precisely the one nobody is watching — which is the whole reason the Stripe
	 * block went unnoticed in production for weeks.
	 */
	const emptySecrets: string[] = [];
	const exemptEmpty: string[] = [];
	for (const [id, entry] of liveEnvs) {
		if (!isEmptySecret(entry)) continue;
		const why = EXPECTED_EMPTY[id] ?? EXPECTED_EMPTY[id.split("/")[1] ?? id];
		if (why) exemptEmpty.push(`${id} — ${why}`);
		else emptySecrets.push(id);
	}

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
		const liveEntry = liveEnvs.get(liveId) as EnvEntry;
		const repo = repoEnvs.get(twin) as EnvEntry;
		const same =
			isSecret(liveEntry) || isSecret(repo) || (liveEntry.value ?? "") === (repo.value ?? "");
		relocated.push(
			`${bare(liveId)}\n      live: ${liveId}${isSecret(liveEntry) ? " (secret)" : ` = ${liveEntry.value ?? ""}`}` +
				`\n      repo: ${twin}${isSecret(repo) ? " (secret)" : ` = ${repo.value ?? ""}`}` +
				(same
					? ""
					: "\n      ⚠ SAME KEY, DIFFERENT SCOPE **AND** DIFFERENT VALUE — read both before changing either"),
		);
		onlyLive.splice(onlyLive.indexOf(liveId), 1);
		onlyRepo.splice(onlyRepo.indexOf(twin), 1);
	}

	const domainDiffs: string[] = [];
	const repoDomains = domainMap(committed);
	const liveDomains = domainMap(liveSpec);
	for (const [d, type] of liveDomains)
		if (!repoDomains.has(d)) domainDiffs.push(`${d}\n      live: ${type}\n      repo: (absent)`);
	for (const [d, type] of repoDomains) {
		if (!liveDomains.has(d)) {
			domainDiffs.push(
				`${d}\n      live: (absent) — the app does not claim this name, so it 404s\n      repo: ${type}`,
			);
		} else if (liveDomains.get(d) !== type) {
			domainDiffs.push(`${d}\n      live: ${liveDomains.get(d)}\n      repo: ${type}`);
		}
	}

	const repoSource = sourceMap(committed);
	const liveSource = sourceMap(liveSpec);
	const sourceDiffs: string[] = [];
	for (const [id, mineValue] of repoSource) {
		const theirs = liveSource.get(id);
		if (theirs === undefined) {
			sourceDiffs.push(`${id}\n      live: (component absent)\n      repo: ${mineValue}`);
		} else if (theirs !== mineValue) {
			let gate = "";
			if (id.endsWith("/deploy_on_push")) {
				gate =
					"\n      ⚠ THIS IS THE DEPLOY GATE — `true` in production means pushes deploy without CI";
			}
			sourceDiffs.push(`${id}\n      live: ${theirs}\n      repo: ${mineValue}${gate}`);
		}
	}

	const clean =
		!domainDiffs.length &&
		!onlyLive.length &&
		!onlyRepo.length &&
		!differs.length &&
		!relocated.length &&
		!sourceDiffs.length &&
		!emptySecrets.length;
	console.log(`\n## Spec diff — ${appName} (${appId})\n`);

	// First, and on its own: every other finding here is configuration that disagrees with
	// itself, which is worth a look. This one is production missing a credential.
	if (emptySecrets.length) {
		console.log("  🚨 LIVE SECRETS THAT ARE EMPTY:");
		for (const id of emptySecrets.sort()) console.log(`    ! ${id}`);
		console.log("    → Something applied a spec whose SECRET entries carried no value, and");
		console.log("      App Platform read that as 'set it to empty'. The values are NOT");
		console.log("      recoverable from the live spec — recover them from the last good");
		console.log("      deployment and re-apply:");
		console.log(`        doctl apps spec get ${appId} --deployment <last-good-id>`);
		console.log("      then `make spec-apply`, which never sends a valueless secret.\n");
	}
	// Printed in both paths, clean or dirty, so an exemption cannot go quiet.
	if (exemptEmpty.length) {
		console.log("  Empty live secrets, exempted in EXPECTED_EMPTY:");
		for (const line of exemptEmpty.sort()) console.log(`    · ${line}`);
		console.log("");
	}

	if (onlyLive.length) {
		console.log(`  Running in production, absent from ${path}:`);
		for (const id of onlyLive.sort()) console.log(`    + ${id}`);
		console.log("    → either declare it here, or remove it from the live spec if it is dead.\n");
	}
	if (onlyRepo.length) {
		console.log(`  Declared in ${path}, absent from production:`);
		for (const id of onlyRepo.sort()) console.log(`    - ${id}`);
		console.log(
			"    → `doctl apps update --spec` if it should be live. Pushing never applies it.\n",
		);
	}
	if (relocated.length) {
		console.log("  Declared at different scopes in each spec:");
		for (const r of relocated.sort()) console.log(`    ≠ ${r}`);
		console.log("");
	}
	if (domainDiffs.length) {
		console.log("  Custom domains that disagree:");
		for (const d of domainDiffs.sort()) console.log(`    ! ${d}`);
		console.log("    → App Platform routes on the Host header: a name the app does not");
		console.log("      claim returns 404 however correct DNS is.\n");
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

	return clean;
}

// Sequential, not Promise.all: each spec prints a whole report, and interleaved output
// from two concurrent doctl calls would make both unreadable to save a second.
let allClean = true;
for (const spec of SPECS) {
	if (!(await diffSpec(spec))) allClean = false;
}

process.exit(allClean ? 0 : 1);
