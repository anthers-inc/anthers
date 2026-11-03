// SPDX-License-Identifier: Apache-2.0
/**
 * The access log's one job: say what was requested and never what it carried.
 *
 * Hono's `logger()` printed the whole URL. That is fine for a path-routed application and
 * wrong for this one, where an unsubscribe token, a share token and an OAuth `code`/`state`
 * all travel in the query and all land in stdout and any log pipeline reading it.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import app from "../index.js";
import { requestLog } from "./request-log.js";

describe("the access log", () => {
	it("names the path and drops the query string", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const app = new Hono().use(requestLog).get("/unsubscribe", (c) => c.text("ok"));
			const res = await app.request("/unsubscribe?token=SECRET-UNSUB-TOKEN");

			expect(res.status).toBe(200);
			const lines = log.mock.calls.map((call) => call.map(String).join(" "));
			expect(lines.join("\n")).not.toContain("SECRET-UNSUB-TOKEN");
			expect(lines.join("\n")).toContain("/unsubscribe");
		} finally {
			log.mockRestore();
		}
	});

	it("keeps a share token and an OAuth code out of the log too", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const app = new Hono().use(requestLog).get("/works/:id", (c) => c.text("ok"));
			await app.request("/works/1?share=SHARE-SECRET");
			const lines = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
			expect(lines).not.toContain("SHARE-SECRET");
			expect(lines).toContain("/works/1");
		} finally {
			log.mockRestore();
		}
	});
});

describe("the log the app actually installs", () => {
	it("is this one, and it drops the query from a real request", async () => {
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			// 🚨 The wiring, not just the middleware: a suite that imported `requestLog`
			// while `index.ts` still mounted `hono/logger` would pass the cases above and
			// leave every real token in the log.
			const res = await app.request("/api/status?share=SHARE-SECRET");
			expect(res.status).toBe(200);
			const lines = log.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
			expect(lines).not.toContain("SHARE-SECRET");
			expect(lines).toContain("/api/status");
		} finally {
			log.mockRestore();
		}
	});
});
