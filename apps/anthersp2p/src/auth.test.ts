// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `anthersp2p login` — the browser handoff, from the client's side.
 *
 * The hub's half is `apps/api/src/__tests__/desktop-auth.test.ts`. What is worth asserting
 * here is everything the CLI decides on its own: that the verifier it sends really is the
 * preimage of the challenge it published (get that backwards and the flow is theatre), that
 * waiting is a loop rather than a single hopeful request, that a network blip in a
 * ten-minute wait does not make somebody start over, and that the stored token is not
 * readable by every account on a shared seedbox.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearStoredToken,
	LoginError,
	login,
	pkceChallenge,
	readStoredToken,
	storeToken,
	tokenPath,
} from "./auth";

let dir: string;
const previousHome = process.env.ANTHERS_CONFIG_HOME;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "anthersp2p-auth-"));
	process.env.ANTHERS_CONFIG_HOME = dir;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	if (previousHome === undefined) delete process.env.ANTHERS_CONFIG_HOME;
	else process.env.ANTHERS_CONFIG_HOME = previousHome;
});

/** No real waiting, and no real clock — a ten-minute timeout must not take ten minutes. */
const instant = { sleep: async () => {}, noBrowser: true };

/**
 * A hub that accepts the enrolment and answers `pending` a set number of times before
 * handing over the token. Records what it was sent, because the interesting assertions are
 * about what the client PUBLISHED versus what it KEPT.
 */
function hubStub(opts: { pendingRounds?: number; startStatus?: number } = {}) {
	let remaining = opts.pendingRounds ?? 0;
	const seen = { challenge: "", verifiers: [] as string[], label: "", polls: 0 };
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		if (url.endsWith("/desktop/start")) {
			seen.challenge = body.challenge;
			seen.label = body.label;
			return new Response("{}", { status: opts.startStatus ?? 201 });
		}
		if (url.endsWith("/desktop/poll")) {
			seen.polls++;
			seen.verifiers.push(body.verifier);
			if (remaining-- > 0) {
				return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
			}
			return new Response(JSON.stringify({ token: "session-abc", user: { username: "parker" } }), {
				status: 200,
			});
		}
		throw new Error(`unexpected fetch ${url}`);
	}) as unknown as typeof fetch;
	return { impl, seen };
}

describe("the browser handoff", () => {
	it("publishes the hash and keeps the secret", async () => {
		// The one thing that makes PKCE PKCE. If the client published the verifier — or
		// polled with the challenge — the flow would look identical and prove nothing, so
		// this asserts the relationship rather than merely that two strings differ.
		const hub = hubStub();
		const result = await login({
			baseUrl: "https://hub.test",
			webUrl: "https://hub.test",
			fetchImpl: hub.impl,
			...instant,
		});

		expect(result).toEqual({ token: "session-abc", username: "parker" });
		expect(hub.seen.verifiers[0]).not.toBe(hub.seen.challenge);
		expect(await pkceChallenge(hub.seen.verifiers[0])).toBe(hub.seen.challenge);
	});

	it("prints an authorize URL on the SITE, flagged as a CLI sign-in", async () => {
		// Two failures this catches, both silent. Building the URL from the API origin opens
		// a route the API does not serve — a dev-only 404, i.e. broken in exactly the place
		// it gets tested. And without `client=cli` the page fires `anthers://` at a machine
		// with no handler, raising an OS error dialog right after saying it worked.
		const hub = hubStub();
		const lines: string[] = [];
		await login({
			baseUrl: "https://api.test",
			webUrl: "https://site.test",
			fetchImpl: hub.impl,
			onLog: (l) => lines.push(l),
			...instant,
		});
		const printed = lines.join("\n");
		expect(printed).toContain(
			`https://site.test/desktop/authorize?challenge=${hub.seen.challenge}`,
		);
		expect(printed).toContain("client=cli");
		expect(printed).not.toContain("api.test");
	});

	it("keeps asking until a human confirms", async () => {
		const hub = hubStub({ pendingRounds: 4 });
		const result = await login({
			baseUrl: "https://hub.test",
			webUrl: "https://hub.test",
			fetchImpl: hub.impl,
			...instant,
		});
		expect(result.token).toBe("session-abc");
		expect(hub.seen.polls).toBe(5);
		// Every poll carries the same verifier — a client that regenerated one per attempt
		// would be asking about an enrolment nobody started.
		expect(new Set(hub.seen.verifiers).size).toBe(1);
	});

	it("rides out a network blip rather than making someone start over", async () => {
		// Ten minutes is a long time to hold a connection perfectly. A dropped poll is not a
		// failed sign-in, and treating it as one would be the most annoying possible bug.
		let calls = 0;
		const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/desktop/start")) return new Response("{}", { status: 201 });
			calls++;
			if (calls <= 2) throw new TypeError("connection reset");
			return new Response(JSON.stringify({ token: "t", user: { username: "u" } }), {
				status: 200,
			});
		}) as unknown as typeof fetch;

		const result = await login({
			baseUrl: "https://hub.test",
			webUrl: "https://hub.test",
			fetchImpl: impl,
			...instant,
		});
		expect(result.token).toBe("t");
		expect(calls).toBe(3);
	});

	it("stops on an expired enrolment instead of polling a dead flow", async () => {
		const impl = (async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/desktop/start")) return new Response("{}", { status: 201 });
			return new Response(JSON.stringify({ error: "expired" }), { status: 404 });
		}) as unknown as typeof fetch;

		await expect(
			login({
				baseUrl: "https://hub.test",
				webUrl: "https://hub.test",
				fetchImpl: impl,
				...instant,
			}),
		).rejects.toThrow(/expired or was already used/);
	});

	it("gives up when the clock runs out", async () => {
		// The timeout is measured on an injected clock, so the test proves the loop is
		// bounded without a test suite that takes ten minutes to say so.
		let clock = 0;
		const hub = hubStub({ pendingRounds: Number.MAX_SAFE_INTEGER });
		await expect(
			login({
				baseUrl: "https://hub.test",
				webUrl: "https://hub.test",
				fetchImpl: hub.impl,
				sleep: async () => {
					clock += 30_000;
				},
				now: () => clock,
				noBrowser: true,
			}),
		).rejects.toBeInstanceOf(LoginError);
		expect(hub.seen.polls).toBeGreaterThan(1);
	});

	it("does not start polling when the hub refused the enrolment", async () => {
		const hub = hubStub({ startStatus: 400 });
		await expect(
			login({
				baseUrl: "https://hub.test",
				webUrl: "https://hub.test",
				fetchImpl: hub.impl,
				...instant,
			}),
		).rejects.toThrow(/refused the sign-in request/);
		expect(hub.seen.polls).toBe(0);
	});

	it("names the machine on the confirmation page", async () => {
		// The page shows this label. A user staring at "Sign in on this device?" with no idea
		// which device has no way to tell an expected prompt from a phishing one.
		const hub = hubStub();
		await login({
			baseUrl: "https://hub.test",
			webUrl: "https://hub.test",
			fetchImpl: hub.impl,
			...instant,
		});
		expect(hub.seen.label).toStartWith("anthersp2p on ");
	});
});

describe("where the session is kept", () => {
	it("stores, reads back, and forgets", () => {
		expect(readStoredToken()).toBeNull();
		const path = storeToken("tok-123");
		expect(path).toBe(tokenPath());
		expect(readStoredToken()).toBe("tok-123");
		expect(clearStoredToken()).toBe(true);
		expect(readStoredToken()).toBeNull();
		expect(clearStoredToken()).toBe(false);
	});

	it("is readable only by its owner", () => {
		// This runs on shared boxes. A world-readable session file is a session anybody with
		// an account on the seedbox can walk off with.
		storeToken("tok-secret");
		expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
	});

	it("does not inherit loose permissions from a file that was already there", () => {
		// 🚨 `writeFileSync`'s mode applies only when it CREATES a file, so writing in place
		// over a world-readable token would silently keep it world-readable — the account is
		// now safe and the file is not. Renaming replaces the inode, so the old mode goes
		// with it, and no `chmod` afterwards is needed to rescue the situation.
		mkdirSync(join(dir, "anthers"), { recursive: true });
		writeFileSync(tokenPath(), "old\n", { mode: 0o644 });
		storeToken("tok-new");
		expect(statSync(tokenPath()).mode & 0o777).toBe(0o600);
		expect(readStoredToken()).toBe("tok-new");
	});

	it("leaves no temporary file behind", () => {
		// The token is written to a temp file and renamed. A leftover would be a second copy
		// of a live credential sitting next to the one whose permissions everyone checks.
		storeToken("tok-1");
		storeToken("tok-2");
		expect(readdirSync(join(dir, "anthers"))).toEqual(["token"]);
	});

	it("treats an unreadable or empty config as simply not signed in", () => {
		// A CLI that threw here would be unable to run the `login` that would fix it.
		mkdirSync(join(dir, "anthers"), { recursive: true });
		writeFileSync(tokenPath(), "   \n");
		expect(readStoredToken()).toBeNull();
	});
});
