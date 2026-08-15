// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Apply the **committed** App Platform spec to the live app without destroying the half the
 * committed file cannot carry.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────
 *
 * `.do/app.yaml` used to tell you, in its own header, to run:
 *
 *     doctl apps update <app-id> --spec .do/app.yaml
 *
 * That instruction is a loaded gun and it went off on 2026-08-15. The committed spec
 * declares every secret as `type: SECRET` with **no value** — it has to, because the values
 * must not be in git — and App Platform reads a valueless secret as *"set this to the empty
 * string"* rather than *"leave this one alone"*. One command emptied all seven app-level
 * secrets. The api container then crashed on the only two that are validated at boot
 * (`STORAGE_KEY`, `STORAGE_SECRET`); the other five failed silently. `doctl apps spec get`
 * kept reporting well-formed `EV[1:…]` blobs for all of them, so nothing looked wrong, and
 * re-applying the *live* spec faithfully re-applied the empties.
 *
 * The same command also silently dropped `features: [buildpack-stack=ubuntu-22]`, which the
 * committed file has never declared. Applying a partial description of production deletes
 * whatever the description omits — secrets are just the most expensive instance of that.
 *
 * ── What it does ───────────────────────────────────────────────────────────────────
 *
 * The committed file is the statement of intent, so it is the base. Then:
 *
 *   1. **Secret values are backfilled from the live spec.** A `type: SECRET` entry with no
 *      value takes the live `EV[1:…]`. It is never sent valueless — that is the bug.
 *   2. **An empty live secret is a hard stop**, not something to propagate. `isEmptySecret`
 *      knows one without decrypting it.
 *   3. **A secret with no value on either side stops the run** naming the key, rather than
 *      deploying a credential that is not there. Introduce one with `--set KEY=value`.
 *   4. **Live-only top-level fields are carried over**, and printed. `features` is the one
 *      that bit us; whatever the next one is, the default is to keep it.
 *   5. **Live-only env keys are REMOVALS** and need `--allow-remove`. Deleting production
 *      config is a decision, and it should read like one.
 *
 * Dry run by default. Nothing reaches DigitalOcean without `--apply`.
 *
 * Usage:
 *   DOCTL_CONTEXT=anthers make spec-apply                    # dry run — prints the plan
 *   DOCTL_CONTEXT=anthers make spec-apply APPLY=1            # actually update the app
 *   bun run scripts/spec-apply.ts --set NEW_SECRET=hunter2   # introduce a new secret
 *
 * Related: `make spec-diff` reports the drift this resolves, and now fails on an empty live
 * secret so this class of damage can never again be silent.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPONENT_KINDS,
	CONTEXT,
	type Component,
	ctxArgs,
	type EnvEntry,
	envMap,
	isEmptySecret,
	isSecret,
	resolveAppId,
	run,
	type Spec,
} from "./do-spec";

const SPEC_PATH = ".do/app.yaml";
const ID_ENV = "DO_APP_ID";

const argv = Bun.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALLOW_REMOVE = argv.includes("--allow-remove");
const outFlag = argv.indexOf("--out");

/** `--set KEY=value`, repeatable. The one way to introduce a secret with no live value. */
const overrides = new Map<string, string>();
for (let i = 0; i < argv.length; i++) {
	if (argv[i] !== "--set") continue;
	const pair = argv[i + 1] ?? "";
	const eq = pair.indexOf("=");
	if (eq < 1) {
		console.error(`spec-apply: --set wants KEY=value, got "${pair}".`);
		process.exit(2);
	}
	overrides.set(pair.slice(0, eq), pair.slice(eq + 1));
}

/** Walk every env entry in a spec, yielding the live object so it can be mutated in place. */
function* walkEnvs(spec: Spec): Generator<{ id: string; entry: EnvEntry }> {
	for (const e of spec.envs ?? []) if (e.key) yield { id: `(app)/${e.key}`, entry: e };
	for (const kind of COMPONENT_KINDS) {
		for (const component of (spec[kind] ?? []) as Component[]) {
			const where = component.name ?? kind;
			for (const e of component.envs ?? []) if (e.key) yield { id: `${where}/${e.key}`, entry: e };
		}
	}
}

if (!(await run(["which", "doctl"])).ok) {
	console.error("spec-apply: doctl is not installed — nothing to apply against.");
	process.exit(2);
}
if (CONTEXT) console.log(`spec-apply: using doctl context "${CONTEXT}"`);

const committed = Bun.YAML.parse(await Bun.file(SPEC_PATH).text()) as Spec;
const appName = committed.name ?? "anthers";
const appId = await resolveAppId(appName, ID_ENV);
if (!appId) {
	console.error(`spec-apply: no App Platform app named "${appName}" (declared in ${SPEC_PATH}).`);
	process.exit(2);
}

const liveRaw = await run(["doctl", "apps", "spec", "get", appId, ...ctxArgs]);
if (!liveRaw.ok) {
	console.error(`spec-apply: could not fetch the live spec.\n${liveRaw.stderr.trim()}`);
	process.exit(2);
}
const liveSpec = Bun.YAML.parse(liveRaw.stdout) as Spec;
const liveEnvs = envMap(liveSpec);

const merged = structuredClone(committed) as Spec;

// ── 1–3. Secret values ────────────────────────────────────────────────────────────────
const filled: string[] = [];
const fromFlag: string[] = [];
const emptyLive: string[] = [];
const unresolved: string[] = [];

for (const { id, entry } of walkEnvs(merged)) {
	if (!isSecret(entry) || (entry.value ?? "") !== "") continue;
	const key = entry.key as string;
	const override = overrides.get(key);
	if (override !== undefined) {
		entry.value = override;
		fromFlag.push(id);
		continue;
	}
	const live = liveEnvs.get(id);
	if (!live || (live.value ?? "") === "") {
		unresolved.push(id);
		continue;
	}
	if (isEmptySecret(live)) {
		emptyLive.push(id);
		continue;
	}
	entry.value = live.value;
	filled.push(id);
}

// ── 4. Live-only top-level fields ─────────────────────────────────────────────────────
const carried: string[] = [];
for (const key of Object.keys(liveSpec)) {
	if (key in merged) continue;
	merged[key] = liveSpec[key];
	carried.push(key);
}

// ── 5. Live-only env keys ─────────────────────────────────────────────────────────────
const mergedIds = new Set([...walkEnvs(merged)].map((e) => e.id));
const removals = [...liveEnvs.keys()].filter((id) => !mergedIds.has(id));

// ── Report ────────────────────────────────────────────────────────────────────────────
console.log(`\n## Spec apply — ${appName} (${appId})\n`);
const show = (title: string, lines: string[], note?: string) => {
	if (!lines.length) return;
	console.log(`  ${title}`);
	for (const l of lines.sort()) console.log(`    · ${l}`);
	if (note) console.log(`    ${note}`);
	console.log("");
};
show("Secret values preserved from the live app:", filled);
show("Secret values taken from --set (plaintext on this run):", fromFlag);
show(
	"Top-level fields carried over from live (absent from the committed spec):",
	carried,
	`→ consider declaring these in ${SPEC_PATH} so they stop depending on this step.`,
);
show(
	"Env keys that would be REMOVED from production:",
	removals,
	ALLOW_REMOVE
		? "→ --allow-remove was passed, so these will go."
		: "→ refusing. Declare them, or re-run with --allow-remove if they are genuinely dead.",
);

let fatal = false;
if (emptyLive.length) {
	console.log("  🚨 Live secrets that are already EMPTY — refusing to propagate:");
	for (const id of emptyLive.sort()) console.log(`    ! ${id}`);
	console.log("    → recover from the last good deployment, which still holds the real values:");
	console.log(`        doctl apps spec get ${appId} --deployment <last-good-id>`);
	console.log("      or supply one with --set KEY=value.\n");
	fatal = true;
}
if (unresolved.length) {
	console.log("  🚨 Secrets with no value in the committed spec AND none live:");
	for (const id of unresolved.sort()) console.log(`    ! ${id}`);
	console.log("    → supply each with --set KEY=value, or set it in the DO dashboard first.\n");
	fatal = true;
}
if (removals.length && !ALLOW_REMOVE) fatal = true;
if (fatal) {
	console.error("spec-apply: nothing was sent.\n");
	process.exit(1);
}

const outPath =
	outFlag >= 0
		? (argv[outFlag + 1] as string)
		: join(tmpdir(), `anthers-spec-apply-${appName}.yaml`);
await Bun.write(outPath, Bun.YAML.stringify(merged));
console.log(`  Merged spec written to ${outPath}`);
console.log(
	"  ⚠ It holds live secret values (encrypted, and plaintext for any --set). Not for git.\n",
);

if (!APPLY) {
	console.log("  Dry run — nothing sent. Re-run with APPLY=1 (or --apply) to update the app.\n");
	process.exit(0);
}

const update = await run(["doctl", "apps", "update", appId, "--spec", outPath, ...ctxArgs]);
console.log(update.stdout.trim() || update.stderr.trim());
if (!update.ok) {
	console.error("\nspec-apply: doctl rejected the update.");
	process.exit(1);
}
console.log(
	"\n  Applied. App Platform is building a new deployment — watch it with:\n" +
		`    doctl apps list-deployments ${appId} ${ctxArgs.join(" ")}\n` +
		"  and confirm with `make deploy-status` once it is ACTIVE.\n",
);
