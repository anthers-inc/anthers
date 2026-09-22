// SPDX-License-Identifier: Apache-2.0
/**
 * Classify — and on request kill — the *listener* holding one of the dev ports.
 *
 *   bun run scripts/port-guard.ts check 8000      # exit 0 free, 1 ours, 2 foreign; prints a line
 *   bun run scripts/port-guard.ts kill  3000      # kill only when it is ours; exit 1 on foreign
 *
 * The loop this replaced read `lsof -ti :$PORT` and killed whatever it found — which matches
 * any TCP state, not only listeners, so a webview's *outbound* connection from an ephemeral
 * local port reads as holding the port, and another project's live dev server reads as an
 * orphan of ours. On 2026-09-21 that loop killed Polysemy's server on :3001 out from under
 * its Tauri window, and presented it as freeing an orphaned port.
 *
 * "Ours" means the listener's cwd sits under this repository's main root, which includes every
 * worktree of it because ours nest at `.worktrees/<name>/`. Anything else — including a
 * listener whose cwd cannot be read — is foreign, and `kill` refuses: a guard that sometimes
 * kills the wrong process is a hazard rather than a convenience, and the refusal message names
 * the process so stopping it by hand costs nothing.
 *
 * The Makefile is the only caller. The per-app `dev-port.ts` preflight (#295) covers a server
 * *starting* on a held port; this script covers the Makefile targets that *take* one.
 */

import { readlinkSync } from "node:fs";
import { resolve } from "node:path";

export type Holder = { pid: string; comm: string; cwd: string | null };

/**
 * The pid of the process *listening* on `port`, or null. Asking lsof specifically for a
 * listening socket is the distinction that matters: `-i :PORT` without `-sTCP:LISTEN` also
 * matches outbound connections *to* the port, whose local end is an ephemeral port that lsof
 * can match the other way — one webview browsing a live dev server then reads as holding it.
 */
export function listenerPid(port: number): string | null {
	const proc = Bun.spawnSync({
		cmd: ["lsof", "-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"],
		stdout: "pipe",
		stderr: "ignore",
	});
	if (proc.exitCode !== 0) return null;
	const pid = proc.stdout.toString().trim().split("\n")[0]?.trim();
	return pid && /^\d+$/.test(pid) ? pid : null;
}

/** The holder's process name, and its cwd when this OS exposes one (`/proc` does). */
export function holderInfo(pid: string): Holder {
	const cmd = Bun.spawnSync({
		cmd: ["ps", "-o", "comm=", "-p", pid],
		stdout: "pipe",
		stderr: "ignore",
	});
	const comm = cmd.exitCode === 0 ? cmd.stdout.toString().trim() : "unknown";
	let cwd: string | null = null;
	try {
		cwd = readlinkSync(`/proc/${pid}/cwd`);
	} catch {
		// No /proc, or the process is not ours to inspect — either way the holder
		// stays foreign, which is the direction the refusal must fail in.
	}
	return { pid, comm, cwd };
}

/**
 * This repository's main root, resolved from inside any worktree of it. The script's own
 * location is the wrong anchor: under a worktree it sits in the worktree's copy, so the root
 * must come from git. `--git-common-dir` alone is not that answer from inside a worktree that
 * *nests* in its main checkout (`.worktrees/*`): git resolves the relative common-dir against
 * the worktree's *own* `.git` file, answering the worktree's root, and a guard then refuses
 * the main checkout's servers as foreign — which the pre-push verify worktree's run of this
 * script's own suite caught. A nested worktree advertises its containing checkout through
 * `commondir`, so follow that file back to the main root.
 */
export function mainRoot(from: string): string {
	const result = Bun.spawnSync({
		cmd: ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
		cwd: from,
		stdout: "pipe",
		stderr: "pipe",
		env: Object.fromEntries(
			Object.entries(process.env).filter(
				(e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("GIT_"),
			),
		),
	});
	if (result.exitCode !== 0) {
		throw new Error(
			`not inside a git repository reachable from ${from}: ${result.stderr.toString().trim()}`,
		);
	}
	const commonDir = result.stdout.toString().trim();
	if (!commonDir.endsWith("/.git")) {
		// A nested worktree: `commonDir` is its own `.git/worktrees/<name>` directory, whose
		// `commondir` file holds the path back to the main `.git` — the answer from inside a
		// worktree of a repository that keeps its worktrees at `.worktrees/`.
		const commondirFile = Bun.spawnSync({
			cmd: ["cat", `${commonDir}/commondir`],
			stdout: "pipe",
			stderr: "ignore",
		});
		if (commondirFile.exitCode === 0) {
			const mainGitDir = resolve(commonDir, commondirFile.stdout.toString().trim());
			if (mainGitDir.endsWith("/.git")) return mainGitDir.slice(0, -"/.git".length);
		}
		return commonDir;
	}
	return commonDir.slice(0, -"/.git".length);
}

/** True when the holder's cwd is inside this repository — the main checkout or a worktree. */
export function isOurs(holder: Holder, root: string): boolean {
	if (!holder.cwd) return false;
	return holder.cwd === root || holder.cwd.startsWith(`${root}/`);
}

function describe(holder: Holder): string {
	return `${holder.comm} (pid ${holder.pid}${holder.cwd ? `, cwd ${holder.cwd}` : ""})`;
}

function killHolder(pid: string): void {
	const result = Bun.spawnSync({ cmd: ["kill", pid], stderr: "pipe" });
	if (result.exitCode !== 0) {
		console.error(`  -> Tried to stop pid ${pid} and failed: ${result.stderr.toString().trim()}`);
		process.exit(1);
	}
}

export function main(argv: string[]): void {
	const [command, portArg] = argv;
	const port = Number(portArg);
	if ((command !== "check" && command !== "kill") || !Number.isInteger(port) || port <= 0) {
		console.error("usage: bun run scripts/port-guard.ts <check|kill> <port>");
		process.exit(64);
	}
	const pid = listenerPid(port);
	if (!pid) {
		console.log(`  -> Port ${port} is free.`);
		if (command === "check") process.exit(0);
		process.exit(0);
	}
	const holder = holderInfo(pid);
	const root = mainRoot(import.meta.dir);
	if (isOurs(holder, root)) {
		if (command === "kill") {
			console.log(`  -> Port ${port} held by our own ${describe(holder)} — killing to free it.`);
			killHolder(holder.pid);
			process.exit(0);
		}
		console.log(`  -> Port ${port} is held by our own ${describe(holder)}.`);
		process.exit(1);
	}
	console.error(
		`  -> Refusing to kill ${describe(holder)} on port ${port} — its cwd is not this\n` +
			`     repository, so it reads as another project's live server rather than an orphan\n` +
			`     of ours. Stop that process on its side, then re-run.`,
	);
	process.exit(2);
}

if (import.meta.main) main(process.argv.slice(2));
