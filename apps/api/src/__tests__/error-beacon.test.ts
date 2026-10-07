// SPDX-License-Identifier: Apache-2.0
/**
 * The browser error beacon's ingest route — every defense is a case, because each one is
 * load-bearing (the route's docblock names the shape each answers). Walked through the
 * real app and the real table, in the suite's own session.
 *
 * 🚨 **The route must never 500** — this suite's most important case is the malformed
 * body, answered 400/204 rather than thrown. A failed capture becoming an error is the
 * exact inversion the golden rule exists to stop.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { errorEvents } from "@anthers/db/schema";
import { like } from "drizzle-orm";
import app from "../index";

const ORIGIN_OK = "http://localhost:3000";

function beacon(body: unknown, origin = ORIGIN_OK, ip = "10.9.9.9") {
	return app.fetch(
		new Request("http://localhost/api/errors/browser", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: origin, "x-forwarded-for": ip },
			body: JSON.stringify(body),
		}),
	);
}

beforeEach(async () => {
	// This suite's rows carry the test marker in the message; the heartbeat's row does not.
	await db.delete(errorEvents).where(like(errorEvents.message, "beacon-test%"));
});

describe("POST /api/errors/browser", () => {
	it("stores a well-formed beacon, fingerprinted and namespaced browser", async () => {
		// The nonce carries no digit and no uuid shape: normalize flattens both, so the
		// row is found by its *stored* (normalized) message rather than the raw one.
		const nonce = crypto.randomUUID().replaceAll("-", "x").replace(/[0-9]/g, "q");
		const message = `beacon-test case ${nonce}`;
		const res = await beacon({
			message,
			frames: [{ fn: "renderWork", loc: "chunk-4f2a.js:1:88421" }],
			path: "/works/some-game",
			userAgent: "test-agent/1.0",
		});
		expect(res.status).toBe(204);
		const [row] = await db
			.select()
			.from(errorEvents)
			.where(like(errorEvents.message, "beacon-test case%"))
			.limit(1);
		expect(row?.source).toBe("browser");
		expect(row?.count).toBe(1);
		expect(JSON.parse(row?.topFrames ?? "[]")[0].loc).toBe("chunk-4f2a.js:1:88421");
	});

	it("refuses a foreign Origin outright, and admits an absent one", async () => {
		const foreign = await beacon({ message: "beacon-test foreign origin" }, "https://evil.example");
		expect(foreign.status).toBe(403);
		// Some browsers' unhandledrejection sends no Origin; the route's own ruling admits it.
		const absent = await beacon(
			{ message: `beacon-test absent origin ${crypto.randomUUID()}` },
			"",
		);
		expect(absent.status).toBe(204);
	});

	it("refuses the wrong shape with 400 and stores nothing", async () => {
		for (const body of [
			null,
			"string",
			{},
			{ message: "" },
			{ message: "x".repeat(2000) },
			{ message: 42 },
		]) {
			const res = await beacon(body);
			expect(res.status).toBe(400);
		}
		const rows = await db
			.select()
			.from(errorEvents)
			.where(like(errorEvents.message, "beacon-test%"));
		expect(rows.length).toBe(0);
	});

	it("rate-limits the eleventh beacon from one IP in an hour", async () => {
		const ip = `10.9.${crypto
			.randomUUID()
			.slice(0, 4)
			.split("")
			.map((c) => c.charCodeAt(0) % 10)
			.join("")}.1`;
		let last = 204;
		for (let i = 0; i < 11; i++) {
			last = (
				await beacon({ message: `beacon-test flood ${i} ${crypto.randomUUID()}` }, ORIGIN_OK, ip)
			).status;
		}
		expect(last).toBe(429);
	});

	it("never leaks a token or an email from the message — redaction is the server's job", async () => {
		const message = `beacon-test redaction ${crypto.randomUUID()}`;
		await beacon({ message: `${message} mail user@example.com token /s/tok_abc12345xyz` });
		const [row] = await db
			.select()
			.from(errorEvents)
			.where(like(errorEvents.message, "beacon-test redaction%"))
			.limit(1);
		expect(row?.message).not.toContain("user@example.com");
		expect(row?.message).not.toContain("tok_abc12345xyz");
	});
});
