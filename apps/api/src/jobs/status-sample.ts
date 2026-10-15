// SPDX-License-Identifier: Apache-2.0
/**
 * The status sampler — the cron that turns the live status answer into the recorded
 * history the public page's bars and Past Incidents render from.
 *
 * **One pass reads the same answer the page reads.** The handler composes
 * `statusReport()` — the public answer, composed fresh per call — and hands every
 * component row to `services/status-history.ts`, which tallies the UTC day bucket and
 * walks the incident windows. Nothing numeric that `/health` holds (queue depths, probe
 * milliseconds) is asked for or stored: the record is states and sentences, the same
 * grain the public route renders, because the record's only consumer is the public page.
 *
 * ⚠️ **The sampler's cadence is the record's grain, and its own death is a gap in the
 * record** — five minutes of unrecorded time when the worker is down, precisely the
 * minutes an outage is made of. That blind spot is deliberate: the minute-level alarm is
 * the droplet heartbeat's (outside the failure domain, email on a verdict change), and
 * making the sampler resilient to the worker's death would need a second failure domain,
 * which is what the heartbeat already is. See `services/status-history.ts`'s docblock.
 */

import { statusReport } from "../services/status.js";
import { pruneStatusHistory, recordStatusSample } from "../services/status-history.js";

export async function statusSample(): Promise<void> {
	const report = await statusReport();
	const samples = report.components.map((component) => ({
		name: component.name,
		state: component.state,
		...(component.detail ? { detail: component.detail } : {}),
	}));
	await recordStatusSample(samples);
	// The window's edge moves one day a day, so the prune rides the sampler rather than
	// owning a second cron: a DELETE against an indexed day column with (worst case)
	// half a thousand rows is free at this cadence, and no second queue name to retire.
	await pruneStatusHistory();
}
