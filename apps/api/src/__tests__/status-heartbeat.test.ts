// SPDX-License-Identifier: Apache-2.0
/**
 * The status composition and the heartbeat ingest — the surfaces the public page and the
 * droplet drive. The capture suite (error-tracker.test.ts) covers the table; this one
 * covers what wraps it: the state composition, the staleness rule, and the ingest's
 * refusal shapes. The recordHeartbeat/readHeartbeatState pair walks the real table, in
 * the same session database every suite gets.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { errorEvents } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { readHeartbeatState, recordHeartbeat } from "../services/heartbeat";
import { statusReport } from "../services/status";

/** The heartbeat state's fixed key — the row these suites own in the shared table. */
const KEY = "heartbeat:droplet-outside-view";

/**
 * Walk the real app for the ingest, the way the droplet does: bearer token, JSON body,
 * **and no Origin header** — a machine-to-machine POST from a cron script carries none,
 * which is exactly why the ingest sits in `CSRF_EXEMPT_PATHS`. A case that sends an
 * Origin proves the route's own token check stays the authority either way.
 */
function ingest(body: unknown, token: string | null = "right", origin?: string) {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	if (origin) headers.Origin = origin;
	return app.fetch(new Request("http://localhost/api/status/heartbeat", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	}));
}

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
		// The public-copy line: no numbers on the public answer. A `since` timestamp is
		// allowed — how long a condition has continued is a fact a reader acts on, and it
		// changes nothing about load; but a probe's milliseconds or a queue's depth are
		// never present.
		for (const component of report.components) {
			expect(Object.keys(component)).not.toContain("ms");
			if (component.since !== undefined) expect(Object.keys(component)).toContain("since");
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

describe("POST /api/status/heartbeat through the app", () => {
	// 🚨 The CSRF-middleware ruling this suite exists to hold: the ingest authenticates
	// by its own bearer secret and carries no Origin, so the global csrfProtection must
	// not answer it at all. The first ship missed the exemption — middleware resolved
	// the token as a session (it is not one), failed, and 401'd every droplet report
	// before the route's own check ran; production's outside view read `unknown` for
	// six days while the page's other rows answered fine. A bearer token that is not a
	// session must never fall into the session-refusal branch of a gate upstream of the
	// route that actually understands it.
	it("accepts a correct token with no Origin header — the droplet's real shape", async () => {
		process.env.HEARTBEAT_TOKEN = "right";
		try {
			const res = await ingest({ verdict: "up" });
			expect(res.status).toBe(200);
			const state = await readHeartbeatState();
			expect(state.state).toBe("operational");
		} finally {
			delete process.env.HEARTBEAT_TOKEN;
		}
	});

	it("refuses a wrong token with 404, exempt or not — the exemption is not a door", async () => {
		process.env.HEARTBEAT_TOKEN = "right";
		try {
			const res = await ingest({ verdict: "up" }, "wrong");
			expect(res.status).toBe(404);
		} finally {
			delete process.env.HEARTBEAT_TOKEN;
		}
	});

	it("refuses a valid-shaped token when no token is configured — fail closed", async () => {
		delete process.env.HEARTBEAT_TOKEN;
		const res = await ingest({ verdict: "up" }, "right");
		expect(res.status).toBe(404);
		expect(await readHeartbeatState()).toMatchObject({ state: "unknown", lastReportAt: null });
	});
});
