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
 * With Bitwarden Secrets Manager as the source of truth (`FROM_BWS=1` → `--from-bws`):
 *
 *   DOCTL_CONTEXT=anthers make spec-apply FROM_BWS=1
 *   DOCTL_CONTEXT=anthers make spec-apply FROM_BWS=1 APPLY=1
 *
 * The dry run is worth reading before the second line: it reports which secrets the
 * vault would CHANGE in production, by comparing the supplied value's byte length
 * against the live plaintext length recovered from the encrypted blob. That catches a stale
 * or wrong vault entry before it is sent, and it needs no ability to decrypt anything.
 *
 * Related: `make spec-diff` reports the drift this resolves, and now fails on an empty live
 * secret so this class of damage can never again be silent.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
	secretPlaintextLength,
} from "./do-spec";

const SPEC_PATH = ".do/app.yaml";
const ID_ENV = "DO_APP_ID";

const argv = Bun.argv.slice(2);
const APPLY = argv.includes("--apply");
const ALLOW_REMOVE = argv.includes("--allow-remove");
const outFlag = argv.indexOf("--out");

/**
 * `--from-bws`: take secret values from Bitwarden Secrets Manager, asked directly.
 *
 *     DOCTL_CONTEXT=anthers make spec-apply FROM_BWS=1            # dry run
 *     DOCTL_CONTEXT=anthers make spec-apply FROM_BWS=1 APPLY=1    # send it
 *
 * `.do/app.yaml` already declares exactly which keys are secret, and the vault stores them
 * under those same names, so the two line up with no third list to maintain and drift.
 *
 * 🚨 **This queries `bws` rather than reading `process.env`, and the difference is not
 * stylistic — it is the only correct option here.** The first cut was `--from-env`, meant to
 * be wrapped in `bws run -- …`, which injects a project's secrets as environment variables.
 * That is unusable in this repo: **Bun auto-loads `.env` into `process.env` on every `bun
 * run`**, so the script saw the developer's LOCAL values and could not distinguish them from
 * vault-injected ones. `make spec-apply FROM_ENV=1 APPLY=1` typed without the `bws run`
 * wrapper would have pushed the contents of a gitignored dev file straight to production —
 * the same clobber this tool exists to prevent, arriving through the mechanism added to fix
 * it. It was caught only because the length check below flagged `RESEND_API_KEY` as a change
 * nobody had asked for.
 *
 * An opt-in flag does not save you from ambient state, because the ambience is applied by
 * the runtime before your first line runs. Asking the source of truth a direct question has
 * no such failure mode.
 */
const FROM_BWS = argv.includes("--from-bws");

/** The Secrets Manager project holding these values. Auto-resolved when the token sees one. */
const projectFlag = argv.indexOf("--bws-project");
const BWS_PROJECT = projectFlag >= 0 ? (argv[projectFlag + 1] as string) : "";

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

/**
 * Every secret in the Bitwarden project, as `key → value`.
 *
 * The access token is read from `BWS_ACCESS_TOKEN` or, failing that, the file `bws` itself
 * defaults its config beside — and it is handed to the child through its ENVIRONMENT, never
 * as `--access-token` on the command line, which would publish it in `/proc/<pid>/cmdline`
 * for the duration of the call.
 */
async function bwsSecrets(): Promise<Map<string, string>> {
	const tokenFile = `${process.env.HOME}/.config/bws/token`;
	let token = (process.env.BWS_ACCESS_TOKEN ?? "").trim();
	if (!token)
		token = (
			await Bun.file(tokenFile)
				.text()
				.catch(() => "")
		).trim();
	if (!token) {
		console.error(`spec-apply: no BWS_ACCESS_TOKEN and nothing readable at ${tokenFile}.`);
		process.exit(2);
	}
	const env = { BWS_ACCESS_TOKEN: token };

	let project = BWS_PROJECT;
	if (!project) {
		const list = await run(["bws", "project", "list", "-o", "json"], env);
		if (!list.ok) {
			console.error(`spec-apply: bws could not list projects.\n${list.stderr.trim()}`);
			process.exit(2);
		}
		const projects = JSON.parse(list.stdout) as { id: string; name: string }[];
		/**
		 * Resolve by NAME — the app's own name from the spec — rather than by a committed
		 * UUID. Same reasoning `ci.yml` gives for keeping `DO_APP_ID` in a repository
		 * variable: an infrastructure identifier is useless without a token, but it is still
		 * infrastructure identity and this repo is world-readable.
		 *
		 * The match is exact (case-insensitively), which is what keeps a sibling project
		 * apart: "Anthers Dev" holds the DEVELOPMENT credentials and must never be mistaken
		 * for the one production reads from. A prefix or fuzzy match would eventually pick it.
		 */
		const named = projects.filter((p) => p.name.toLowerCase() === appName.toLowerCase());
		const chosen = named.length === 1 ? named[0] : projects.length === 1 ? projects[0] : undefined;
		if (!chosen) {
			console.error(
				`spec-apply: cannot tell which bws project holds "${appName}" — name one with --bws-project <id>:\n` +
					projects.map((p) => `    ${p.id}  ${p.name}`).join("\n"),
			);
			process.exit(2);
		}
		project = chosen.id;
		console.log(`spec-apply: using bws project "${chosen.name}"`);
	}

	const listed = await run(["bws", "secret", "list", project, "-o", "json"], env);
	if (!listed.ok) {
		console.error(`spec-apply: bws could not list secrets.\n${listed.stderr.trim()}`);
		process.exit(2);
	}
	const out = new Map<string, string>();
	for (const s of JSON.parse(listed.stdout) as { key: string; value: string }[]) {
		out.set(s.key, s.value);
	}
	return out;
}

if (!(await run(["which", "doctl"])).ok) {
	console.error("spec-apply: doctl is not installed — nothing to apply against.");
	process.exit(2);
}
if (FROM_BWS && !(await run(["which", "bws"])).ok) {
	console.error("spec-apply: --from-bws needs the `bws` CLI on PATH.");
	process.exit(2);
}
if (CONTEXT) console.log(`spec-apply: using doctl context "${CONTEXT}"`);

// The committed spec is read FIRST because everything downstream is named by it — the
// App Platform app, and now the Bitwarden project too. `bwsSecrets()` used to run above
// this line and referenced `appName` before it was initialized, which under `const` is a
// TDZ ReferenceError rather than an `undefined` to shrug at.
const committed = Bun.YAML.parse(await Bun.file(SPEC_PATH).text()) as Spec;
const appName = committed.name ?? "anthers";

const vault = FROM_BWS ? await bwsSecrets() : new Map<string, string>();

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
const fromVault: string[] = [];
const emptyLive: string[] = [];
const unresolved: string[] = [];
const changes: string[] = [];

for (const { id, entry } of walkEnvs(merged)) {
	if (!isSecret(entry) || (entry.value ?? "") !== "") continue;
	const key = entry.key as string;
	const live = liveEnvs.get(id);

	// ⚠️ An empty string counts as ABSENT, deliberately. A vault entry that exists but holds
	// "" would otherwise be a supplied value — re-inflicting the exact clobber this tool was
	// written to prevent, through the mechanism meant to fix it. Same family as the repo's
	// recurring `Number("") === 0`.
	const supplied = overrides.get(key) ?? vault.get(key);
	if (supplied !== undefined && supplied !== "") {
		entry.value = supplied;
		const liveLen = secretPlaintextLength(live ?? {});
		const newLen = Buffer.byteLength(supplied);
		(overrides.has(key) ? fromFlag : fromVault).push(id);
		// A length can prove a value CHANGED; it can never prove one didn't. Both readings
		// are printed as what they are, so nobody reads "same length" as "same value".
		if (liveLen === null) changes.push(`${id} — new, nothing live to compare`);
		else if (liveLen !== newLen)
			changes.push(`${id} — CHANGES live (${liveLen} → ${newLen} bytes)`);
		continue;
	}

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
show("Secret values taken from Bitwarden (--from-bws):", fromVault);
show(
	"⚠ Secrets whose value would CHANGE in production:",
	changes,
	"→ length is evidence, not identity: it proves a change, never the absence of one.",
);
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

/**
 * 🚨 The merged spec contains PLAINTEXT SECRETS, and where it lands is a security decision.
 *
 * Any value this run supplied — from `--from-bws` or `--set` — sits here unencrypted, because
 * that is how you hand App Platform a new secret value: you send the plaintext and it
 * encrypts on receipt. Only the values passed through untouched stay as `EV[…]` blobs.
 *
 * The first cut wrote it with `Bun.write` to `os.tmpdir()`, which produced
 * `-rw-rw-r-- /tmp/anthers-spec-apply-anthers.yaml` — **six production credentials readable
 * by every account on the machine**, sitting on disk indefinitely. The warning printed
 * alongside it said "not for git", which is the wrong hazard named confidently: nothing was
 * ever going to commit a file in /tmp, and the actual exposure was the mode and the location.
 *
 * So: `XDG_RUNTIME_DIR` when it exists (on this machine `/run/user/1000` — tmpfs, already
 * 0700, and cleared at logout, so the plaintext never reaches persistent storage at all),
 * falling back to the temp dir. The containing directory is created 0700 and the file 0600
 * **at creation** rather than chmod'd afterwards, which would leave a window where the
 * default mode applies.
 */
const runtimeDir = (process.env.XDG_RUNTIME_DIR ?? "").trim() || tmpdir();
const outDir = join(runtimeDir, "anthers-spec-apply");
const outPath = outFlag >= 0 ? (argv[outFlag + 1] as string) : join(outDir, `${appName}.yaml`);
if (outFlag < 0) mkdirSync(outDir, { recursive: true, mode: 0o700 });
// Remove first: `mode` in writeFileSync applies only when the file is created, so writing
// over an existing world-readable file would silently keep its permissions.
rmSync(outPath, { force: true });
writeFileSync(outPath, Bun.YAML.stringify(merged), { mode: 0o600 });

const plaintext = [...walkEnvs(merged)].filter(
	({ entry }) => isSecret(entry) && !(entry.value ?? "").startsWith("EV["),
).length;
console.log(`  Merged spec written to ${outPath} (0600)`);
if (plaintext) {
	console.log(`  🚨 It holds ${plaintext} secret value(s) in PLAINTEXT. Delete it when done:`);
	console.log(`       rm ${outPath}\n`);
} else {
	console.log("  All secret values in it are encrypted blobs, passed through untouched.\n");
}

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
