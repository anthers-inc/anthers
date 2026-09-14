// SPDX-License-Identifier: Apache-2.0
/**
 * Every `bun test` runs in a session of its own: a fresh database and a private AT Protocol network,
 * migrated before the first test file loads and removed after the last one finishes.
 *
 * 🚨 **A bare `bun test` used to write into whatever `DATABASE_URL` named, which was the dev
 * database**, so a test run beside a running `make dev` or during a push corrupted both. Starting
 * the session here, rather than in a make target, is what covers the invocation nobody wraps: an
 * agent running one file by hand gets the same isolation as `make verify`.
 *
 * ⚠️ **The environment is set before any test file is imported, and that ordering is the whole
 * mechanism.** The database client reads `DATABASE_URL` when its module loads, and a preload
 * finishes before Bun loads the first test file. Real environment variables written here also beat
 * the values Bun read from `.env`.
 *
 * CI brings its own database as a service container and sets `ANTHERS_SESSION=ci`, which this
 * reuses rather than starting Docker inside a job that has none. See `reusesSession`.
 */

import { afterAll } from "bun:test";
import { reusesSession, startSession } from "./session.ts";

if (!reusesSession(process.env.ANTHERS_SESSION, "test")) {
	const session = await startSession("test", (line) => console.error(line));
	Object.assign(process.env, session.env);

	let stopped = false;
	afterAll(async () => {
		stopped = true;
		await session.stop();
	}, 60_000);

	// An interrupted run skips `afterAll`. Removing the containers here is the fast path; the next
	// session's sweep is the backstop for a run killed too hard to reach even this.
	const stopNow = () => {
		if (stopped) return;
		stopped = true;
		session.stopSync();
	};
	process.on("exit", stopNow);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			stopNow();
			process.exit(130);
		});
	}
}
