// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether the tests that manufacture abuse reports may run.
 *
 * 🚨 **They never run automatically** (Parker, 2026-08-26): *"abuse report tests should NEVER
 * be automatic, only on explicit request; all that does is add noise to a reporting process
 * that always needs immediate human review."* A floor report is not an ordinary row — it is a
 * request for a person to stop what they are doing and look. A suite that files dozens of
 * them per run is training whoever reads that queue to skim it, which is the one habit the
 * floor exists to prevent.
 *
 * ⚠️ **These tests structurally cannot clean up after themselves, and that is why gating is
 * the only answer rather than the easy one.** `report-escalation.test.ts` ends by deleting its
 * fixture users and comments — and the reports survive, because the FKs in `schema/moderation.ts`
 * are deliberately `set null` rather than `cascade`: *a moderation record is a record and has
 * to outlive the account it concerns.* The test cannot delete its own rows without violating
 * the rule the schema exists to encode. Four rows survived every run, one of them a floor
 * reason, and they accumulated to hundreds.
 *
 * ⭐ What made that visible was a real inbox. `sendEmail` refuses under the test runner, so
 * nothing sent during `bun test` — but `escalate-reports` runs every five minutes in the
 * worker, and the moment `make dev` ran with a real `RESEND_API_KEY` from the dev vault it
 * drained a whole session's fixtures into a real mailbox. **A guard on the sender does not
 * cover a test that writes a row somebody else's process will act on later.** The sender is
 * guarded too now — see `sendAbuseAlert` — but a report nobody needed still should not exist.
 *
 * Run them deliberately with `RUN_ABUSE_TESTS=1 bun test <file>`.
 */

export const ABUSE_TESTS_REQUESTED = process.env.RUN_ABUSE_TESTS === "1";

/** `describe.skipIf(SKIP_ABUSE_TESTS)` — reads as what it does at the call site. */
export const SKIP_ABUSE_TESTS = !ABUSE_TESTS_REQUESTED;
