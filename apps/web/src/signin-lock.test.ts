// SPDX-License-Identifier: Apache-2.0
/**
 * The e2e sign-in lock in `fixtures.ts` holds across processes, not just within one.
 *
 * A lock that only worked inside a single process would be no lock at all — the failure it
 * exists for is two Playwright workers, which are separate OS processes, racing the same
 * fixture address. So this spawns a child to hold the file and proves the parent's acquire
 * waits, then proves it takes: both halves, because a lock that blocked a free file would
 * be the outage instead of the flake.
 *
 * The lock path is the same one `withSignInLock` builds from the address, re-derived here
 * rather than imported — `fixtures.ts`'s exports are e2e-only and pulling them into `bun
 * test` would drag the Playwright config in with them.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function lockPathFor(email: string): string {
	return path.join(os.tmpdir(), `anthers-e2e-signin-${Buffer.from(email).toString("hex")}.lock`);
}

describe("the e2e sign-in lock", () => {
	it("blocks while a child process holds it, then takes", async () => {
		const email = `lock-probe-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const lockFile = lockPathFor(email);
		fs.rmSync(lockFile, { force: true });

		// A child holds the lock for a beat — exactly what a second worker doing the same
		// sign-in is.
		const child = Bun.spawn([
			process.execPath,
			"-e",
			`require("fs").writeFileSync(${JSON.stringify(lockFile)}, "child", { flag: "wx" });` +
				"setTimeout(() => process.exit(0), 400); setInterval(() => {}, 1000);",
		]);
		// Give the child the lock before the parent tries for it.
		await new Promise((resolve) => setTimeout(resolve, 150));

		const held = (() => {
			try {
				fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
				return false;
			} catch (err) {
				return (err as NodeJS.ErrnoException).code === "EEXIST";
			}
		})();
		expect(held, "the parent took the file while the child held it").toBe(true);

		await child.exited;
		// The holder is gone; the lock is genuinely free, not sticky on a dead pid.
		fs.rmSync(lockFile, { force: true });
		let took = true;
		try {
			fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
		} catch {
			took = false;
		}
		expect(took, "the lock could not be taken after the holder exited").toBe(true);
		fs.rmSync(lockFile, { force: true });
	});
});
