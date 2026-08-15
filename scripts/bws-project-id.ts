// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Print the Bitwarden Secrets Manager project id for a project NAME.
 *
 * Exists so nothing has to commit a project UUID. Same reasoning `ci.yml` gives for keeping
 * `DO_APP_ID` in a repository variable rather than the file: an identifier is useless
 * without a token, but it is still infrastructure identity and this repo is world-readable.
 *
 * The match is exact and case-insensitive, which is the whole safety property here —
 * "Anthers" and "Anthers Dev" hold production and development credentials respectively, and
 * a prefix match would eventually hand one to the other.
 *
 *     bun run scripts/bws-project-id.ts "Anthers Dev"
 */

const name = (Bun.argv[2] ?? "").trim();
if (!name) {
	console.error('bws-project-id: usage: bun run scripts/bws-project-id.ts "<project name>"');
	process.exit(2);
}

// Read the token from the environment or the file `bws` keeps its config beside, and hand it
// to the child through its ENVIRONMENT — never argv, which is world-readable in /proc.
let token = (process.env.BWS_ACCESS_TOKEN ?? "").trim();
if (!token) {
	token = (
		await Bun.file(`${process.env.HOME}/.config/bws/token`)
			.text()
			.catch(() => "")
	).trim();
}
if (!token) {
	console.error("bws-project-id: no BWS_ACCESS_TOKEN and no ~/.config/bws/token.");
	process.exit(2);
}

const proc = Bun.spawn(["bws", "project", "list", "-o", "json"], {
	stdout: "pipe",
	stderr: "pipe",
	env: { ...process.env, BWS_ACCESS_TOKEN: token },
});
const out = await new Response(proc.stdout).text();
if ((await proc.exited) !== 0) {
	console.error(`bws-project-id: ${(await new Response(proc.stderr).text()).trim()}`);
	process.exit(2);
}

const projects = JSON.parse(out) as { id: string; name: string }[];
const match = projects.filter((p) => p.name.toLowerCase() === name.toLowerCase());
if (match.length !== 1) {
	console.error(
		`bws-project-id: ${match.length} projects named "${name}". Visible:\n` +
			projects.map((p) => `    ${p.name}`).join("\n"),
	);
	process.exit(1);
}
console.log((match[0] as { id: string }).id);
