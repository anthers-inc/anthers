// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fill in the non-secret configuration that dev and production genuinely share, by reading
 * the committed App Platform spec — instead of asking every developer to keep a second copy
 * of it in `.env`.
 *
 * ── Why ────────────────────────────────────────────────────────────────────────────
 *
 * Most env vars need a value in both `.env` and `.do/app.yaml`, because they are the same
 * setting for two environments. Some genuinely differ (`DATABASE_URL` is localhost here and
 * a binding there; `STORAGE_BACKEND` is `local` here and `s3` there) and those must stay
 * per-environment. But a measured 14 of 18 non-secret keys were byte-identical in both
 * places, which is duplication with nothing checking it — a second copy that can only ever
 * drift. `.do/app.yaml` is committed, needs no network and no credentials, so for the subset
 * that is non-secret *and* environment-independent it can simply be the one source.
 *
 * ── The list is explicit, deliberately ─────────────────────────────────────────────
 *
 * Nothing in the spec marks a value as "safe to share with dev", so it has to be declared,
 * and `SHARED_FROM_SPEC` is that declaration. Deriving it instead — "anything non-secret
 * that `.env` doesn't override" — would be exactly the ambient-input mistake that made
 * `spec-apply --from-env` unusable: `STORAGE_BACKEND` would arrive as `s3` on a machine with
 * no `.env`, and the api would boot straight into a credential error. An eight-line list
 * that someone has to edit on purpose is the safety property, not a chore to design away.
 *
 * ── Three guards ───────────────────────────────────────────────────────────────────
 *
 *   1. **Never overrides.** Anything already in the environment — real vars, or what Bun
 *      loaded from `.env` — wins. This only fills blanks.
 *   2. **Skips `${…}` values.** `DATABASE_URL` and `FRONTEND_URL` are App Platform
 *      interpolations that mean nothing off DigitalOcean. Neither is on the list, but the
 *      check is structural so a future addition cannot import a literal `${APP_URL}`.
 *   3. **Cannot run in production**, and not by a flag that could be set wrong: the
 *      Dockerfile copies only `packages/` and `apps/api/`, so `.do/app.yaml` is not in the
 *      image. The file is absent and this no-ops. The guard is the deployment's shape.
 *
 * Imported for its side effect, at the top of the api entry points, before anything reads
 * `process.env`.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Non-secret, environment-independent config that dev takes from the committed spec.
 *
 * To add one: it must be non-secret (it is about to be read from a committed file) and the
 * same in every environment. If dev would ever want a different value, it belongs in `.env`.
 */
const SHARED_FROM_SPEC = [
	"PORT",
	"STRIPE_PUBLISHABLE_KEY",
	"DMCA_AGENT_REGISTERED",
	"DMCA_AGENT_NAME",
	"DMCA_AGENT_ADDRESS",
	"DMCA_AGENT_EMAIL",
	"DMCA_AGENT_PHONE",
] as const;

type EnvEntry = { key?: string; value?: string; type?: string };
type Component = { envs?: EnvEntry[] };
type Spec = {
	envs?: EnvEntry[];
	services?: Component[];
	workers?: Component[];
	jobs?: Component[];
	static_sites?: Component[];
};

/** Walk up from this file looking for the committed spec. Absent in the image, by design. */
function findSpec(): string | null {
	let dir = import.meta.dir;
	for (let depth = 0; depth < 8; depth++) {
		const candidate = join(dir, ".do", "app.yaml");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Fill `env` from the spec, returning the keys actually filled.
 *
 * Both parameters are injectable for the same reason `resolveStorageConfig` takes an
 * env-shaped object: every rule here is a decision about production configuration, and each
 * one should be testable against a fixture rather than against whatever this machine
 * happens to have in `.env` and `.do/app.yaml`.
 */
export function loadSharedSpecEnv(
	specPath: string | null = findSpec(),
	env: Record<string, string | undefined> = process.env,
): string[] {
	if (!specPath) return [];

	let spec: Spec;
	try {
		spec = Bun.YAML.parse(readFileSync(specPath, "utf8")) as Spec;
	} catch {
		// A malformed spec is a problem for `make spec-diff` to report, not a reason to stop
		// the dev server booting.
		return [];
	}

	const declared = new Map<string, EnvEntry>();
	for (const e of spec.envs ?? []) if (e.key) declared.set(e.key, e);
	for (const kind of ["services", "workers", "jobs", "static_sites"] as const) {
		for (const component of spec[kind] ?? []) {
			for (const e of component.envs ?? []) if (e.key) declared.set(e.key, e);
		}
	}

	const filled: string[] = [];
	for (const key of SHARED_FROM_SPEC) {
		// Treat empty as absent, the same way every other reader in this repo has learned to.
		if ((env[key] ?? "") !== "") continue;
		const entry = declared.get(key);
		const value = entry?.value ?? "";
		if (!value || entry?.type === "SECRET" || value.includes("${")) continue;
		env[key] = value;
		filled.push(key);
	}
	return filled;
}

const filled = loadSharedSpecEnv();
// Quiet under `bun test`, where this would print once per test file.
if (filled.length && process.env.NODE_ENV !== "test") {
	console.log(
		`[dev-env] ${filled.length} non-secret values from .do/app.yaml: ${filled.join(", ")}`,
	);
}
