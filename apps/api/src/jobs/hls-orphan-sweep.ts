// SPDX-License-Identifier: Apache-2.0
/**
 * The orphan sweep — video HLS run prefixes no transcode row points at, taken back.
 *
 * Since the transcode's per-variant restructure, each run of the encode renders into a
 * fresh run prefix, chosen inside the job and known to no table until the job's own
 * final write. An attempt that died — crash, instance replacement mid-encode, retries
 * exhausted — leaves its partial ladder in the creator's own prefix: private bytes,
 * unreachable by any client, uncounted by any sweep, and standing against the
 * creator's storage allowance forever if nothing reclaims them. The delete and
 * withdrawal paths enumerate from rows; this is the half for the prefixes whose rows
 * never got to point anywhere.
 *
 * The enumeration and its rules live in `sweepOrphanedVideoHlsPrefixes` (media-purge.ts),
 * because a second hand-written key list is how the two deletion paths diverged once
 * already. What this file owns is the cadence:
 *
 * - **Daily, in the small hours.** The bytes are not urgent (private, uncounted, no
 *   reader), and the sweep enumerates every creator's prefix in storage — off-hours is
 *   where a walk like that belongs.
 * - Idempotent by construction: a swept prefix is gone, and the next run's candidates
 *   are what remains.
 */

import { sweepOrphanedVideoHlsPrefixes } from "../services/media-purge.js";

export async function runHlsOrphanSweep(): Promise<number> {
	return sweepOrphanedVideoHlsPrefixes();
}
