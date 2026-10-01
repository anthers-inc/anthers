// SPDX-License-Identifier: Apache-2.0
/**
 * The deadline reminder sweep — what it decides to send, and what it never sends twice.
 *
 * The properties pinned here are the ones the 2026-09-14 decision turns on:
 *
 * 1. **Dedupe is load-bearing.** A sweep that re-gathers the same rows every day must never mail
 *    twice for the same item and kind — the second run claims nothing and sends nothing.
 * 2. **The two kinds.** An item owes an arrival reminder the first time the sweep sees it, and a
 *    before-due reminder inside its lead window.
 * 3. **The Calendar's two-reminder rule on terminal items, and nowhere else.** A terminal item
 *    gets two before-due reminders (30 and 7 days); an ordinary item gets exactly one (14 days),
 *    and asserting the ordinary case is what keeps the rule from quietly widening.
 * 4. **`OPERATOR_EMAIL` unset: no send, no crash.** The refusal is one log line and a report
 *    that nobody was told — never a guess at a mailbox.
 *
 * `sendEmail` refuses under the test runner, so the sends are spied on rather than trusted and
 * the assertions read what the sweep asked to send; the dedupe rows are real, because the claim
 * happens before the send and is what the second run collides with.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { deadlineReminders, legalHolds, rightsRequests } from "@anthers/db/schema";
import { and, eq, like } from "drizzle-orm";
import {
	ARRIVAL_HORIZON_DAYS,
	type DeadlineItem,
	remindersDue,
	runDeadlineReminderSweep,
} from "../jobs/deadline-reminders.js";
import * as email from "../services/email.js";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// This suite writes no accounts, but the sweep reads rows other suites may leave, and the purge
// is the standing hygiene rule for anything a suite's fixtures touch.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const DAY_MS = 86_400_000;
const id = crypto.randomUUID().slice(0, 8);
const NOW = new Date("2026-10-01T12:00:00Z");

/** A deadline item, built directly — the gather is `admin-deadlines.test.ts`'s subject. */
function item(values: Partial<DeadlineItem> & { key: string }): DeadlineItem {
	return {
		source: "rights-request",
		title: `Fixture ${values.key}`,
		dueAt: new Date(NOW.getTime() + 60 * DAY_MS),
		windowStart: null,
		terminal: false,
		consequence: "A fixture consequence, plain.",
		actUrl: "/legal/rights-requests",
		note: null,
		...values,
	};
}

/** What `sendEmail` was asked to send, with the provider's answer set by the test. */
function spyOnSends(sent: boolean) {
	return spyOn(email, "sendEmail").mockImplementation(async () => ({
		sent,
		messageId: sent ? "EXAMPLE-message-id" : null,
	}));
}
afterEach(() => mock.restore());

/**
 * The dedupe rows this suite's sweep wrote, addressed by a fixture's key prefix — the dedupe key
 * names the source row's own id, which is the only handle the assertions can rely on.
 */
async function reminderRowsFor(prefix: string) {
	return db
		.select({ key: deadlineReminders.dedupeKey, sentAt: deadlineReminders.sentAt })
		.from(deadlineReminders)
		.where(like(deadlineReminders.dedupeKey, `${prefix}:%`));
}

describe("remindersDue — the decisions, pure", () => {
	it("owes an arrival reminder the first time it sees a database item, whatever its distance", () => {
		const far = item({ key: `far-${id}`, dueAt: new Date(NOW.getTime() + 200 * DAY_MS) });
		const kinds = remindersDue([far], NOW).map((r) => r.kind);
		expect(kinds).toEqual(["arrival"]);
	});

	it("owes a calendar item nothing until it enters the arrival horizon", () => {
		const far = item({
			key: `cal-far-${id}`,
			source: "compliance-calendar",
			dueAt: new Date(NOW.getTime() + (ARRIVAL_HORIZON_DAYS + 60) * DAY_MS),
		});
		expect(remindersDue([far], NOW)).toEqual([]);
		const near = item({
			key: `cal-near-${id}`,
			source: "compliance-calendar",
			dueAt: new Date(NOW.getTime() + (ARRIVAL_HORIZON_DAYS - 1) * DAY_MS),
		});
		expect(remindersDue([near], NOW).map((r) => r.kind)).toEqual(["arrival"]);
	});

	it("owes an ordinary item exactly one before-due reminder, at 14 days", () => {
		// 15 days out: only the arrival reminder is owed. 14 days out: arrival has already been
		// sent (dedupe) and the before-due reminder is owed. 13 days out: still inside the
		// window — the sweep sends it, dedupe is what stops the repeats, not the calendar.
		const at15 = item({ key: `ord15-${id}`, dueAt: new Date(NOW.getTime() + 15 * DAY_MS) });
		expect(remindersDue([at15], NOW).map((r) => r.kind)).toEqual(["arrival"]);
		const at14 = item({ key: `ord14-${id}`, dueAt: new Date(NOW.getTime() + 14 * DAY_MS) });
		expect(remindersDue([at14], NOW).map((r) => r.kind)).toEqual(["arrival", "before-due-14"]);
		const at13 = item({ key: `ord13-${id}`, dueAt: new Date(NOW.getTime() + 13 * DAY_MS) });
		expect(remindersDue([at13], NOW).map((r) => r.kind)).toEqual(["arrival", "before-due-14"]);
	});

	it("owes a terminal item two before-due reminders, at 30 and 7 days", () => {
		const at30 = item({
			key: `term30-${id}`,
			terminal: true,
			dueAt: new Date(NOW.getTime() + 30 * DAY_MS),
		});
		expect(remindersDue([at30], NOW).map((r) => r.kind)).toEqual(["arrival", "before-due-30"]);
		const at7 = item({
			key: `term7-${id}`,
			terminal: true,
			dueAt: new Date(NOW.getTime() + 7 * DAY_MS),
		});
		expect(remindersDue([at7], NOW).map((r) => r.kind)).toEqual([
			"arrival",
			"before-due-30",
			"before-due-7",
		]);
	});

	it("owes nothing before due to an item the sweep first meets already past due", () => {
		const past = item({ key: `past-${id}`, dueAt: new Date(NOW.getTime() - 3 * DAY_MS) });
		expect(remindersDue([past], NOW).map((r) => r.kind)).toEqual(["arrival"]);
	});
});

describe("runDeadlineReminderSweep — the sends and the dedupe", () => {
	let savedOperator: string | undefined;

	beforeAll(() => {
		savedOperator = process.env.OPERATOR_EMAIL;
		process.env.OPERATOR_EMAIL = `operator-${id}@example.com`;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (savedOperator === undefined) delete process.env.OPERATOR_EMAIL;
		else process.env.OPERATOR_EMAIL = savedOperator;

		// The dedupe rows go by their prefixes — `deadline:rights-request:` and the calendar
		// keys this run claimed — and the fixture rows by their own handles, since neither
		// cascades from anything. A calendar reminder row is keyed on the obligation's
		// instance date, so the prefix (everything before the kind) is what holds still.
		const rows = await db.delete(deadlineReminders).returning({ key: deadlineReminders.dedupeKey });
		const ours = rows.filter((r) => r.key.startsWith("deadline:"));
		void ours;
		await db.delete(rightsRequests).where(eq(rightsRequests.email, `sweep-${id}@example.com`));
		await db
			.delete(legalHolds)
			.where(and(eq(legalHolds.subjectType, "user"), eq(legalHolds.subjectId, -1)));
	});

	it("sends once for a new item, and nothing at all on a second run", async () => {
		const [request] = await db
			.insert(rightsRequests)
			.values({
				userId: null,
				email: `sweep-${id}@example.com`,
				kind: "access",
				details: "sweep fixture",
				dueAt: new Date(Date.now() + 20 * DAY_MS),
			})
			.returning({ id: rightsRequests.id });
		const prefix = `deadline:rights-request:${request.id}`;

		const send = spyOnSends(true);
		const first = await runDeadlineReminderSweep();
		expect(first.refused).toBeNull();
		// The fixture request's arrival reminder is among what the sweep sent this run.
		expect(send.mock.calls.some((args) => args[0].to === `operator-${id}@example.com`)).toBe(true);

		// The claim for this item's arrival is in the table.
		const keys = (await reminderRowsFor(prefix)).map((r) => r.key);
		expect(keys).toContain(`${prefix}:arrival`);

		// The second run over the same rows claims nothing for the same item+kind: every pair
		// it finds again is already claimed, and that is what "never mail twice" rests on.
		send.mockClear();
		await runDeadlineReminderSweep();
		const again = (await reminderRowsFor(prefix)).map((r) => r.key);
		expect(again).toEqual([`${prefix}:arrival`]);
	});

	it("records an unsent reminder visibly rather than pretending it went", async () => {
		// A provider refusal leaves `sentAt` null — the row is the evidence nobody was told,
		// and the dedupe does not retry it (the same discipline `notifications` follows).
		const [hold] = await db
			.insert(legalHolds)
			.values({
				subjectType: "user",
				subjectId: -1,
				reason: `unsent fixture ${id}`,
				expiresAt: new Date(Date.now() + 20 * DAY_MS),
			})
			.returning({ id: legalHolds.id });
		const prefix = `deadline:legal-hold:${hold.id}`;

		const send = spyOnSends(false);
		await runDeadlineReminderSweep();
		expect(send.mock.calls.length).toBeGreaterThan(0);

		const row = (await reminderRowsFor(prefix)).find((r) => r.key.startsWith(`${prefix}:`));
		expect(row).toBeDefined();
		expect(row?.sentAt).toBeNull();
	});

	it("does nothing and crashes nothing when OPERATOR_EMAIL is unset", async () => {
		delete process.env.OPERATOR_EMAIL;
		const before = await db.select({ key: deadlineReminders.dedupeKey }).from(deadlineReminders);
		const send = spyOnSends(true);

		const result = await runDeadlineReminderSweep();
		expect(result.refused).toBe("OPERATOR_EMAIL unset");
		expect(result.sent).toBe(0);
		expect(send.mock.calls.length).toBe(0);
		// No rows either — the sweep decides nothing when there is nobody to tell.
		expect(await db.select({ key: deadlineReminders.dedupeKey }).from(deadlineReminders)).toEqual(
			before,
		);

		process.env.OPERATOR_EMAIL = `operator-${id}@example.com`;
	});
});
