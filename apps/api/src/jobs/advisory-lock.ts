// SPDX-License-Identifier: Apache-2.0
/**
 * The one session-level advisory-lock primitive.
 *
 * Two jobs serialize work the queue can deliver more than once: the video transcode
 * (job-keyed, because a re-delivery of one job must not encode the same source twice)
 * and the paged renderer (Work-keyed, because a 120-file upload enqueues 120 jobs for one
 * set, and a job-keyed lock would not have stopped two of them colliding on
 * `uq_work_pages`). The mechanics are identical — reserve a session, try the lock,
 * release the connection between attempts, unlock on the same session — so they live
 * here rather than being re-derived by each caller.
 *
 * 🚨 **A lock key stays in its caller's namespace.** `TRANSCODE_LOCK_KEY_BASE` and
 * `PAGED_RENDER_LOCK_KEY_BASE` sit above the serial id space and a serial range apart,
 * so a Work id and a job id cannot land on the same key by arithmetic accident.
 */
import { client } from "@anthers/db";

/** How long between attempts while another handler holds the key. */
export const LOCK_POLL_MS = 10_000;

/**
 * Run `fn` holding the advisory lock at `key`, waiting while another handler holds it.
 * Takes `pollMs` because tests need the wait to be a few milliseconds.
 */
export async function withAdvisoryLock<T>(
	key: number,
	label: string,
	fn: () => Promise<T>,
	pollMs: number = LOCK_POLL_MS,
): Promise<T> {
	let loggedWait = false;
	while (true) {
		// The lock lives on the session, so acquire and hold use one reserved connection;
		// the unlock must ride the same session or it is a no-op. The key is cast to
		// `bigint` explicitly — pg_try_advisory_lock has int and bigint overloads, and an
		// untyped parameter must not have its overload chosen by accident.
		const session = await client.reserve();
		const [row] = await session`select pg_try_advisory_lock(${key}::bigint) as acquired`;
		if (row.acquired) {
			try {
				return await fn();
			} finally {
				await session`select pg_advisory_unlock(${key}::bigint)`;
				session.release();
			}
		}
		session.release();
		if (!loggedWait) {
			loggedWait = true;
			console.log(`${label}: another handler holds the lock; waiting`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}
