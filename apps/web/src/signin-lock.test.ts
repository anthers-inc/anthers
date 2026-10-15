// SPDX-License-Identifier: Apache-2.0
/**
 * The e2e sign-in lock in `tests/e2e/signin-lock.ts` holds across processes, not just
 * within one.
 *
 * A lock that only worked inside a single process would be no lock at all — the failure it
 * exists for is two Playwright workers, which are separate OS processes, racing the same
 * fixture address. So the tests prove, in order: a live holder blocks a waiter until it
 * releases; an abandoned holder (dead pid, the shape a test timeout leaves behind) is
 * reaped *immediately* rather than waited out; and an unreadable lock falls back to the
 * age check. The reaping pins the 2026-10-15 fix: at the old thresholds a 30s waiter
 * could never outlive a 120s staleness verdict, so one dead holder poisoned every later
 * ceremony for the rest of the run (#499's failed check, the `main` push after it).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { signInLockPath, withSignInLock } from "../tests/e2e/signin-lock";

const HOLD_MS = 400;

describe("the e2e sign-in lock", () => {
	it("blocks while a live holder keeps it, then takes", async () => {
		const email = `lock-probe-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const lockFile = signInLockPath(email);
		fs.rmSync(lockFile, { force: true });

		// A child holds the lock for a beat — exactly what a second worker doing the same
		// sign-in is. It writes its own pid, since a real holder does, and exits without
		// unlinking, as an abandoned ceremony would.
		const child = Bun.spawn([
			process.execPath,
			"-e",
			`const fs = require("fs");` +
				`fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid), { flag: "wx" });` +
				`setTimeout(() => process.exit(0), ${HOLD_MS});` +
				`setInterval(() => {}, 1000);`,
		]);
		// Give the child the lock before the parent tries for it.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const began = Date.now();
		const token = await withSignInLock(email, async () => "took");
		const waited = Date.now() - began;
		expect(token, "the parent's ceremony did not run").toBe("took");
		// The wait is the point: the parent acquired only once the holder was gone, so it
		// cannot have resolved instantly. Loose bounds — the holder held 400ms total and
		// the parent started 150ms into it.
		expect(waited).toBeGreaterThan(HOLD_MS / 2);
		expect(await child.exited).toBe(0);
		fs.rmSync(lockFile, { force: true });
	});

	it("reaps an abandoned holder's lock immediately, by its dead pid", async () => {
		const email = `lock-dead-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const lockFile = signInLockPath(email);
		fs.rmSync(lockFile, { force: true });
		// The abandoned ceremony's shape, minus the abandoner: a lock whose pid no OS has.
		fs.writeFileSync(lockFile, String(999_999_999), { flag: "wx" });

		const began = Date.now();
		const token = await withSignInLock(email, async () => "took");
		const took = Date.now() - began;
		expect(token, "the reap did not hand the lock over").toBe("took");
		// The old code burned its whole 30s deadline on this shape and failed; the fix
		// reaps within a poll, so a fast resolution IS the assertion.
		expect(took).toBeLessThan(10_000);
		expect(fs.existsSync(lockFile), "the taken lock was not cleaned up on release").toBe(false);
		fs.rmSync(lockFile, { force: true });
	});

	it("reaps an unreleased lock past the staleness threshold, by age", async () => {
		const email = `lock-old-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const lockFile = signInLockPath(email);
		fs.rmSync(lockFile, { force: true });
		// Content is not even a pid — the unreadable case, which the age check owns.
		fs.writeFileSync(lockFile, "child", { flag: "wx" });
		fs.utimesSync(lockFile, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));

		const began = Date.now();
		const token = await withSignInLock(email, async () => "took");
		expect(token, "the stale lock was not reaped").toBe("took");
		expect(Date.now() - began).toBeLessThan(10_000);
		fs.rmSync(lockFile, { force: true });
	});
});
