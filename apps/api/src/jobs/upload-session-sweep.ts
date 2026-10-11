// SPDX-License-Identifier: Apache-2.0
/**
 * The abandonment sweep — an upload session past its grace window is aborted at the
 * backend, freeing the parts it holds (which the network bills while they sit), and the
 * row records it.
 *
 * Cadence: daily, in the small hours, beside the other storage sweeps. A session a
 * client abandoned is cost, not data; the three-day grace (`SESSION_CLEANUP_DAYS`) is
 * what separates "the client will finish soon" from "this session is gone". Idempotent:
 * the row's status moves to `aborted`, and the next run never lists it.
 */

import { sweepAbandonedUploadSessions } from "../services/upload-sessions.js";

export async function runUploadSessionSweep(): Promise<number> {
	return sweepAbandonedUploadSessions();
}
