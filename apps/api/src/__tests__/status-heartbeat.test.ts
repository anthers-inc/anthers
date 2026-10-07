// SPDX-License-Identifier: Apache-2.0
/**
 * The status composition and the heartbeat ingest — the surfaces the public page and the
 * droplet drive. The capture suite (error-tracker.test.ts) covers the table; this one
 * covers what wraps it: the state composition, the staleness rule, and the ingest's
 * refusal shapes. The recordHeartbeat/readHeartbeatState pair walks the real table, in
 * the same session database every suite gets.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@anthers/db/client";
import { errorEvents } from "@anthers/db/schema";
import { readHeartbeatState, recordHeartbeat } from "../services/heartbeat";
import { statusReport } from "../services/status";

/** The heartbeat state's fixed key — the row these suites own in the shared table. */
const KEY = "heartbeat:droplet-outside-view";

beforeEach(async () => {
	// Start every case from no report at all, whatever an earlier case left.
	await db.delete(errorEvents).where(eq(errorEvents.fingerprint, KEY));
});

describe("the heartbeat state, derived from staleness", () => {
	it("is unknown when no report has ever landed", async () => {
		const state = await readHeartbeatState();
		expect(state.state).toBe("unknown");
		expect(state.lastReportAt).toBeNull();
	});

	it("reads operational from a fresh up report", async () => {
		await recordHeartbeat({ verdict: "up" });
		const state = await readHeartbeatState();
		expect(state.state).toBe("operational");
		expect(state.lastReportAt).not.toBeNull();
	});

	it("carries the droplet's detail on a down report", async () => {
		await recordHeartbeat({ verdict: "down", detail: "connection reset after TLS hello" });
		const state = await readHeartbeatState();
		expect(state.state).toBe("down");
		expect(state.detail).toBe("connection reset after TLS hello");
	});

	it("turns stale into unknown, not operational — a dead monitor must not read all-clear", async () => {
		await recordHeartbeat({ verdict: "up" });
		// Backdate the row's last-seen past the staleness window.
		await db
			.update(errorEvents)
			.set({ lastSeenAt: new Date(Date.now() - 11 * 60 * 1000) })
			.where(eq(errorEvents.fingerprint, KEY));
		const state = await readHeartbeatState();
		expect(state.state).toBe("unknown");
		expect(state.detail).toContain("not reported");
	});
});

describe("statusReport", () => {
	it("answers components for the page, and never a queue depth or a probe ms", async () => {
		const report = await statusReport();
		expect(report.components.length).toBeGreaterThan(2);
		const names = report.components.map((c) => c.name);
		expect(names).toContain("Database");
		// The public-copy line: no numbers on the public answer.
		for (const component of report.components) {
			expect(Object.keys(component)).not.toContain("ms");
		}
	});

	it("degrades its headline when the outside view reports down", async () => {
		await recordHeartbeat({ verdict: "down" });
		const report = await statusReport();
		expect(report.external.state).toBe("down");
		// The hub itself is answering (it is, famously, answering this request).
		expect(report.state).toBe("degraded");
		expect(report.components.find((c) => c.name === "Outside view")?.state).toBe("down");
	});
});
