// SPDX-License-Identifier: Apache-2.0
/**
 * Print the pids of every process *listening* on a portless-registered port.
 *
 * Used by `make down` to answer "what should I kill" when the pid-file half found nothing.
 * Portless registers each route with the *CLI launcher*'s pid (the node process that ran
 * `portless run`), not the dev server's — once that CLI exits, the route's recorded pid is
 * dead but the actual server is alive and still holding the port. The right question is not
 * "is the registered pid alive" but "who is listening on the port the route names", and the
 * place Linux answers that with is `/proc` directly: an inode for the LISTEN socket, then a
 * match against each live process's fd table.
 *
 * Not a substitute for the pid-file half of `make down`: that one kills the session's process
 * group, which is the right shape for a clean stop. This script covers the case the pid files
 * miss — a terminal killed mid-session, an editor crash, a `pkill -f bun` from somewhere else.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const routesFile = join(homedir(), ".portless", "routes.json");
let routes: Array<{ hostname?: string; port?: number; pid?: number }>;
try {
	routes = JSON.parse(readFileSync(routesFile, "utf8"));
} catch {
	// No portless state on this machine, or no routes registered.
	process.exit(0);
}

/** The listening-socket inodes serving these ports, from `/proc/net/tcp{,6}`. */
function listeningInodes(ports: Set<number>): Set<string> {
	const inodes = new Set<string>();
	for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let content: string;
		try {
			content = readFileSync(table, "utf8");
		} catch {
			continue;
		}
		for (const line of content.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10 || fields[3] !== "0A") continue; // 0A = LISTEN
			const localPort = Number.parseInt(fields[1].split(":").pop() ?? "", 16);
			if (ports.has(localPort)) inodes.add(fields[9]);
		}
	}
	return inodes;
}

/** Every pid holding one of the socket inodes. */
function pidsHoldingInodes(inodes: Set<string>, exclude: number): Set<number> {
	const found = new Set<number>();
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === exclude) continue;
		let fds: string[];
		try {
			fds = readdirSync(`/proc/${pid}/fd`);
		} catch {
			continue; // another user's, or exiting between readdir and readlink.
		}
		for (const fd of fds) {
			let target: string;
			try {
				target = readlinkSync(`/proc/${pid}/fd/${fd}`);
			} catch {
				continue;
			}
			const m = target.match(/^socket:\[(\d+)\]$/);
			if (m && inodes.has(m[1])) {
				found.add(pid);
				break;
			}
		}
	}
	return found;
}

const ports = new Set<number>();
for (const route of routes) {
	if (route.port && route.port > 0) ports.add(route.port);
}
if (ports.size === 0) process.exit(0);

const inodes = listeningInodes(ports);
if (inodes.size === 0) process.exit(0);

for (const pid of pidsHoldingInodes(inodes, process.pid)) {
	console.log(pid);
}
