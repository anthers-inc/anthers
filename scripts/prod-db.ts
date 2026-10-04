// SPDX-License-Identifier: Apache-2.0
/**
 * Inject the production `DATABASE_URL` into a child command's environment without the
 * connection string ever appearing on a command line, in tool output, or in a session
 * transcript.
 *
 * The 2026-10-03 transcript audit found a production database password greppable in
 * OpenCode's session store, put there by a `psql` invocation that carried `PGPASSWORD`
 * inline. A credential that only crosses a process boundary — environment inheritance
 * into a child — leaves nothing for a transcript to record. That is the whole design
 * here: `doctl` writes the fetched connection details to a temp file held at 0600, this
 * script reads the file, spawns the command with the URI set, and unlinks the file. The
 * URI is never an argument, never echoed, and never printed by this script; a failure
 * names the step, not the value.
 *
 *   make prod-db CMD="bun run admin:account list"
 *   make prod-db CMD="bun run admin:account create me@example.com --name Me" ARGS="--output json"
 *
 * Extra args for the doctl fetch ride in `ARGS`, which is split shell-style; nothing in
 * ARGS is a secret, and the connection itself comes back through the temp file only.
 *
 * ⚠️ This is for OUT-OF-BAND work on the managed cluster (admin recovery, one-off
 * queries, `db:admin`-class scripts). The deployed app reaches the same cluster through
 * its own `${anthersdb.DATABASE_URL}` binding, which DigitalOcean re-resolves on rotation
 * — out-of-band callers break after a rotation and rerun this script, which fetches the
 * then-current credential. Deliberately not guarded by `assertDevCheckout`: running
 * against the deployed database is the purpose, per this script's sibling
 * `apps/api/src/scripts/admin-account.ts`.
 */
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const TAG = "[prod-db]";

const CLUSTER_NAME = "anthers-pg";
const { values } = parseArgs({
	options: {
		"cluster-name": { type: "string", default: CLUSTER_NAME },
		cmd: { type: "string" },
		args: { type: "string", default: "" },
	},
	// The first positional (the CMD itself) is parsed via --cmd from the Makefile.
	strict: false,
});

const command = values.cmd;
if (!command) {
	console.error(`${TAG} no command given — use: make prod-db CMD="bun run admin:account list"`);
	process.exit(64);
}

// Split ARGS the way a shell would (quotes honored) without ever running a shell on it.
function splitArgs(input: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	for (let match = re.exec(input); match !== null; match = re.exec(input)) {
		const quoted = match[1] ?? match[2];
		out.push(quoted ?? match[3]!);
	}
	return out;
}

const dir = mkdtempSync(join(tmpdir(), "prod-db-"));
const connFile = join(dir, "connection.json");
// 0600 from creation so the fetched credential is never world-readable even for an
// instant; the fd goes straight to doctl's stdout, and nothing buffers in this process.
const connFd = openSync(connFile, "w", 0o600);
closeSync(connFd);
// parseArgs with strict:false types values loosely; the default above is ours, so the
// coercion only ever sees our own string in practice.
const clusterName = String(values["cluster-name"]);
const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;

try {
	// `doctl databases connection` wants the cluster UUID, and the Runbook names the
	// cluster (`anthers-pg`), not its ID — resolve a non-UUID value once, by name.
	let clusterId = clusterName;
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clusterName)) {
		const list = spawnSync(
			"doctl",
			["databases", "list", "--format", "ID,Name", "--output", "json", "--no-header"],
			{ env: childEnv, encoding: "utf8" },
		);
		if (list.error) throw list.error;
		if (list.status !== 0 || !list.stdout) {
			console.error(
				`${TAG} doctl could not list clusters (exit ${list.status}) — check DOCTL_CONTEXT and authentication`,
			);
			process.exit(list.status ?? 1);
		}
		const clusters = JSON.parse(list.stdout) as Array<{ id: string; name: string }>;
		const found = clusters.find((c) => c.name === clusterName);
		if (!found) {
			console.error(
				`${TAG} no cluster named "${clusterName}" on this DO account — seen: ${clusters.map((c) => c.name).join(", ")}`,
			);
			process.exit(1);
		}
		clusterId = found.id;
	}

	const fetch = spawnSync(
		"doctl",
		[
			"databases",
			"connection",
			clusterId,
			"--format",
			"URI",
			"--output",
			"json",
			"--no-header",
			...splitArgs(String(values.args ?? "")),
		],
		{
			env: childEnv,
			// The URI must land in the file, never in this process's stdout — a tool
			// harness records stdout, and that recording is the leak class this exists for.
			stdio: ["ignore", openSync(connFile, "a", 0o600), "inherit"],
		},
	);
	if (fetch.error) throw fetch.error;
	if (fetch.status !== 0) {
		console.error(
			`${TAG} doctl could not fetch the connection details (exit ${fetch.status}) — check DOCTL_CONTEXT and authentication`,
		);
		process.exit(fetch.status ?? 1);
	}

	const parsed = JSON.parse(readFileSync(connFile, "utf8")) as { uri?: string };
	const uri = parsed.uri;
	if (typeof uri !== "string") {
		console.error(
			`${TAG} doctl returned no URI field — the cluster name may be wrong (got: ${clusterName})`,
		);
		process.exit(1);
	}

	const words = splitArgs(String(command));
	const result = spawnSync(words[0], words.slice(1), {
		env: { ...childEnv, DATABASE_URL: uri },
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exit(result.status ?? 1);
} catch (error) {
	console.error(`${TAG} ${(error as Error).message}`);
	process.exit(1);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
