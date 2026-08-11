// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `anthersp2p login` — the browser handoff, so nothing has to paste a session token.
 *
 * Same enrolment flow the desktop Studio uses (42.06 § Desktop auth), reusing its endpoints
 * rather than adding a second auth primitive: the client invents a PKCE verifier, the hub
 * records its hash, a browser confirms under an ordinary cookie session, and the client
 * redeems the result. What comes back is a normal `sessions` row, independently revocable
 * from Settings → Devices like any other device.
 *
 * ── Polling, and why there is no code and no callback ───────────────────────────────
 *
 * The desktop app receives a one-time `code` over its registered `anthers://` scheme. This
 * client has no scheme, and — more to the point — is routinely run **over SSH on a headless
 * box**, which is the population `seed` exists for. A deep link has nothing to open and a
 * loopback redirect has no browser on the same machine to redirect. So it polls, and the
 * code disappears: a code is a courier for crossing the browser→app hop, and polling has no
 * hop to cross.
 *
 * That makes the flow work from anywhere. The URL can be opened on a phone while the
 * process waits on a server three time zones away.
 *
 * 🚨 **The poll is keyed on the verifier, never the challenge.** The challenge is in the URL
 * the user opens — address bar, history, whatever they forwarded it through — and the hub
 * burns an enrolment row on any redemption attempt. A challenge-keyed poll would therefore
 * let anyone who merely *saw* the link strand the sign-in. The verifier never leaves this
 * process.
 *
 * ── Where the token goes ────────────────────────────────────────────────────────────
 *
 * A file under `$XDG_CONFIG_HOME/anthers` at mode 0600. Not a keyring: this runs headless,
 * where there is no session bus and no unlocked keyring to talk to, and a login that works
 * on a laptop and fails on a seedbox would fail on exactly the machines that seed. The
 * desktop app, which is always someone's interactive session, does use the OS keychain —
 * the difference is the environment, not the standard.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

/** How long to keep asking. The hub expires an enrolment after ten minutes. */
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Gap between polls. Deliberately unhurried: the thing being waited on is a person finding
 * a browser, and the endpoint is unauthenticated, so a tight loop would be a stranger's
 * process hammering the hub for the entire ten minutes it is allowed to wait.
 */
const POLL_INTERVAL_MS = 2_000;

export class LoginError extends Error {}

/** Where the session token lives. `ANTHERS_CONFIG_HOME` overrides, for tests. */
export function tokenPath(): string {
	const base =
		process.env.ANTHERS_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
	return join(base, "anthers", "token");
}

/**
 * Read the stored token, or null.
 *
 * Never throws. A config file that is missing, unreadable, or full of nonsense is the same
 * situation as never having logged in, and a CLI that crashed on a corrupt token would be
 * unable to run the `login` that would fix it.
 */
export function readStoredToken(): string | null {
	try {
		const raw = readFileSync(tokenPath(), "utf8").trim();
		return raw.length > 0 ? raw : null;
	} catch {
		return null;
	}
}

/**
 * Write the token, readable only by its owner.
 *
 * Written to a temporary file and renamed into place, which is doing three jobs at once and
 * is why it is worth the extra line:
 *
 * - **No window.** Writing in place creates the file at the umask's mode and tightens it
 *   afterwards, so on a shared box there is a moment where the token is on disk and
 *   world-readable. The temp file is 0600 from the instant it exists.
 * - **No inherited permissions.** `writeFileSync`'s `mode` applies only when it CREATES a
 *   file, so re-logging in on a machine where the token was once world-readable would
 *   silently leave it that way. A rename replaces the inode, so the old mode goes with it.
 * - **No torn file.** A process killed mid-write leaves the previous token intact rather
 *   than half of a new one, and `readStoredToken` never has to wonder.
 */
export function storeToken(token: string): string {
	const path = tokenPath();
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${token}\n`, { mode: 0o600 });
	try {
		renameSync(temp, path);
	} catch (err) {
		rmSync(temp, { force: true });
		throw err;
	}
	return path;
}

/** Forget the stored token. Returns false if there was nothing to forget. */
export function clearStoredToken(): boolean {
	try {
		rmSync(tokenPath());
		return true;
	} catch {
		return false;
	}
}

function randomHex(bytes = 32): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** SHA-256 of the verifier, lowercase hex — the form the hub stores as `challenge`. */
export async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Open a URL in the user's browser. Best-effort, and its failure is not an error.
 *
 * On a headless box there is nothing to open, which is the normal case rather than a
 * degraded one — the caller prints the URL either way, so a machine with no browser is a
 * machine where the user reads the URL and opens it somewhere else.
 */
async function openBrowser(url: string): Promise<boolean> {
	const command =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		const proc = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

export interface LoginOptions {
	/** API origin. */
	baseUrl: string;
	/**
	 * Where the authorize PAGE lives, which is not always the API.
	 *
	 * In production both are the apex origin; in development the SPA is on :3000 and the API
	 * on :8000, so deriving one from the other opens a URL the API does not serve — a 404 in
	 * exactly the environment this gets tested in. The desktop shell learned this the same
	 * way (`web_base_url()` in its `main.rs`).
	 */
	webUrl: string;
	/** Shown on the confirmation page, so the user knows what they are approving. */
	label?: string;
	/** Don't try to launch a browser; just print the URL. */
	noBrowser?: boolean;
	fetchImpl?: typeof fetch;
	onLog?: (line: string) => void;
	/** Injectable so tests don't wait two seconds a poll. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface LoginResult {
	token: string;
	username: string;
}

/**
 * Run the whole flow: start, open a browser, wait for the confirmation, return the token.
 *
 * Does NOT store the token — the caller does. Keeping the network flow separate from the
 * filesystem is what lets the flow be tested without writing to anyone's home directory.
 */
export async function login(opts: LoginOptions): Promise<LoginResult> {
	const doFetch = opts.fetchImpl ?? fetch;
	const log = opts.onLog ?? (() => {});
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;

	const verifier = randomHex();
	const challenge = await pkceChallenge(verifier);
	const label = opts.label ?? `anthersp2p on ${hostname()}`;

	const started = await doFetch(`${opts.baseUrl}/api/auth/desktop/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ challenge, label }),
	});
	if (!started.ok) {
		throw new LoginError(`Anthers refused the sign-in request (HTTP ${started.status}).`);
	}

	const url = `${opts.webUrl}/desktop/authorize?challenge=${challenge}&client=cli`;
	log("Open this in a browser — any browser, on any device — and confirm:\n");
	log(`  ${url}\n`);
	if (!opts.noBrowser && (await openBrowser(url))) {
		log("  (opened in your browser)");
	}
	log("Waiting for you to confirm… (Ctrl-C to cancel)");

	const deadline = now() + POLL_TIMEOUT_MS;
	while (now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		let res: Response;
		try {
			res = await doFetch(`${opts.baseUrl}/api/auth/desktop/poll`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ verifier }),
			});
		} catch {
			// A blip in a ten-minute wait is not a reason to make somebody start over.
			continue;
		}
		if (res.status === 202) continue;
		if (res.status === 404) {
			throw new LoginError("That sign-in request expired or was already used. Try again.");
		}
		if (!res.ok) throw new LoginError(`Sign-in failed (HTTP ${res.status}).`);

		const body = (await res.json()) as { token?: string; user?: { username?: string } };
		if (!body.token) throw new LoginError("Anthers did not return a session.");
		return { token: body.token, username: body.user?.username ?? "" };
	}

	throw new LoginError("Timed out waiting for confirmation.");
}
