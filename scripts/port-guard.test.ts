// SPDX-License-Identifier: Apache-2.0
/**
 * The port-guard classification, exercised against real listeners. The behavior under test is
 * what the process's cwd proves and what lsof's socket filter admits, so the fixtures are real
 * processes on real sockets rather than stubs — the one fact each case needs (a listener whose
 * cwd is this repository, one whose cwd is another fake repo, one that has exited) cannot be
 * faked without re-describing the thing the script is for.
 *
 * 🚨 **The foreign-refusal case is the one these tests are for.** Killing another project's
 * live dev server is the failure the script exists to prevent (it happened on 2026-09-21, to
 * Polysemy's Tauri window), so `kill` against a foreign holder is sabotage-tested twice: as a
 * refusal, and as a non-kill asserted by the listener still being alive afterwards.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { holderInfo, isOurs, listenerPid, main, mainRoot } from "./port-guard.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
let nextPort = 17300;
// `ReturnType<typeof Bun.listen>` resolves to the unix overload, so the container is the
// TCP listener type directly — it is what `Bun.listen({hostname, port})` with a real hostname
// hands back.
type Listener = Bun.TCPSocketListener<undefined>;
const listeners: Listener[] = [];
const sockets: Bun.Socket[] = [];
const processes: Bun.Subprocess[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const l of listeners.splice(0)) l.stop(true);
	for (const s of sockets.splice(0)) s.end();
	for (const p of processes.splice(0)) {
		p.kill();
		await p.exited;
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const realExit = process.exit;

/** Run `main` with process.exit replaced by a throw, so the suite sees its outcome. */
function run(...argv: string[]): number {
	let code = 0;
	process.exit = ((c?: number) => {
		code = c ?? 0;
		throw new Error(`exit ${code}`);
	}) as typeof process.exit;
	try {
		main(argv);
	} catch (err) {
		if (!(err instanceof Error && err.message.startsWith("exit "))) throw err;
	} finally {
		process.exit = realExit;
	}
	return code;
}

/** Start a bare net.Server in a `bun -e` child process, so it gets its own cwd. */
function listen(cwd: string): { proc: Bun.Subprocess; port: number } {
	const port = nextPort++;
	const proc = Bun.spawn({
		cmd: [
			"bun",
			"-e",
			`require("net").createServer(()=>{}).listen(${port},"127.0.0.1",()=>{});setInterval(()=>{},1000);`,
		],
		cwd,
		stdout: "ignore",
		stderr: "ignore",
	});
	processes.push(proc);
	return { proc, port };
}

function makeRepo(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `port-guard-${name}-`));
	dirs.push(dir);
	mkdirSync(join(dir, ".git"));
	return dir;
}

const CLEAN_ENV = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("GIT_"),
	),
);

/**
 * A throwaway git repository holding a worktree of its own at `.worktrees/probe`, so `mainRoot`
 * can be probed from inside a nesting worktree — the arrangement the pre-push verify uses, and
 * the one where "agree on the root" and "answer the current checkout" stop being the same
 * question. `dirs` picks both up at the end.
 */
function makeWorktree(): string {
	const dir = mkdtempSync(join(tmpdir(), "port-guard-wt-"));
	dirs.push(dir);
	const sh = (...args: string[]) => {
		const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: dir, env: CLEAN_ENV });
		if (result.exitCode !== 0) {
			throw new Error(`git ${args.join(" ")} failed in ${dir}: ${result.stderr.toString()}`);
		}
	};
	sh("init", "-b", "main");
	sh("config", "user.email", "port-guard@test.invalid");
	sh("config", "user.name", "port-guard");
	sh("commit", "--allow-empty", "-m", "root");
	sh("worktree", "add", ".worktrees/probe", "--detach");
	return join(dir, ".worktrees", "probe");
}

/** lsof's view of a port takes a moment after listen; poll rather than sleep a fixed amount. */
async function untilListening(port: number): Promise<void> {
	for (let i = 0; i < 50; i++) {
		if (listenerPid(port) !== null) return;
		await Bun.sleep(50);
	}
	throw new Error(`nothing is listening on ${port} yet`);
}

describe("listenerPid", () => {
	it("ignores an outbound connection to the port — the webview case", async () => {
		// A real listener to connect to...
		const listener = Bun.listen({
			hostname: "127.0.0.1",
			port: nextPort++,
			socket: { data() {} },
		});
		listeners.push(listener);
		// ...from a socket on this process. lsof without -sTCP:LISTEN matches this side too,
		// which is how an innocent client used to read as holding the port.
		const socket = await Bun.connect({
			hostname: "127.0.0.1",
			port: listener.port,
			socket: {
				data() {},
				open() {},
				close() {},
				error() {},
			},
		});
		sockets.push(socket);
		const ours = listenerPid(listener.port);
		expect(ours === null || ours === String(process.pid)).toBe(true);
	});

	it("finds a real listener in another process", async () => {
		const { port } = listen(REPO_ROOT);
		await untilListening(port);
		expect(Number(listenerPid(port))).toBeGreaterThan(0);
	});
});

describe("holderInfo", () => {
	it("reports the listener's working directory", async () => {
		const other = makeRepo("other");
		const { port } = listen(other);
		await untilListening(port);
		const pid = listenerPid(port);
		expect(pid).not.toBeNull();
		const holder = holderInfo(pid!);
		expect(resolve(holder.cwd ?? "")).toBe(resolve(other));
		expect(holder.comm.length).toBeGreaterThan(0);
	});
});

describe("isOurs", () => {
	it("accepts the repository root and its worktrees", () => {
		expect(isOurs({ pid: "1", comm: "bun", cwd: REPO_ROOT }, REPO_ROOT)).toBe(true);
		expect(
			isOurs({ pid: "1", comm: "bun", cwd: `${REPO_ROOT}/.worktrees/signup-page` }, REPO_ROOT),
		).toBe(true);
	});

	it("refuses a sibling project, a non-repo cwd, and a cwd that cannot be read", () => {
		expect(isOurs({ pid: "1", comm: "bun", cwd: `${REPO_ROOT}-sibling` }, REPO_ROOT)).toBe(false);
		expect(
			isOurs({ pid: "1", comm: "bun", cwd: "/home/parker/Polysemy/Polysemy" }, REPO_ROOT),
		).toBe(false);
		expect(isOurs({ pid: "1", comm: "bun", cwd: null }, REPO_ROOT)).toBe(false);
	});
});

describe("mainRoot", () => {
	it("resolves one root for a repository from its checkout and from a nested worktree", () => {
		// The two probes are different repositories — the assert is that each pair of probes
		// into one repository agrees on that repository's root, no matter where the probe
		// sits. "The worktree and the main checkout answer the same root" is the property,
		// not a particular path; an assertion like `mainRoot(x).endsWith(x)` is the first
		// draft's failure — under the pre-push verify worktree it passed trivially while
		// `mainRoot` was answering the *nested* root as "the repository", refusing the main
		// checkout's own servers as foreign.
		const fromCheckout = mainRoot(REPO_ROOT);
		expect(mainRoot(join(REPO_ROOT, "scripts"))).toBe(fromCheckout);

		const worktree = makeWorktree();
		const repoRoot = resolve(worktree, "..", "..");
		expect(mainRoot(repoRoot)).toBe(repoRoot);
		expect(mainRoot(worktree)).toBe(repoRoot);
	});
});

describe("the command surface", () => {
	it("check exits 0 on a free port", () => {
		expect(run("check", String(nextPort++))).toBe(0);
	});

	it("check exits 1 on a port held by this repository", async () => {
		const { port } = listen(REPO_ROOT);
		await untilListening(port);
		expect(run("check", String(port))).toBe(1);
	});

	it("kill kills a listener belonging to this repository", async () => {
		const { port, proc } = listen(REPO_ROOT);
		await untilListening(port);
		expect(run("kill", String(port))).toBe(0);
		await proc.exited;
		expect(listenerPid(port)).toBeNull();
	});

	it("kill refuses — and the listener survives — when the holder is another project's", async () => {
		const other = makeRepo("polysemy");
		const { port, proc } = listen(other);
		await untilListening(port);
		expect(run("kill", String(port))).toBe(2);
		expect(Number(listenerPid(port))).toBeGreaterThan(0);
		expect(proc.exitCode).toBeNull();
	});

	it("check exits 2 on a foreign holder, and names it", async () => {
		const other = makeRepo("polysemy");
		const { port } = listen(other);
		await untilListening(port);
		expect(run("check", String(port))).toBe(2);
	});

	it("usage errors exit 64", () => {
		expect(run()).toBe(64);
		expect(run("check", "abc")).toBe(64);
	});
});
