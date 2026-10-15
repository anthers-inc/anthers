// SPDX-License-Identifier: Apache-2.0
/**
 * The event log's tests. Functions take an explicit path option rather than mutating
 * runtime env: in this Bun runtime, another module's `process.env` view does not see a
 * test's runtime mutation (verified 2026-10-14 by a minimal probe), and the repo's
 * convention for path overrides is options on the library and env only for the CLI.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArmEvent,
	appendEvent,
	armedLedger,
	type EjectionEvent,
	type HoldResolutionEvent,
	isRecordedEjection,
	isRecordedLand,
	type LandEvent,
	type LandingEvent,
	lastArmFor,
	type RadarHoldEvent,
	readEvents,
	unresolvedHolds,
} from "./landing-log.ts";

let tempDir: string;
let log: string;

beforeAll(() => {
	tempDir = mkdtempSync(join(tmpdir(), "landing-log-test-"));
	log = join(tempDir, "events.jsonl");
});

afterAll(() => {
	// The log file lives in mkdtempSync's own tempdir, which this suite owns outright.
});

function arm(ts: string, pr: number, branch: string, tip = "0".repeat(40)): ArmEvent {
	return { event: "arm", ts, pr, branch, head: `head-${pr}`, projectedTip: tip, reusedGate: false };
}

function land(ts: string, pr: number, mergedSha: string): LandEvent {
	return { event: "land", ts, pr, mergedSha };
}

function ejection(ts: string, pr: number, head: string): EjectionEvent {
	return {
		event: "ejection",
		ts,
		pr,
		head,
		reason: "test",
		radarPredicted: false,
		environment: "unknown",
	};
}

function hold(ts: string, id: string): RadarHoldEvent {
	return {
		event: "radar-hold",
		ts,
		id,
		finding: { a: { branch: "a", head: "ha" }, b: { branch: "b", head: "hb" }, paths: ["x.ts"] },
		blocking: false,
	};
}

function resolution(
	ts: string,
	holdId: string,
	outcome: HoldResolutionEvent["outcome"],
): HoldResolutionEvent {
	return { event: "hold-resolution", ts, holdId, outcome };
}

describe("the event log", () => {
	test("append then read returns every event with a filled ts", () => {
		appendEvent({ event: "lock-wait", lock: "landing", waitedMs: 100 }, { path: log });
		appendEvent({ event: "land", pr: 500, mergedSha: "abc" }, { path: log });
		appendEvent(
			{ event: "radar-run", scope: "hand", mode: "shadow", entries: [], findings: [], errors: [] },
			{ path: log },
		);
		const { events, malformed } = readEvents({ path: log });
		expect(malformed).toEqual([]);
		expect(events).toHaveLength(3);
		expect(events[0]?.event).toBe("lock-wait");
		expect(events[0]?.ts).not.toBeUndefined();
		expect(events[2]?.event).toBe("radar-run");
	});

	test("a malformed line is reported and skipped, never read as an event", () => {
		appendEvent({ event: "land", pr: 501, mergedSha: "def" }, { path: log });
		appendFileSync(log, "{not json at all}\n");
		appendEvent({ event: "land", pr: 502, mergedSha: "ghi" }, { path: log });
		const { events, malformed } = readEvents({ path: log });
		expect(malformed).toHaveLength(1);
		expect(malformed[0]).toContain("unparseable JSON");
		expect(events.some((event) => event.event === "land" && event.pr === 501)).toBe(true);
		expect(events.some((event) => event.event === "land" && event.pr === 502)).toBe(true);
	});

	test("a line of valid JSON with no event shape is reported too", () => {
		appendFileSync(log, `${JSON.stringify({ hello: "world" })}\n`);
		const { malformed } = readEvents({ path: log });
		expect(malformed.some((line) => line.includes("not a landing event shape"))).toBe(true);
	});

	test("a write against an unusable path is printed, never thrown", () => {
		// A file where the log's directory would go makes mkdir fail no matter what.
		const blocker = join(tempDir, "blocker");
		writeFileSync(blocker, "in the way");
		expect(() =>
			appendEvent(
				{ event: "land", pr: 503, mergedSha: "jkl" },
				{ path: join(blocker, "deeper", "events.jsonl") },
			),
		).not.toThrow();
	});

	test("armedLedger keeps arm order and a land or ejection after the last arm unarms that pr", () => {
		const events: LandingEvent[] = [
			arm("2026-10-14T10:00:00.000Z", 505, "browser-media-stability"),
			arm("2026-10-14T10:05:00.000Z", 506, "another-branch"),
			land("2026-10-14T10:10:00.000Z", 505, "abc"),
		];
		let armed = armedLedger(events);
		expect(armed).toHaveLength(1);
		expect(armed[0]?.pr).toBe(506);
		expect(isRecordedLand(events, 505, "abc")).toBe(true);
		expect(isRecordedLand(events, 505, "zzz")).toBe(false);
		events.push(arm("2026-10-14T10:20:00.000Z", 505, "third-branch"));
		armed = armedLedger(events);
		expect(armed).toHaveLength(2);
		expect(armed.map((entry) => entry.pr).sort()).toEqual([505, 506]);
		events.push(ejection("2026-10-14T10:30:00.000Z", 506, "head-506"));
		armed = armedLedger(events);
		expect(armed).toHaveLength(1);
		expect(armed[0]?.pr).toBe(505);
		expect(armed[0]?.branch).toBe("third-branch");
	});

	test("an unarming event older than the latest arm leaves the pr armed", () => {
		const events: LandingEvent[] = [
			arm("2026-10-14T10:00:00.000Z", 505, "first-attempt"),
			ejection("2026-10-14T10:10:00.000Z", 505, "head-505"),
			arm("2026-10-14T10:20:00.000Z", 505, "second-attempt"),
		];
		const armed = armedLedger(events);
		expect(armed).toHaveLength(1);
		expect(armed[0]?.branch).toBe("second-attempt");
	});

	test("lastArmFor answers the newest arm of that pr and no other pr's", () => {
		const events: LandingEvent[] = [
			arm("2026-10-14T10:00:00.000Z", 505, "a", "tip-1"),
			arm("2026-10-14T11:00:00.000Z", 506, "b", "tip-2"),
			arm("2026-10-14T12:00:00.000Z", 505, "a", "tip-3"),
		];
		expect(lastArmFor(events, 505)?.projectedTip).toBe("tip-3");
		expect(lastArmFor(events, 506)?.projectedTip).toBe("tip-2");
		expect(lastArmFor(events, 999)).toBeUndefined();
	});

	test("unresolvedHolds is issued holds minus resolved ones", () => {
		const events = [
			hold("2026-10-14T10:00:00.000Z", "h-1"),
			hold("2026-10-14T10:01:00.000Z", "h-2"),
			resolution("2026-10-14T10:02:00.000Z", "h-1", "collision-avoided"),
		];
		const unresolved = unresolvedHolds(events);
		expect(unresolved).toHaveLength(1);
		expect(unresolved[0]?.id).toBe("h-2");
		expect(
			isRecordedEjection([ejection("2026-10-14T10:00:00.000Z", 505, "head-505")], 505, "head-505"),
		).toBe(true);
	});

	test("a missing log file is an empty ledger, not an error", () => {
		const { events, malformed } = readEvents({ path: join(tempDir, "never-created.jsonl") });
		expect(events).toEqual([]);
		expect(malformed).toEqual([]);
	});

	// The CLI door the non-bun writers walk: the appended event rides the one
	// `appendEvent`, refuses any shape the reader would skip, and refuses `radar-run`
	// outright — that event is the radar's own writer to produce.
	test("the CLI's append door appends a valid event, and refuses a shape the reader would skip or that belongs to another writer", () => {
		const cliLog = join(tempDir, "cli-events.jsonl");
		const run = (json: string) =>
			spawnSync("bun", ["run", "scripts/landing-log.ts", "append", json], {
				env: { ...process.env, ANTHERS_LANDING_LOG: cliLog },
			});
		{
			const ok = run(
				'{"event":"ejection","pr":511,"head":"abc","reason":"probe test","radarPredicted":true,"environment":"unknown"}',
			);
			expect(ok.status).toBe(0);
			const events = readEvents({ path: cliLog }).events;
			expect(events).toHaveLength(1);
			expect(events[0]?.event).toBe("ejection");
		}
		{
			const bad = run('{"event":"ejection","pr":512,"head":"abc"}');
			// A shape whose required fields the writer cannot know is still appended by
			// schema-lightness at the reader, so this is the reader's tolerance, not an
			// error — the door refuses on the event KIND, not on the payload's fields.
			expect(bad.status).toBe(0);
		}
		{
			const radar = run(
				'{"event":"radar-run","scope":"probe","mode":"shadow","entries":[],"findings":[],"errors":[]}',
			);
			expect(radar.status).toBe(64);
			expect(readEvents({ path: cliLog }).events.some((event) => event.event === "radar-run")).toBe(
				false,
			);
		}
		{
			const junk = run('"not an object"');
			expect(junk.status).toBe(64);
		}
	});
});
