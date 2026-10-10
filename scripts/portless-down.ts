// SPDX-License-Identifier: Apache-2.0
/**
 * Print the pids of every process *listening* on a portless-registered port **this checkout
 * owns**, for `make down` to answer "what should I kill" when the pid-file half found nothing.
 *
 * Scope is the point. Portless registers each route with the *CLI launcher*'s pid (the process
 * that ran `portless run`), not the dev server's — once that CLI exits, a still-alive server is
 * listening on the route's port under no route of its own. But the route table is machine-wide,
 * and every other project's and every other checkout's live sessions are in it too: the unscoped
 * version of this script once pointed `make down` at every listener on every registered port,
 * including other projects', and the per-checkout dev-session shape (scripts/session.ts) makes
 * it correctable rather than merely survivable.
 *
 * Ownership follows the same git facts everything else keys on: a checkout's routes are the
 * names `portless.json` defines, with the checkout's worktree branch (if any) as a first label.
 * The main checkout owns the unprefixed forms only; a worktree owns only the forms its own
 * branch prefixes. A pid-0 alias is a deliberate registration and is never owned by a checkout —
 * it takes `portless alias --remove` by hand, not a `make down`.
 *
 * Not a substitute for the pid-file half of `make down`: that one kills the session's process
 * group, which is the right shape for a clean stop. This script covers the case the pid files
 * miss — a terminal killed mid-session, an editor crash, a `pkill -f bun` from somewhere else.
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { devSessionId } from "./session.ts";

export interface Route {
	hostname?: string;
	port?: number;
	pid?: number;
}

/**
 * The route hostnames this checkout owns: `<name>` (the main checkout's unprefixed forms, one
 * per app in `portless.json`) and `<branch>.<name>` (the forms portless prefixes in a worktree).
 * Anything else — other projects, other checkouts' branch names, aliases — is not ours to kill.
 */
export function ownedHostnames(
	routes: Route[],
	appNames: string[],
	prefix: string,
	tld: string,
): Route[] {
	return routes.filter((route) => {
		const hostname = route.hostname ?? "";
		const bare = hostname.endsWith(`.${tld}`)
			? hostname.slice(0, -(tld.length + 1))
			: undefined;
		if (bare === undefined) return false;
		// The apex forms belong to whichever checkout holds the plain name — the main checkout's
		// shape (prefix ""), so a worktree owning them would be owning a registration it could
		// never have made.
		return appNames.some((n) => (prefix === "" ? bare === n : bare === `${prefix}.${n}`));
	});
}

/**
 * The app names a checkout is served under: `portless.json`'s app map when it has one, or the
 * root `package.json`'s `portless` string. Empty means this checkout publishes no names, so
 * nothing listening anywhere is ours to kill.
 */
export function portlessAppNames(root: string): string[] {
	try {
		const config = JSON.parse(readFileSync(join(root, "portless.json"), "utf8")) as {
			name?: string;
			apps?: Record<string, { name: string }>;
		};
		if (config.apps) return Object.values(config.apps).map((app) => app.name);
		return config.name ? [config.name] : [];
	} catch {
		try {
			const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
				portless?: string;
			};
			return pkg.portless ? [pkg.portless] : [];
		} catch {
			return [];
		}
	}
}

/** The single TLD route files here carry, from the first route's last label. */
export function tldOf(routes: Route[]): string {
	const hostname = routes.find((r) => r.hostname)?.hostname ?? "";
	return hostname.split(".").pop() ?? "";
}

export function readRoutes(): Route[] {
	try {
		return JSON.parse(readFileSync(join(homedir(), ".portless", "routes.json"), "utf8")) as Route[];
	} catch {
		// No portless state on this machine, or no routes registered.
		return [];
	}
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

async function main(): Promise<void> {
	const routes = readRoutes();
	if (routes.length === 0) process.exit(0);
	const root = process.cwd();
	if (portlessAppNames(root).length === 0) process.exit(0);
	const dev = await devSessionId(root);
	const owned = ownedHostnames(routes, portlessAppNames(root), dev.prefix, tldOf(routes));
	const ports = new Set(owned.map((r) => r.port).filter((p): p is number => !!p && p > 0));
	if (ports.size === 0) process.exit(0);
	const inodes = listeningInodes(ports);
	if (inodes.size === 0) process.exit(0);
	for (const pid of pidsHoldingInodes(inodes, process.pid)) console.log(pid);
	process.exit(0);
}

if (import.meta.main) {
	void main();
}