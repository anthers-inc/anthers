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
 * The machine-account token, from the environment or the file `bws` keeps its config beside.
 *
 * Never returned to a caller that would put it on a command line — `run()` below is the only
 * intended consumer, and it passes it as an env overlay.
 */
export async function bwsToken(): Promise<string> {
	const fromEnv = (process.env.BWS_ACCESS_TOKEN ?? "").trim();
	if (fromEnv) return fromEnv;
	const file = `${process.env.HOME}/.config/bws/token`;
	const fromFile = (
		await Bun.file(file)
			.text()
			.catch(() => "")
	).trim();
	if (!fromFile) {
		throw new Error(`no BWS_ACCESS_TOKEN and nothing readable at ${file}`);
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
 * 🚨 The match is exact and case-insensitive. "Anthers" holds production credentials and
 * "Anthers Dev" holds development ones; a prefix or fuzzy match would eventually hand one to
 * a caller asking for the other.
 */
export async function bwsProjectId(name: string, token?: string): Promise<string> {
	const t = token ?? (await bwsToken());
	const projects = JSON.parse(await run(["bws", "project", "list", "-o", "json"], t)) as {
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

/** Every secret in a project, as `key → value`. */
export async function bwsSecrets(projectName: string): Promise<Map<string, string>> {
	const token = await bwsToken();
	const projectId = await bwsProjectId(projectName, token);
	const listed = JSON.parse(
		await run(["bws", "secret", "list", projectId, "-o", "json"], token),
	) as {
		key: string;
		value: string;
	}[];
	return new Map(listed.map((s) => [s.key, s.value]));
}
