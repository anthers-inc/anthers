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

// The org's Badge ladder is platform state, and every test session needs it: any suite
// that reads "what does this account hold on Anthers' ladder" throws loudly when the
// ladder is absent (the guard in `anthers-badges.ts`), and relying on whichever suite
// happens to seed it first made the pass green locally and red on CI, where file order
// put `project-works` ahead of the fixture-owning suites. Seeded here — after the
// session exists (the CI container path above included, since this runs either way) and
// before the first test file loads — the ladder is a property of the session rather than
// a side-effect of suite order. `ensureOrgLadder` in the fixtures still runs: re-checking
// is one indexed SELECT, and a suite's `purgeAccountsCreatedHere` can take the owner away
// (the ladder cascades with it), which is the re-check's documented reason to exist.
{
	const { db } = await import("@anthers/db/client");
	const { users } = await import("@anthers/db/schema");
	const { ensureAnthersBadges } = await import("../apps/api/src/services/anthers-badges.js");
	const { createAccount } = await import("../apps/api/src/__tests__/account-fixture.js");
	const ORG_EMAIL = "seed_org_ladder@example.com";
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where((await import("drizzle-orm")).eq(users.email, ORG_EMAIL))
		.limit(1);
	if (existing) {
		await ensureAnthersBadges(existing.id);
	} else {
		const account = await createAccount("seed_org_ladder", {
			email: ORG_EMAIL,
			emailVerified: true,
		});
		await ensureAnthersBadges(account.userId);
	}
}
