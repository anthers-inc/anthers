// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared vocabulary for the two tools that read App Platform specs — `spec-diff.ts`
 * (which reports drift) and `spec-apply.ts` (which resolves it).
 *
 * It exists because of one predicate: **what counts as an empty secret.** Both tools
 * have to agree on that, and a copy in each is the shape of bug this whole module was
 * written in response to — a duplicated formula agrees with its original right up until
 * one of them moves.
 */

export type EnvEntry = { key?: string; value?: string; type?: string; scope?: string };
export type GitHubSource = { repo?: string; branch?: string; deploy_on_push?: boolean };
export type Component = {
	name?: string;
	envs?: EnvEntry[];
	github?: GitHubSource;
	instance_count?: number;
};
export type Domain = { domain?: string; type?: string };
export type Spec = {
	name?: string;
	domains?: Domain[];
	envs?: EnvEntry[];
	services?: Component[];
	workers?: Component[];
	jobs?: Component[];
	static_sites?: Component[];
	functions?: Component[];
	[key: string]: unknown;
};

export const COMPONENT_KINDS = [
	"services",
	"workers",
	"jobs",
	"static_sites",
	"functions",
] as const;

export const isSecret = (e: EnvEntry) => e.type === "SECRET" || (e.value ?? "").startsWith("EV[");

/**
 * 🚨 A live secret whose plaintext is the EMPTY STRING.
 *
 * This is the failure that cost 2026-08-15, and the reason it cost anything is that it is
 * invisible everywhere you would look for it. `doctl apps update --spec .do/app.yaml`
 * applies the committed file, where every `type: SECRET` carries **no value** — and App
 * Platform reads a valueless secret as *"set it to empty"*, not *"leave it alone"*. All
 * seven app-level secrets went empty in one command. `spec get` then reports each one as a
 * perfectly well-formed `EV[1:…]` blob, so the spec looks intact, `spec-diff` compared
 * secrets on presence alone and said the specs agreed, and the only visible symptom was the
 * api container crashing on the two secrets something happened to validate at boot.
 *
 * **The length gives it away, and no key is needed to read it.** The blob is
 * `EV[1:<nonce>:<ciphertext ‖ tag>]`; under AES-GCM the ciphertext is exactly as long as
 * the plaintext and the tag is a fixed 16 bytes. So a sealed box of 16 bytes had nothing
 * put in it. Measured against the real values recovered that day, every clobbered secret
 * rendered as 63 characters and the shortest genuine one as 75.
 *
 * Deliberately structural rather than a `length === 63` check: the 63 is a consequence of
 * today's 24-byte nonce, and decoding the tag is the fact itself.
 */
export function isEmptySecret(e: EnvEntry): boolean {
	return secretPlaintextLength(e) === 0;
}

/**
 * The BYTE LENGTH of a live secret's plaintext, without decrypting it. `null` when the
 * entry is not an `EV[…]` blob at all.
 *
 * The same arithmetic `isEmptySecret` rests on, generalized one step: AES-GCM ciphertext is
 * exactly as long as its plaintext, so subtracting the 16-byte tag from the sealed box
 * gives the original length. Zero is the clobber; other values are useful on their own.
 *
 * ⚠️ **A length is evidence, not identity.** Two different secrets of the same length look
 * identical here, so this can prove a value *changed* and can never prove one didn't. Used
 * for exactly that: warning before an apply overwrites a production secret with something
 * of a different size. It is also how the 2026-08-15 post-mortem established that the local
 * `.env` held the same values as production for six of seven secrets — six lengths matched
 * and `RESEND_API_KEY` did not, which is a real finding no amount of staring at ciphertext
 * would have produced.
 */
export function secretPlaintextLength(e: EnvEntry): number | null {
	const match = /^EV\[\d+:[^:]*:([^\]]*)\]$/.exec((e.value ?? "").trim());
	if (!match) return null;
	try {
		return Math.max(0, Buffer.from(match[1] as string, "base64").length - 16);
	} catch {
		return null;
	}
}

/** Flatten a spec to `component/KEY` → entry, so a key is compared where it lives. */
export function envMap(spec: Spec): Map<string, EnvEntry> {
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

export async function run(
	cmd: string[],
	env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
	// `env` is merged rather than replacing the inherited environment, and it is the way a
	// credential reaches a child process WITHOUT going through argv — anything passed as an
	// argument is visible in `/proc/<pid>/cmdline` to every process on the machine for as
	// long as the call runs.
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { ok: (await proc.exited) === 0, stdout, stderr };
}

/**
 * Which `doctl` account to talk to, via `DOCTL_CONTEXT`.
 *
 * Anthers has two DigitalOcean accounts and production lives on the Anthers-owned one, so
 * "the live spec" is not a single thing. Without this a tool silently reads whichever
 * account `doctl` happens to be pointed at.
 *
 *     DOCTL_CONTEXT=anthers make spec-diff
 */
export const CONTEXT = (process.env.DOCTL_CONTEXT ?? "").trim();
export const ctxArgs = CONTEXT ? ["--context", CONTEXT] : [];

/** Resolve an app id by the spec's own name, so callers never have to pass one. */
export async function resolveAppId(appName: string, idEnv: string): Promise<string> {
	const fromEnv = process.env[idEnv] ?? "";
	if (fromEnv) return fromEnv;
	const list = await run([
		"doctl",
		"apps",
		"list",
		"--format",
		"ID,Spec.Name",
		"--no-header",
		...ctxArgs,
	]);
	if (!list.ok) return "";
	return (
		list.stdout
			.split("\n")
			.map((l) => l.trim().split(/\s+/))
			.find(([, name]) => name === appName)?.[0] ?? ""
	);
}
