// SPDX-License-Identifier: Apache-2.0
/**
 * One emailed-code sign-in per address at a time, across every worker the run is using.
 *
 * The API keeps **one live code per address** and a re-request replaces it — a security
 * property, not something a test may widen. Two workers signing in as the same shared
 * fixture (`gauntlet_creator`, `media_fixture`) otherwise send `signin/start` together,
 * and the loser's `verify` spends a code the winner's start already replaced: the sign-in
 * fails on timing, and which spec loses wanders run to run. Serializing the start→verify
 * pair per address removes the window rather than narrowing it.
 *
 * A lock *file*, because the workers are separate processes and an in-process map would
 * hold no line between them. Exclusive `wx` create is the lock; the holder records its
 * pid, which is what makes an abandoned lock reapable on sight rather than on a timer.
 *
 * 🚨 **The staleness verdict must never outlive the waiter's deadline.** The original
 * shape waited 30s for the lock but only treated a lock older than 120s as stale, so a
 * holder that died mid-ceremony (a test timeout abandoning a sign-in in flight — the
 * exact 2026-10-15 CI shape, `work-image-alt` red-gating #499's merge group and a push
 * to `main` with `timed out waiting for the sign-in lock`) left a lock that waited for
 * a reap its waiters could not live long enough to receive: every ceremony after the
 * crash burned its 30s deadline against a 120s threshold and failed, several specs in
 * a row. The fix is two reaps, and a deadline that is honest about the first: a holder
 * whose pid the OS no longer has is dead, reap immediately (the pid is what the lock
 * records; a recycled pid keeps the age check as the backstop), and a lock older than
 * the staleness threshold is dead the same way.
 *
 * This module is deliberately pure Node: `apps/web/src/signin-lock.test.ts` imports it
 * under `bun test`, which must not drag the Playwright config in with it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** How long a waiter holds out for a live predecessor's ceremony. */
const SIGNIN_LOCK_MS = 30_000;
/** An unreleased lock older than this is a dead holder's, judged by age alone. */
const SIGNIN_LOCK_STALE_MS = 120_000;
/**
 * One poll of the lock, short enough that a healthy predecessor's ceremony (seconds,
 * not more: a completed sign-in deletes its code row, so the next start re-issues
 * freely and the resend throttle never enters a serialized ceremony) resolves within
 * a few polls.
 */
const SIGNIN_LOCK_POLL_MS = 100;

export function signInLockPath(email: string): string {
	return path.join(os.tmpdir(), `anthers-e2e-signin-${Buffer.from(email).toString("hex")}.lock`);
}

/** The holder's pid, or 0 when the file could not be read — an unreadable lock is judged by age alone. */
function signInLockHolderPid(lockFile: string): number {
	try {
		return Number.parseInt(fs.readFileSync(lockFile, "utf8"), 10);
	} catch {
		return 0;
	}
}

export async function withSignInLock<T>(email: string, work: () => Promise<T>): Promise<T> {
	const lockFile = signInLockPath(email);
	const deadline = Date.now() + SIGNIN_LOCK_MS;
	for (;;) {
		try {
			fs.writeFileSync(lockFile, String(process.pid), { flag: "wx" });
			break;
		} catch (err) {
			const held = err as NodeJS.ErrnoException;
			if (held.code !== "EEXIST") throw err;
			// Two reaps, in the order a healthy run meets them: a holder the OS has no
			// record of died mid-ceremony, and its lock is gone *now*, not when the age
			// threshold says so — this is the fix for lock files abandoned by a test
			// timeout, which poisoned every later wait at the old deadline/threshold
			// mismatch (see the docblock above).
			const holderPid = signInLockHolderPid(lockFile);
			let holderLive = false;
			if (holderPid > 0) {
				try {
					process.kill(holderPid, 0); // throws ESRCH on a dead holder
					holderLive = true;
				} catch (e) {
					const signal = e as NodeJS.ErrnoException;
					holderLive = signal.code === "EPERM"; // alive, just not ours to signal
				}
			}
			if (holderPid > 0 && !holderLive) {
				fs.unlinkSync(lockFile);
				continue;
			}
			// A live holder, or a lock whose pid could not be read: a lock older than any
			// sign-in could take is a crashed holder's, not a live one's.
			try {
				if (Date.now() - fs.statSync(lockFile).mtimeMs > SIGNIN_LOCK_STALE_MS) {
					fs.unlinkSync(lockFile);
					continue;
				}
			} catch {
				// It vanished between the stat and the unlink — the lock is simply free.
				continue;
			}
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting for the sign-in lock for ${email}`);
			}
			await new Promise((resolve) => setTimeout(resolve, SIGNIN_LOCK_POLL_MS));
		}
	}
	try {
		return await work();
	} finally {
		fs.rmSync(lockFile, { force: true });
	}
}