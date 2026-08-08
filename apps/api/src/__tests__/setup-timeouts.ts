// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Timeout for setup steps that talk to the database.
 *
 * Bun's default is **5s for a test *and* for a hook**, which is generous for an assertion
 * and tight for a `beforeAll` that signs up two users and seeds a handful of rows. Those
 * steps take well under a second on an idle machine — the whole `delivery-access` file
 * runs in ~1s — but they are a chain of round trips against a shared Postgres, and every
 * one of them stretches under contention. On a contended CI runner, or a laptop running
 * the suite next to a build, a 5x slowdown is ordinary and puts the step over the line.
 *
 * The failure that produces is genuinely misleading. A timed-out `beforeAll` is reported
 * as an **unnamed failing test** and the rest of that `describe` never runs, so the suite
 * shows both a mystery failure and a *different test count* between runs (454 became 430
 * and 438 on 2026-08-07) — which reads as tests disappearing rather than a step that ran
 * out of clock. Reproduced exactly by holding an `ACCESS EXCLUSIVE` lock on `users` for
 * 7s: the hook dies at 5002ms and none of the file's 13 tests run.
 *
 * Raising it is not papering over a hang. Nothing here is a product code path — these are
 * fixture inserts — and a step that is genuinely stuck still fails, just later. What the
 * bigger budget buys is that a slow machine stops being a red build.
 *
 * **Where to apply it.** Every DB-touching `beforeAll`, plus the handful of *setup steps
 * wearing a test's clothes* — a first `it()` that signs up the accounts every later test
 * in the file authenticates with (`publish-gating`, `unified-post`). Those cascade when
 * they time out: one 5s overrun fails the setup and then every test depending on it, which
 * is how a single slow signup produced two unrelated-looking failures on 2026-08-07.
 *
 * **Where not to.** Ordinary test bodies keep the 5s default, including ones that happen
 * to sign up a user while genuinely asserting on signup. A slow assertion is usually a
 * real finding, and the point of this constant is to separate "setup needs room" from
 * "this got slow", not to blanket the suite.
 *
 * Note this cannot live in `bunfig.toml` (Bun 1.3.x has no `[test] timeout` key) and a
 * `--timeout` flag would only cover the invocation that carried it — CI, `make verify`
 * and a developer's bare `bun test` would each need their own copy, and drift. The
 * per-step argument travels with the code.
 */
export const DB_SETUP_TIMEOUT = 30_000;
