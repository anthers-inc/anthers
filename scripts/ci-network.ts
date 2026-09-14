// SPDX-License-Identifier: Apache-2.0
/**
 * A CI job's AT Protocol network: `network.mjs` run under Node inside the job, for as long as one
 * command runs.
 *
 *   npm ci --prefix scripts/atproto-network
 *   bun run scripts/ci-network.ts -- bun test
 *
 * ⚠️ **CI cannot use the session's own container for this.** A job's database is a service
 * container, but the network has to be reached on `localhost` at the port it writes into every
 * identity it creates, and a job running inside a container reaches a service by its name instead.
 * Running the same script under Node inside the job keeps `localhost` true, which is also exactly
 * how the container runs it locally. The job's `ANTHERS_SESSION=ci` stays set, so the test preload
 * and the Playwright config use this network and the service database rather than starting their own.
 *
 * The version comes from `scripts/atproto-network/package-lock.json`, the same lockfile the
 * container installs from.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { answers, exitCodeOf, mintInviteCode, networkEnvironment, runCommand } from "./session.ts";

const PLC_PORT = 2582;
const PDS_PORT = 2583;
const BLUESKY_PORT = 2586;

async function main(): Promise<number> {
	// Bun drops a `--` that comes straight after the script, so the separator may or may not arrive.
	const separator = process.argv.indexOf("--");
	const command = process.argv.slice(separator === -1 ? 2 : separator + 1);
	if (command.length === 0) throw new Error("usage: bun run scripts/ci-network.ts -- <command...>");

	const network = spawn("node", [join(import.meta.dir, "atproto-network", "network.mjs")], {
		env: {
			...process.env,
			PLC_PORT: String(PLC_PORT),
			PDS_PORT: String(PDS_PORT),
			BLUESKY_PORT: String(BLUESKY_PORT),
			LEXICONS_DIR: join(import.meta.dir, "..", "lexicons-published"),
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	let exited = false;
	network.on("exit", () => {
		exited = true;
	});

	const deadline = Date.now() + 90_000;
	for (;;) {
		if (exited) throw new Error("the AT Protocol network exited before it was ready");
		if (
			(await answers(`http://localhost:${PDS_PORT}/xrpc/_health`)) &&
			(await answers(`http://localhost:${BLUESKY_PORT}/xrpc/_health`)) &&
			(await answers(`http://localhost:${PLC_PORT}/_health`))
		) {
			break;
		}
		if (Date.now() > deadline)
			throw new Error("the AT Protocol network was not ready after 90 seconds");
		await Bun.sleep(250);
	}

	const env = networkEnvironment(
		{ plc: PLC_PORT, pds: PDS_PORT, bluesky: BLUESKY_PORT },
		{ inviteCode: await mintInviteCode(PDS_PORT), accountKey: randomBytes(32).toString("hex") },
	);
	console.log(`[ci-network] ready: directory :${PLC_PORT}, server :${PDS_PORT}`);

	const code = await exitCodeOf(runCommand(command, env, false), command);
	network.kill("SIGTERM");
	return code;
}

main().then(
	(code) => process.exit(code),
	(err) => {
		console.error(`[ci-network] ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	},
);
