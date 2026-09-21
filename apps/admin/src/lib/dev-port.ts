// SPDX-License-Identifier: Apache-2.0
/**
 * Fail loudly when a dev server's port is already held, naming the process.
 *
 * A Bun `serve()` on a taken port throws only when the socket itself is
 * rejected — several paths (a containerized peer, a listener racing in ahead
 * of us) instead leave the process running and serving nothing useful, which
 * is how a dev window comes up showing a bare two-word body instead of the
 * app. `make dev` claims its ports deliberately, so a busy one is a stale
 * instance or somebody else's project, and the remedy is stopping it by name
 * rather than drifting to another port nobody is looking at.
 *
 * Each app keeps its own copy of this helper (`apps/{web,admin,api}/src/lib/`)
 * rather than a shared package import, because `web-shared` is a browser-only
 * package and the API does not depend on it; three short copies are cheaper
 * than cross-wiring for one function.
 */

/** Best-effort identity of the process holding `port`, for error messages. */
function portHolder(port: number): string {
	const proc = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
	const pid = proc.stdout.toString().split("\n").find((l) => l.startsWith("p"))?.slice(1);
	if (!pid) return "unknown process";
	const cmd = Bun.spawnSync(["ps", "-o", "comm=", "-p", pid]);
	const name = cmd.exitCode === 0 ? cmd.stdout.toString().trim() : "unknown";
	const link = Bun.spawnSync(["readlink", `/proc/${pid}/cwd`]);
	const cwd = link.exitCode === 0 ? `, cwd ${link.stdout.toString().trim()}` : "";
	return `${name} (pid ${pid}${cwd})`;
}

/** True when something on this machine is already listening on `port`. */
function portBusy(port: number): boolean {
	try {
		const probe = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
		probe.stop(true);
		return false;
	} catch {
		return true;
	}
}

/**
 * Exit non-zero naming the holder when `port` is already bound. Call with the
 * resolved port before `serve()`, so a failure reads as a startup error in the
 * terminal that asked for it rather than as a mis-rendered page.
 */
export function assertPortFree(port: number): void {
	if (!portBusy(port)) return;
	console.error(
		`[dev-server] port ${port} is already held by ${portHolder(port)}\n` +
			`  A dev session claims its ports deliberately — a busy one is a stale ` +
			`instance or another project's server, and neither should be served. ` +
			`Stop that process (or \`make down\` if it is ours) rather than serving beside it.`,
	);
	process.exit(1);
}
