// SPDX-License-Identifier: Apache-2.0
/**
 * The hand-rolled error tracker. The pure half (normalize, redact, parse, fingerprint,
 * shouldAlert) is unit-tested outright; the capture half walks the real `error_events`
 * table in the suite's own session database, because dedupe-by-fingerprint is the design
 * and a stubbed table would test the stub.
 *
 * The sabotage rule, per *Writing Tests That Can Fail*: each case names the break it
 * would catch, and the fixture rows carry their own test marker, so nothing here can be
 * mistaken for a real operator queue item.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { errorEvents } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	alertDue,
	captureError,
	normalizeMessage,
	redactRoute,
	shouldAlert,
} from "../services/error-tracker";

/** A test-session marker, so a fixture row can never read as a real capture. */
const MARK = "error-tracker-test";

/** Each case gets its own distinct message so suites sharing one database stay isolated. */
let caseNum = 0;
const unique = () => `${MARK} case ${++caseNum} ${crypto.randomUUID().slice(0, 8)}`;

// ── Normalize & redact ──────────────────────────────────────────────────────

describe("normalizeMessage", () => {
	it("redacts email, share-token and id shapes before anything is capped", () => {
		const out = normalizeMessage(
			"failed for user@example.com at /s/tok_abc12345xyz and id 3f2b8a10-1234-4abd-9e11-7e22bb3521af",
		);
		expect(out).not.toContain("user@example.com");
		expect(out).not.toContain("tok_abc12345xyz");
		expect(out).not.toContain("3f2b8a10");
		expect(out).toContain("[email]");
		expect(out).toContain("/s/[token]");
	});

	it("collapses per-request variation so two captures of one defect hash alike", () => {
		const a = normalizeMessage(`Work 482 not found for session "abc"`);
		const b = normalizeMessage(`Work 999 not found for session "xyz"`);
		expect(a).toBe(b);
	});

	it("caps a huge message rather than storing it whole", () => {
		expect(normalizeMessage("x".repeat(5000)).length).toBeLessThanOrEqual(500);
	});
});

describe("redactRoute", () => {
	it("keeps the route shape and drops the addressing that hit it", () => {
		expect(redactRoute("/works/my-game-3f2b8a10-1234-4abd-9e11-7e22bb3521af")).toBe(
			"/works/my-game-[id]",
		);
		expect(redactRoute("/api/payments/invoices/482/items")).toBe(
			"/api/payments/invoices/[id]/items",
		);
		expect(redactRoute("/s/tok_abcd12345")).toBe("/s/tok_abcd12345");
	});
});

// ── shouldAlert — the noisy-channel rule ────────────────────────────────────

describe("shouldAlert", () => {
	const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
	const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);

	it("alerts on the first sight of a fingerprint", () => {
		expect(shouldAlert({ count: 1, alertSentAt: null })).toBe(true);
	});

	it("never re-alerts a recent fingerprint, whatever its count", () => {
		expect(shouldAlert({ count: 5000, alertSentAt: hourAgo })).toBe(false);
	});

	it("resurfaces a fingerprint it last told about over a day ago", () => {
		expect(shouldAlert({ count: 5000, alertSentAt: dayAgo })).toBe(true);
	});
});

// ── Capture — the real table, the real dedupe ───────────────────────────────

describe("captureError", () => {
	beforeEach(async () => {
		// Leave the table as each case found it; fingerprints are unique per case anyway.
	});

	it("stores a first capture as count 1 and alerts the caller", async () => {
		const message = unique();
		const result = await captureError({
			source: "api",
			message,
			stack:
				"Error: boom\n    at handler (apps/api/src/routes/auth.ts:123:45)\n    at dispatch (apps/api/src/index.ts:67:5)",
			context: { route: "/api/auth/sign-in", method: "POST" },
		});
		expect(result?.firstSeen).toBe(true);
		expect(result?.count).toBe(1);
	});

	it("dedupes a recurrence into the same row, counting it", async () => {
		const message = unique();
		await captureError({ source: "api", message });
		const first = await captureError({ source: "api", message });
		expect(first?.firstSeen).toBe(false);
		expect(first?.count).toBe(2);
	});

	it("keeps the same message from different sources as separate rows", async () => {
		const message = unique();
		const api = await captureError({ source: "api", message });
		const browser = await captureError({ source: "browser", message });
		expect(api?.fingerprint).not.toBe(browser?.fingerprint);
	});

	it("refuses nothing but stores no empty message", async () => {
		expect(await captureError({ source: "api", message: "" })).toBeNull();
		expect(await captureError({ source: "api", message: "   " })).toBeNull();
	});

	it("answers alertDue true for a first capture and false once marked, true again after the window", async () => {
		const message = unique();
		const first = await captureError({ source: "api", message });
		if (!first) throw new Error("capture failed");
		expect(await alertDue(first)).toBe(true);

		// Mark it alerted; a recurrence inside the window must now read as quiet.
		await db
			.update(errorEvents)
			.set({ alertSentAt: new Date() })
			.where(eq(errorEvents.fingerprint, first.fingerprint));
		const second = await captureError({ source: "api", message });
		if (!second) throw new Error("second capture failed");
		expect(await alertDue(second)).toBe(false);

		// Past the window, the same fingerprint is news again.
		await db
			.update(errorEvents)
			.set({ alertSentAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
			.where(eq(errorEvents.fingerprint, first.fingerprint));
		await captureError({ source: "api", message });
		const third = await captureError({ source: "api", message });
		if (!third) throw new Error("third capture failed");
		expect(await alertDue(third)).toBe(true);
	});
});
