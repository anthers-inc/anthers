// SPDX-License-Identifier: Apache-2.0
/**
 * The worker's schema check: a build that is behind the database stops consuming.
 *
 * App Platform keeps the outgoing deployment serving while the new one comes up, and the
 * migrate job runs before either. A rename or a column drop therefore lands under code that
 * still asks for the old names, and on 2026-10-28 three cron sweeps failed on exactly that
 * (`access-receipts`, `escalate-reports`, `release-scheduled`). A sweep pays one skipped tick;
 * a per-item queue would strand its unit of work as a failed row.
 *
 * The state itself comes from `@anthers/db/schema-head`, which compares this build's journal
 * head against `drizzle.__drizzle_migrations`. This module is the worker-shaped decision around
 * it: one check before any handler is registered, and a watch for the window a migration opens
 * under a worker that is already serving.
 *
 * 🚨 **The watch stops the queue, it does not exit.** The incoming deployment replaces this
 * process within a minute or two; exiting would be answered by a restart, and a restart loop is
 * what the platform's `RESTART_COUNT` alert is for. An idle process that holds its interval is
 * the quiet version.
 */
import { readSchemaStanding, type SchemaStanding } from "@anthers/db/schema-head";

/** How often a serving worker asks whether the schema has moved under it. */
export const SCHEMA_GUARD_INTERVAL_MS = 15_000;

/** The reader seam, so a suite observes the decision rather than a real database. */
export type SchemaStandingReader = () => Promise<SchemaStanding>;

/** One check that never throws: a read that fails answers `unknown`, which serves. */
export async function schemaStandingNow(
	read: SchemaStandingReader = readSchemaStanding,
): Promise<SchemaStanding> {
	try {
		return await read();
	} catch {
		return "unknown";
	}
}

export interface SchemaWatchOptions {
	/** Defaults to the real comparison; a suite passes a fake. */
	read?: SchemaStandingReader;
	/** Called once, on the first check that finds the database ahead. */
	onBehind: () => Promise<void> | void;
	intervalMs?: number;
	log?: (message: string) => void;
}

/**
 * Poll the standing and call `onBehind` once when the database has moved ahead of this build.
 * Returns a stop function, which the worker does not call: the interval is also what keeps a
 * stood-down process alive until its replacement arrives.
 */
export function watchSchema(options: SchemaWatchOptions): () => void {
	const read = options.read ?? readSchemaStanding;
	const intervalMs = options.intervalMs ?? SCHEMA_GUARD_INTERVAL_MS;
	const log = options.log ?? ((message: string) => console.warn(message));
	let stopped = false;
	let stoodDown = false;

	const tick = async (): Promise<void> => {
		if (stopped || stoodDown) return;
		if ((await schemaStandingNow(read)) !== "build-behind") return;
		stoodDown = true;
		log(
			"[worker] standing down: the database has applied a migration this build does not ship, " +
				"so its handlers cannot be trusted against the schema. No further jobs are taken; they " +
				"wait for the incoming deployment.",
		);
		try {
			await options.onBehind();
		} catch (err) {
			// The log above is the record; a failed stop must not throw out of a timer.
			log(`[worker] the schema stand-down could not stop the queue: ${String(err)}`);
		}
	};

	const timer = setInterval(() => void tick(), intervalMs);
	void tick();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
