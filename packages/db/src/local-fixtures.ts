// SPDX-License-Identifier: Apache-2.0
/**
 * The password every local fixture account is created with, so a test can sign in as one.
 *
 * 🚨 **A local test credential, never a production one.** These accounts live in a session's
 * disposable database or a developer's own checkout, and nothing in a deployed environment runs
 * `createLocalAccount`. Sign-in itself is now a password (or OAuth for an identity on another
 * server), so a fixture whose password nobody knows cannot be signed in to at all.
 *
 * ⚠️ **One value rather than one per fixture**, because the browser harness signs in as several
 * seeded accounts (the gauntlet walker, its creator, the media fixture) and a second constant per
 * seed is a second thing to keep in step. `LOCAL_ACCOUNT_PASSWORD` in the environment still wins
 * when a spec needs a different one.
 */
export const LOCAL_ACCOUNT_PASSWORD = "anthers local fixture password";
