// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reading secrets out of Bitwarden Secrets Manager, in one place.
 *
 * `spec-apply.ts` had this inline and `webhook-check.ts` needed the same thing. Two copies
 * of "find the token, resolve the project, list the secrets" is the shape of every drift
 * this repo has spent the day fixing, and one of the three steps is a security decision
 * (the token reaches the child through its ENVIRONMENT, never argv, where `/proc` publishes
 * it for the duration of the call).
 */

/**
 * Which set of credentials a caller wants. There is no default, deliberately.
 *
 * 🚨 **One machine account used to see both projects, which made the separation
 * organizational rather than real** — the token `make dev` read on a laptop could read
 * production's secrets, so a compromised development environment was still a production
 * exposure. Two accounts now hold one project each (2026-08-30), and a caller has to say
 * which it is. **A default here would recreate the problem**, because the safe value depends
 * entirely on the caller and whichever one it picked would be silently wrong for the other.
 */
export type BwsRole = "prod" | "dev";

/**
 * The Bitwarden project each role reads, and the only place either name is written.
 *
 * ⚠️ **These are matched EXACTLY** (case-insensitively) by {@link bwsProjectId}, so renaming
 * a project in the web vault breaks every caller until this map is updated — which is what
 * happened when `Anthers` became `Anthers Prod`. That strictness is deliberate and worth the
 * cost: a prefix match would eventually hand `Anthers Dev` to something asking for
 * production, and the whole point of the split is that the two can never be confused.
 */
export const BWS_PROJECTS: Record<BwsRole, string> = {
	prod: "Anthers Prod",
	dev: "Anthers Dev",
};

/** Where each role's access token lives. `0600`, in a `0700` directory. */
export const BWS_TOKEN_FILES: Record<BwsRole, string> = {
	prod: `${process.env.HOME}/.config/bws/anthers-prod-token`,
	dev: `${process.env.HOME}/.config/bws/anthers-dev-token`,
};

/**
 * The machine-account token for one role, from its own file.
 *
 * Never returned to a caller that would put it on a command line — `run()` below is the only
 * intended consumer, and it passes it as an env overlay, because argv is world-readable
 * through `/proc/<pid>/cmdline` for the duration of the call.
 *
 * ⚠️ **`BWS_ACCESS_TOKEN` still wins when set, and that is a hazard as much as a
 * convenience.** It carries whatever scope the exporting shell had, so an environment
 * exported for a development task and left set will be used for a production read without
 * anything saying so. It is honored because `bws run` sets it for the child process and
 * removing the override would break `make dev` from inside that subshell.
 */
export async function bwsToken(role: BwsRole): Promise<string> {
	const fromEnv = (process.env.BWS_ACCESS_TOKEN ?? "").trim();
	if (fromEnv) return fromEnv;
	const file = BWS_TOKEN_FILES[role];
	const fromFile = (
		await Bun.file(file)
			.text()
			.catch(() => "")
	).trim();
	if (!fromFile) {
		throw new Error(
			`no BWS_ACCESS_TOKEN and nothing readable at ${file} — ` +
				`the ${role} machine account's token belongs there`,
		);
	}
	return fromFile;
}

async function run(cmd: string[], token: string): Promise<string> {
	const proc = Bun.spawn(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, BWS_ACCESS_TOKEN: token },
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if ((await proc.exited) !== 0) throw new Error(stderr.trim() || "bws failed");
	return stdout;
}

/**
 * Resolve a project id from its NAME, so no UUID is committed — the reasoning `ci.yml` gives
 * for keeping `DO_APP_ID` in a repository variable.
 *
 * 🚨 The match is exact and case-insensitive. `Anthers Prod` holds production credentials and
 * `Anthers Dev` holds development ones; a prefix or fuzzy match would eventually hand one to
 * a caller asking for the other — and since the rename of 2026-08-30 one name is now a strict
 * prefix of nothing but is one word away from the other, so this matters more than it did.
 *
 * ⭐ **Since the machine accounts were split, the failure this throws is also the proof the
 * split worked.** A dev token asking for `Anthers Prod` sees a project list that does not
 * contain it and gets `0 projects named "Anthers Prod". Visible: Anthers Dev` — which reads
 * as exactly what it is. ⚠️ Bitwarden returns **404 rather than 403** for a project a token
 * cannot see, so "no access" and "no such thing" are the same answer from the API and this
 * message is the only place the difference is legible.
 */
export async function bwsProjectId(name: string, token: string): Promise<string> {
	const projects = JSON.parse(await run(["bws", "project", "list", "-o", "json"], token)) as {
		id: string;
		name: string;
	}[];
	const match = projects.filter((p) => p.name.toLowerCase() === name.toLowerCase());
	if (match.length !== 1) {
		throw new Error(
			`${match.length} projects named "${name}". Visible: ${projects.map((p) => p.name).join(", ")}`,
		);
	}
	return (match[0] as { id: string }).id;
}

/**
 * Every secret in one role's project, as `key → value`.
 *
 * ⭐ **The role picks both the token and the project, together**, which is what makes it
 * impossible to read production's secrets with the development token by passing the wrong
 * string. The two used to be independent arguments and nothing connected them.
 */
export async function bwsSecrets(role: BwsRole): Promise<Map<string, string>> {
	const token = await bwsToken(role);
	const projectId = await bwsProjectId(BWS_PROJECTS[role], token);
	const listed = JSON.parse(
		await run(["bws", "secret", "list", projectId, "-o", "json"], token),
	) as {
		key: string;
		value: string;
	}[];
	return new Map(listed.map((s) => [s.key, s.value]));
}
