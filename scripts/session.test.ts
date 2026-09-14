// SPDX-License-Identifier: Apache-2.0
/**
 * The decisions a session makes before it touches Docker, and the one fact about the run this file
 * is itself part of: that it is in a session of its own.
 *
 * 🚨 **The last describe is the one that matters most.** Every other suite in the repository writes
 * rows, and they are only safe to run beside `make dev` because the preload gave this process a
 * database nobody else uses. If `bunfig.toml` stopped naming the preload, every suite would go back
 * to writing into the dev database and still pass — so this asserts the isolation directly.
 */
import { describe, expect, it } from "bun:test";
import {
	abandoned,
	parseArguments,
	processAlive,
	reusesSession,
	sessionEnvironment,
	sessionPorts,
} from "./session.ts";

function counter(start: number): () => number {
	let next = start;
	return () => next++;
}

describe("the ports a session takes", () => {
	it("keeps the conventional ports for dev, where .env and the tooling expect them", () => {
		expect(sessionPorts("dev", () => 1)).toEqual({ postgres: 5432, plc: 2582, pds: 2583 });
	});

	it("takes free ports for a test run, so it can overlap dev and other runs", () => {
		const ports = sessionPorts("test", counter(40000));
		expect(ports).toEqual({ postgres: 40000, plc: 40001, pds: 40002 });
		expect(Object.values(ports)).not.toContain(5432);
	});

	it("also takes the API and preview ports for a browser run", () => {
		expect(sessionPorts("browser", counter(40000))).toEqual({
			postgres: 40000,
			plc: 40001,
			pds: 40002,
			api: 40003,
			preview: 40004,
		});
	});

	it("never hands the same port to two services, even when the system repeats one", () => {
		const repeats = [41000, 41000, 41001, 41001, 41002];
		const ports = sessionPorts("test", () => repeats.shift() ?? 0);
		expect(new Set(Object.values(ports)).size).toBe(3);
	});
});

describe("the environment a session hands its command", () => {
	it("points the database, the directory and the hosting server at the session's own", () => {
		const env = sessionEnvironment(
			"test-abc",
			{ postgres: 40000, plc: 40001, pds: 40002 },
			"/tmp/s/content",
			{ inviteCode: "localhost-abcde-fghij", accountKey: "k".repeat(64) },
		);
		expect(env).toMatchObject({
			ANTHERS_SESSION: "test-abc",
			DATABASE_URL: "postgres://anthers:anthers@localhost:40000/anthers",
			ATPROTO_PLC_URL: "http://localhost:40001",
			HOSTED_PDS_URL: "http://localhost:40002",
			HOSTED_PDS_INVITE_CODE: "localhost-abcde-fghij",
			LOCAL_CONTENT_DIR: "/tmp/s/content",
		});
		expect(env.API_PORT).toBeUndefined();
	});

	it("gives a browser run the API and preview ports and the base URL they imply", () => {
		const env = sessionEnvironment(
			"browser-abc",
			{ postgres: 1, plc: 2, pds: 3, api: 40003, preview: 40004 },
			"/tmp/s",
			{ inviteCode: "i", accountKey: "k" },
		);
		expect(env).toMatchObject({
			API_PORT: "40003",
			PREVIEW_PORT: "40004",
			BASE_URL: "http://localhost:40003",
		});
	});
});

describe("whether a process reuses the session it is already in", () => {
	it("reuses CI's service containers and a session of its own kind", () => {
		expect(reusesSession("ci", "test")).toBe(true);
		expect(reusesSession("test-1a2b", "test")).toBe(true);
	});

	it("never lets a test run write into a dev session somebody is working in", () => {
		expect(reusesSession("dev", "test")).toBe(false);
		expect(reusesSession("browser-1a2b", "test")).toBe(false);
		expect(reusesSession(undefined, "test")).toBe(false);
		expect(reusesSession("", "test")).toBe(false);
	});
});

describe("what a new session clears away", () => {
	it("removes only what belongs to a run that has ended", () => {
		const leftovers = [
			{ name: "anthers-test-a-postgres", session: "test-a", owner: 100 },
			{ name: "anthers-test-b-postgres", session: "test-b", owner: 200 },
		];
		const alive = (pid: number) => pid === 200;
		expect(abandoned(leftovers, alive).map((l) => l.name)).toEqual(["anthers-test-a-postgres"]);
	});

	it("reads this process as alive and an impossible id as gone", () => {
		expect(processAlive(process.pid)).toBe(true);
		expect(processAlive(0)).toBe(false);
		expect(processAlive(Number.NaN)).toBe(false);
	});
});

describe("the command line", () => {
	it("reads a kind, a pid file and the command after the separator", () => {
		expect(parseArguments(["dev", "--pid-file", ".dev.pid", "--", "bun", "run", "dev"])).toEqual({
			mode: "start",
			kind: "dev",
			pidFile: ".dev.pid",
			command: ["bun", "run", "dev"],
		});
	});

	it("reads an attach to a named session", () => {
		expect(parseArguments(["attach", "dev", "--", "bun", "run", "db:gauntlet"])).toEqual({
			mode: "attach",
			id: "dev",
			command: ["bun", "run", "db:gauntlet"],
		});
	});

	it("refuses an unknown kind or a missing command rather than guessing", () => {
		expect(() => parseArguments(["prod", "--", "true"])).toThrow(/usage/);
		expect(() => parseArguments(["dev"])).toThrow(/usage/);
		expect(() => parseArguments(["attach", "--", "true"])).toThrow(/usage/);
	});
});

describe("this test run", () => {
	it("is inside a session of its own, not the dev database", () => {
		const session = process.env.ANTHERS_SESSION ?? "";
		expect(reusesSession(session, "test")).toBe(true);
		if (session !== "ci") {
			expect(process.env.DATABASE_URL).not.toContain(":5432/");
			expect(process.env.HOSTED_PDS_URL).toMatch(/^http:\/\/localhost:\d+$/);
			expect(process.env.HOSTED_PDS_URL).not.toBe("http://localhost:2583");
		}
	});
});
