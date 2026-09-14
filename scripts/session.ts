// SPDX-License-Identifier: Apache-2.0
/**
 * A disposable session: a Postgres, a private AT Protocol network and an upload directory that
 * belong to one run, created when it starts and removed when it ends.
 *
 *   bun run scripts/session.ts dev -- bun run dev               # what `make dev` runs
 *   bun run scripts/session.ts browser -- bunx playwright test  # what `make test-e2e` runs
 *   bun run scripts/session.ts attach dev -- bun run db:gauntlet  # into the running dev session
 *   bun test                                                   # starts its own; see session-preload.ts
 *
 * 🚨 **Nothing a session writes outlives it, and that is the design rather than a cleanup step.**
 * Data that lingered between runs kept snowballing into confusion, and a database shared by a
 * running dev server and a test run let each one break the other — a test run during a push once
 * produced 135 failures that meant nothing. So the database lives in memory inside its container,
 * the network holds everything in memory by construction, and both containers are removed when
 * the run ends.
 *
 * ⚠️ **Removal at the end is not enough on its own**, because a crash, a closed terminal or a
 * killed agent skips it. Every container and directory carries the process id of the run that
 * owns it, and every session starts by removing whatever belongs to a process that no longer
 * exists. A leftover whose owner is still alive is somebody else's live run and is never touched.
 *
 * ⭐ **`dev` keeps fixed ports and the other kinds do not.** The dev database stays on 5432 so the
 * `DATABASE_URL` in `.env` reaches it from Drizzle Studio or a hand-run migration while `make dev`
 * is up, and the network keeps the AT Protocol tooling's 2582 and 2583. Test and browser runs take
 * free ports, so any number of them can run beside each other and beside `make dev`. Two dev
 * sessions at once are refused rather than supported.
 *
 * Stripe's test-mode objects are the one thing a session creates that it cannot remove; they
 * accumulate in Stripe's own account.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DEV_SESSION_CONTENT_DIR } from "../packages/db/src/content-root.ts";

export type SessionKind = "dev" | "test" | "browser";

const KINDS: readonly SessionKind[] = ["dev", "test", "browser"];

const REPO_ROOT = join(import.meta.dir, "..");

/**
 * Where every session's directory lives, one subdirectory per session. Derived from the dev
 * session's upload directory, so a fixture script outside any session writes where `make dev`
 * serves from (`packages/db/src/content-root.ts`).
 */
export const SESSIONS_DIR = dirname(dirname(DEV_SESSION_CONTENT_DIR));

const NETWORK_IMAGE = "anthers-atproto-network";
/** Pinned, so the inbox a session opens does not change underneath it between runs. */
const MAIL_IMAGE = "axllent/mailpit:v1.27";
const POSTGRES_IMAGE = "postgres:16";

/** Labels on every container a session starts, so a later session can find the abandoned ones. */
export const SESSION_LABEL = "org.anthers.session";
export const OWNER_LABEL = "org.anthers.session.owner";

export interface SessionPorts {
	postgres: number;
	plc: number;
	pds: number;
	/** The API and the static preview server, which only a browser run starts. */
	api?: number;
	preview?: number;
	/**
	 * The mail catcher's API and inbox, which only sessions that run the API start: a test run
	 * never sends, because `sendEmail` refuses under the test runner.
	 */
	mail?: number;
}

export interface Session {
	id: string;
	kind: SessionKind;
	ports: SessionPorts;
	/** Everything a process inside the session needs, to be laid over its environment. */
	env: Record<string, string>;
	stop(): Promise<void>;
	/** For signal and exit handlers, which cannot wait on a promise. */
	stopSync(): void;
}

/** The ports a session uses. `dev` is fixed; every other kind asks `freePort` for each one. */
export function sessionPorts(kind: SessionKind, freePort: () => number): SessionPorts {
	if (kind === "dev") return { postgres: 5432, plc: 2582, pds: 2583, mail: 8025 };
	const taken = new Set<number>();
	const next = () => {
		for (;;) {
			const port = freePort();
			if (!taken.has(port)) {
				taken.add(port);
				return port;
			}
		}
	};
	const ports: SessionPorts = { postgres: next(), plc: next(), pds: next() };
	if (kind === "browser") {
		ports.api = next();
		ports.preview = next();
		ports.mail = next();
	}
	return ports;
}

/**
 * The environment a session hands to what runs inside it.
 *
 * The hosting credentials are real ones for the session's own server, so signup runs against it
 * exactly as it runs against production's: the invite code is minted on that server when the
 * session starts, and the sealing key is drawn fresh because nothing it seals survives the session.
 */
export function sessionEnvironment(
	id: string,
	ports: SessionPorts,
	contentDir: string,
	hosting: { inviteCode: string; accountKey: string },
): Record<string, string> {
	const env: Record<string, string> = {
		ANTHERS_SESSION: id,
		DATABASE_URL: `postgres://anthers:anthers@localhost:${ports.postgres}/anthers`,
		...networkEnvironment(ports, hosting),
		LOCAL_CONTENT_DIR: contentDir,
	};
	if (ports.mail !== undefined) env.MAIL_CATCHER_URL = `http://localhost:${ports.mail}`;
	if (ports.api !== undefined && ports.preview !== undefined) {
		env.API_PORT = String(ports.api);
		env.PREVIEW_PORT = String(ports.preview);
		env.BASE_URL = `http://localhost:${ports.api}`;
	}
	return env;
}

/** The part of a session's environment that points at its AT Protocol network. */
export function networkEnvironment(
	ports: Pick<SessionPorts, "plc" | "pds">,
	hosting: { inviteCode: string; accountKey: string },
): Record<string, string> {
	return {
		ATPROTO_PLC_URL: `http://localhost:${ports.plc}`,
		HOSTED_PDS_URL: `http://localhost:${ports.pds}`,
		HOSTED_PDS_INVITE_CODE: hosting.inviteCode,
		HOSTED_ACCOUNT_KEY: hosting.accountKey,
		ATPROTO_TEST_PDS: `http://localhost:${ports.pds}`,
	};
}

/**
 * Whether a process already inside `sessionId` should use it rather than start its own.
 *
 * CI provides its database as a service container, so `ci` is a session nobody starts. A `dev`
 * session is deliberately NOT reused by a test run: a test run inside a dev shell would otherwise
 * write its fixtures into the database somebody is working in, which is the sharing this module
 * exists to end.
 */
export function reusesSession(sessionId: string | undefined, kind: SessionKind): boolean {
	if (!sessionId) return false;
	return sessionId === "ci" || sessionId.startsWith(`${kind}-`);
}

export interface Leftover {
	name: string;
	session: string;
	owner: number;
}

/** Whether a process id is still running. EPERM means it exists and belongs to somebody else. */
export function processAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The leftovers whose owning run is gone, and so are safe to remove. */
export function abandoned(leftovers: Leftover[], alive: (pid: number) => boolean): Leftover[] {
	return leftovers.filter((leftover) => !alive(leftover.owner));
}

export type Invocation =
	| { mode: "start"; kind: SessionKind; command: string[]; pidFile?: string }
	| { mode: "attach"; id: string; command: string[] };

const USAGE =
	`usage: bun run scripts/session.ts <${KINDS.join("|")}> [--pid-file <path>] -- <command...>\n` +
	"       bun run scripts/session.ts attach <session> -- <command...>";

export function parseArguments(argv: string[]): Invocation {
	const separator = argv.indexOf("--");
	const options = separator === -1 ? argv : argv.slice(0, separator);
	const command = separator === -1 ? [] : argv.slice(separator + 1);
	if (command.length === 0) throw new Error(USAGE);
	if (options[0] === "attach") {
		if (!options[1]) throw new Error(USAGE);
		return { mode: "attach", id: options[1], command };
	}
	const kind = options[0] as SessionKind;
	if (!KINDS.includes(kind)) throw new Error(USAGE);
	const pidIndex = options.indexOf("--pid-file");
	const pidFile = pidIndex === -1 ? undefined : options[pidIndex + 1];
	return { mode: "start", kind, command, pidFile };
}

/**
 * The environment of a session that is running now, for a command run beside it.
 *
 * ⚠️ **Attaching exists because a session's hosting key is drawn fresh each time.** A worker or a
 * fixture script started from a second terminal can find the dev database from `.env`, but not the
 * key that seals the hosted accounts in it, nor the directory its uploads live in — so a session
 * records its environment, and a command attaches to that record rather than guessing.
 */
export function attachedEnvironment(id: string): Record<string, string> {
	const dir = join(SESSIONS_DIR, id);
	if (!processAlive(directoryOwner(id))) {
		throw new Error(
			`no ${id} session is running — start one first (\`make dev\` starts the dev session)`,
		);
	}
	return JSON.parse(readFileSync(join(dir, "env.json"), "utf8"));
}

// ─── Docker ──────────────────────────────────────────────────────────────────

async function docker(args: string[]): Promise<{ ok: boolean; out: string }> {
	const proc = Bun.spawn(["docker", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { ok: code === 0, out: code === 0 ? out.trim() : `${out}${err}`.trim() };
}

async function listLeftovers(): Promise<Leftover[]> {
	const { ok, out } = await docker([
		"ps",
		"-a",
		"--filter",
		`label=${SESSION_LABEL}`,
		"--format",
		`{{.Names}}\t{{.Label "${SESSION_LABEL}"}}\t{{.Label "${OWNER_LABEL}"}}`,
	]);
	if (!ok || out === "") return [];
	return out.split("\n").map((line) => {
		const [name, session, owner] = line.split("\t");
		return { name, session, owner: Number(owner) };
	});
}

/** The process id recorded as the owner of a session's directory, or 0 when there is none. */
function directoryOwner(id: string): number {
	try {
		return Number(readFileSync(join(SESSIONS_DIR, id, "owner"), "utf8"));
	} catch {
		return 0;
	}
}

/** Refuse to start a session whose id a live run already holds — in practice, a second `dev`. */
async function refuseIfRunning(id: string): Promise<void> {
	const owners = [directoryOwner(id)];
	for (const leftover of await listLeftovers()) {
		if (leftover.session === id) owners.push(leftover.owner);
	}
	const live = owners.find(processAlive);
	if (live !== undefined) {
		throw new Error(
			`a ${id} session is already running (pid ${live}). Stop it first — \`make down\` stops ` +
				"the dev session — or wait for that run to finish.",
		);
	}
}

/** Remove every container and directory whose owning run has ended. */
export async function clearAbandonedSessions(): Promise<void> {
	const gone = abandoned(await listLeftovers(), processAlive);
	if (gone.length > 0) await docker(["rm", "-f", ...gone.map((leftover) => leftover.name)]);

	if (!existsSync(SESSIONS_DIR)) return;
	for (const entry of readdirSync(SESSIONS_DIR)) {
		const dir = join(SESSIONS_DIR, entry);
		if (!existsSync(join(dir, "owner"))) {
			// A directory with no owner file yet may be a session starting this instant; only one
			// that has sat that way for a minute was abandoned mid-creation.
			const young = Date.now() - statSync(dir).mtimeMs < 60_000;
			if (young) continue;
		}
		if (!processAlive(directoryOwner(entry))) rmSync(dir, { recursive: true, force: true });
	}
}

function labels(id: string): string[] {
	return ["--label", `${SESSION_LABEL}=${id}`, "--label", `${OWNER_LABEL}=${process.pid}`];
}

async function waitFor(
	what: string,
	container: string,
	ready: () => Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (await ready()) return;
		const running = await docker(["ps", "-q", "--filter", `name=^${container}$`]);
		if (running.out === "") {
			const logs = await docker(["logs", "--tail", "20", container]);
			throw new Error(`${what} exited before it was ready:\n${logs.out}`);
		}
		await Bun.sleep(200);
	}
	throw new Error(`${what} was not ready after 90 seconds`);
}

async function startPostgres(id: string, port: number): Promise<string> {
	const name = `anthers-${id}-postgres`;
	const run = await docker([
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		...labels(id),
		"-e",
		"POSTGRES_USER=anthers",
		"-e",
		"POSTGRES_PASSWORD=anthers",
		"-e",
		"POSTGRES_DB=anthers",
		// In memory: nothing to wipe, and nothing to survive a container that was never stopped.
		"--tmpfs",
		"/var/lib/postgresql/data",
		"-p",
		`127.0.0.1:${port}:5432`,
		POSTGRES_IMAGE,
		// Durability buys nothing for a database that is discarded, and costs every test a flush.
		"-c",
		"fsync=off",
		"-c",
		"synchronous_commit=off",
		"-c",
		"full_page_writes=off",
	]);
	if (!run.ok) throw new Error(`could not start Postgres on port ${port}:\n${run.out}`);
	// Checked over TCP inside the container: during initialization the image runs a temporary
	// server on the socket only, and a socket check would pass before the real one is listening.
	await waitFor("Postgres", name, async () => {
		const check = await docker(["exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "anthers"]);
		return check.ok;
	});
	return name;
}

export async function answers(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return res.ok;
	} catch {
		return false;
	}
}

async function startNetwork(id: string, plc: number, pds: number): Promise<string> {
	const name = `anthers-${id}-atproto`;
	const build = await docker(["build", "-q", "-t", NETWORK_IMAGE, "scripts/atproto-network"]);
	if (!build.ok) throw new Error(`could not build the AT Protocol network image:\n${build.out}`);
	const run = await docker([
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		...labels(id),
		"-e",
		`PLC_PORT=${plc}`,
		"-e",
		`PDS_PORT=${pds}`,
		"-p",
		`127.0.0.1:${plc}:${plc}`,
		"-p",
		`127.0.0.1:${pds}:${pds}`,
		NETWORK_IMAGE,
	]);
	if (!run.ok) throw new Error(`could not start the AT Protocol network:\n${run.out}`);
	await waitFor(
		"The AT Protocol network",
		name,
		async () =>
			(await answers(`http://localhost:${pds}/xrpc/_health`)) &&
			(await answers(`http://localhost:${plc}/_health`)),
	);
	return name;
}

/**
 * The administrator password `@atproto/dev-env` gives every server it starts — its own published
 * constant, for a server that exists only in this session's memory and answers only on loopback.
 */
const NETWORK_ADMIN_PASSWORD = "admin-pass";

/**
 * Mint an invite code on the session's server, as production's is minted by hand on its node.
 *
 * ⚠️ **A made-up code is refused even though this server does not require one**: it checks any
 * code it is given. Minting a real one keeps signup on the same path it takes in production, where
 * the node does require one.
 */
export async function mintInviteCode(pds: number): Promise<string> {
	const res = await fetch(`http://localhost:${pds}/xrpc/com.atproto.server.createInviteCode`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Basic ${Buffer.from(`admin:${NETWORK_ADMIN_PASSWORD}`).toString("base64")}`,
		},
		body: JSON.stringify({ useCount: 1_000_000 }),
	});
	const body = (await res.json().catch(() => ({}))) as { code?: string };
	if (!res.ok || !body.code) {
		throw new Error(`the session's server would not mint an invite code (${res.status})`);
	}
	return body.code;
}

/**
 * The session's mail catcher: every email the API sends lands in an inbox the session reads.
 *
 * ⚠️ **Only its HTTP port is published.** The API hands it messages through its send API rather
 * than over SMTP, so nothing in a session speaks SMTP at all, and the same port serves the inbox a
 * developer opens in a browser.
 */
async function startMailCatcher(id: string, port: number): Promise<string> {
	const name = `anthers-${id}-mail`;
	const run = await docker([
		"run",
		"-d",
		"--rm",
		"--name",
		name,
		...labels(id),
		"-p",
		`127.0.0.1:${port}:8025`,
		MAIL_IMAGE,
	]);
	if (!run.ok) throw new Error(`could not start the mail catcher on port ${port}:\n${run.out}`);
	await waitFor("The mail catcher", name, () => answers(`http://localhost:${port}/livez`));
	return name;
}

async function migrate(env: Record<string, string>): Promise<void> {
	const proc = Bun.spawn(["bun", "run", "packages/db/src/migrate.ts"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`migrations failed:\n${out}${err}`);
}

function freePort(): number {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const { port } = server;
	server.stop(true);
	return port;
}

// ─── Starting and stopping ───────────────────────────────────────────────────

/** Start a session, removing whatever abandoned runs left behind first. */
export async function startSession(
	kind: SessionKind,
	log: (line: string) => void = () => {},
): Promise<Session> {
	if (!(await docker(["info"])).ok) {
		throw new Error("Docker isn't running. Start the Docker daemon, then retry.");
	}
	const id = kind === "dev" ? "dev" : `${kind}-${randomBytes(4).toString("hex")}`;
	await refuseIfRunning(id);
	await clearAbandonedSessions();

	const ports = sessionPorts(kind, freePort);
	const dir = join(SESSIONS_DIR, id);
	const contentDir = join(dir, "content");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "owner"), String(process.pid));
	mkdirSync(contentDir);

	const containers = [
		`anthers-${id}-postgres`,
		`anthers-${id}-atproto`,
		...(ports.mail !== undefined ? [`anthers-${id}-mail`] : []),
	];
	const stopSync = () => {
		Bun.spawnSync(["docker", "rm", "-f", ...containers], { stdout: "ignore", stderr: "ignore" });
		rmSync(dir, { recursive: true, force: true });
	};
	const stop = async () => {
		await docker(["rm", "-f", ...containers]);
		rmSync(dir, { recursive: true, force: true });
	};

	let env: Record<string, string>;
	try {
		const started = Date.now();
		await Promise.all([
			startPostgres(id, ports.postgres),
			startNetwork(id, ports.plc, ports.pds),
			ports.mail !== undefined ? startMailCatcher(id, ports.mail) : Promise.resolve(""),
		]);
		env = sessionEnvironment(id, ports, contentDir, {
			inviteCode: await mintInviteCode(ports.pds),
			accountKey: randomBytes(32).toString("hex"),
		});
		writeFileSync(join(dir, "env.json"), JSON.stringify(env), { mode: 0o600 });
		await migrate(env);
		log(
			`[session] ${id} ready in ${((Date.now() - started) / 1000).toFixed(1)}s — database :${ports.postgres}, ` +
				`directory :${ports.plc}, server :${ports.pds}` +
				(ports.mail !== undefined ? `, mail http://localhost:${ports.mail}` : ""),
		);
	} catch (err) {
		await stop();
		throw err;
	}
	return { id, kind, ports, env, stop, stopSync };
}

/** Run a command with `env` laid over this process's environment, until it exits. */
export function runCommand(
	command: string[],
	env: Record<string, string>,
	detached: boolean,
): ChildProcess {
	return spawn(command[0], command.slice(1), {
		cwd: process.cwd(),
		env: { ...process.env, ...env },
		stdio: "inherit",
		detached,
	});
}

export function exitCodeOf(child: ChildProcess, command: string[]): Promise<number> {
	return new Promise<number>((resolve) => {
		child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 130 : 1)));
		child.on("error", (err) => {
			console.error(`[session] could not run ${command[0]}: ${err.message}`);
			resolve(127);
		});
	});
}

async function main(): Promise<number> {
	const invocation = parseArguments(process.argv.slice(2));
	if (invocation.mode === "attach") {
		const env = attachedEnvironment(invocation.id);
		return exitCodeOf(runCommand(invocation.command, env, false), invocation.command);
	}
	const { kind, command, pidFile } = invocation;
	const session = await startSession(kind, console.log);
	if (pidFile) writeFileSync(pidFile, String(process.pid));

	// In its own process group, so stopping the session reaches everything the command started —
	// `bun run dev` alone is a tree of servers — and not only its first process.
	const child = runCommand(command, session.env, true);

	let signals = 0;
	const forward = () => {
		signals += 1;
		if (child.pid === undefined || child.exitCode !== null) return;
		try {
			process.kill(-child.pid, signals > 1 ? "SIGKILL" : "SIGTERM");
		} catch {
			// The group is already gone.
		}
	};
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, forward);

	const code = await exitCodeOf(child, command);

	// Whatever the command left running in its group goes with the session.
	if (child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// Nothing left.
		}
	}
	await session.stop();
	if (pidFile) rmSync(pidFile, { force: true });
	console.log(`[session] ${session.id} removed`);
	// Stopping a dev session is how it is meant to end, so `make down` is not reported as a failure.
	// A test run that was interrupted keeps its non-zero code, because it did not pass.
	return kind === "dev" && signals > 0 ? 0 : code;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			console.error(`[session] ${err instanceof Error ? err.message : err}`);
			process.exit(1);
		},
	);
}
