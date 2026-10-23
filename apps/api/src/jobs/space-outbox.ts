// SPDX-License-Identifier: Apache-2.0
/**
 * The user-space outbox sweep.
 *
 * ⭐ **One minute, and it is a sweep rather than a per-write job.** The outbox row is the
 * durable statement that something is owed to a space; this handler is what makes the row
 * move whether or not an enqueue happened to fire. A write that arrives between two sweeps
 * waits at most the interval, and a row a producer managed to queue while the worker was down
 * is picked up on the next run rather than stranded.
 *
 * ⚠️ **Quiet on a clean sweep.** The usual answer is zero rows, and a log line per minute
 * saying nothing would train whoever reads the worker's output to skip it.
 */
import { drainSpaceOutbox } from "../services/space-outbox.js";

export interface SpaceOutboxJobData {
	limit?: number;
}

export async function spaceOutboxJob(data: SpaceOutboxJobData = {}): Promise<void> {
	const report = await drainSpaceOutbox({ limit: data.limit ?? 50 });
	if (report.cleared > 0 || report.failed > 0 || report.failures.length > 0) {
		console.log(
			`[space-outbox] claimed ${report.claimed}, cleared ${report.cleared}, ` +
				`parked ${report.failed}, failed attempts ${report.failures.length}`,
		);
	}
}
