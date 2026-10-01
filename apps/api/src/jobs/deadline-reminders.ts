// SPDX-License-Identifier: Apache-2.0
/**
 * The deadline reminder sweep — the worker half of the 2026-09-14 decision that anything with a
 * deadline reaches the operator by email and is acted on in the admin app.
 *
 * Runs daily. That is enough because the nearest deadline is days out, not hours: every source in
 * `gatherDeadlines` carries a window measured in days (a 30-day rights request, a 10-business-day
 * counter-notice window, a calendar of filings months apart), so a sweep that runs once a day
 * delivers each reminder within a day of the moment it becomes due — which is inside every
 * window's tolerance by a wide margin. The one deadline that is genuinely minute-scoped, a
 * floor-level abuse report, has its own five-minute cron and its own refusal discipline.
 *
 * **Two reminder kinds, per the decision:**
 *
 * - **arrival** — a deadline item appearing. For database sources that is the first sweep after
 *   the row is created (which, on a daily sweep, is "when a row with a future due date is created"
 *   to within a day). For calendar items it is the first sweep inside the arrival horizon below.
 * - **before due** — a lead time ahead of the due date.
 *
 * **The lead times, stated as the decisions they are:**
 *
 * - **Ordinary items: 14 days before due.** Two weeks is enough to do a filing in without paying
 *   a rush, and short enough that the reminder names a thing that is about to matter rather than
 *   something to file away and forget.
 * - **Terminal items: 30 and 7 days before due** — the Calendar's two-reminder rule, applied to
 *   exactly the three obligations whose miss ends in administrative dissolution, lost safe harbor
 *   or automatic revocation. Two leads rather than one because a single reminder 30 days out can
 *   be acted on "later" until it cannot; the 7-day one is the floor.
 * - **Calendar arrival: 45 days before due.** A calendar deadline cannot "arrive" — it has always
 *   existed — so its arrival reminder is the first sweep inside a horizon chosen to sit *before*
 *   the longest before-due lead, so an arrival email and a before-due email never land on the
 *   same day.
 *
 * **Dedupe is load-bearing.** The sweep re-evaluates the same rows every day, and the decision
 * asks for an email when an item arrives and before it is due — not every day in between. Each
 * (item, kind) pair is claimed with an insert into `deadline_reminders` guarded by the unique
 * `dedupeKey` (`ON CONFLICT DO NOTHING`), so a second sweep for the same pair inserts nothing and
 * sends nothing, and a reminder can never be mailed twice however often the sweep runs or
 * retries. The row is written before the email goes out, so the failure direction is a lost
 * reminder that stays visible (`sent_at` null) rather than a duplicate one.
 *
 * ⚠️ **`OPERATOR_EMAIL` unset: the job logs and does nothing.** No address is guessed and no
 * default is assumed, for the same reason `sendOperationalAlert` refuses without
 * `OPS_ALERT_EMAIL`: a reminder delivered to a guessed mailbox is indistinguishable from no
 * reminder at all. The refusal is logged once per sweep, not once per item, so a misconfigured
 * deployment does not write a wall of identical warnings into the log somebody has to read.
 */

import { db } from "@anthers/db/client";
import { deadlineReminders } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import {
	DEFERRED_DEADLINE_SOURCES,
	type DeadlineItem,
	gatherDeadlines,
	longDeadlineDate,
} from "../services/deadlines.js";
import { escapeHtml, sendDeadlineReminderEmail, terminalSecondLegLine } from "../services/email.js";

/** The lead days per kind, as the module docblock states them. */
export const ARRIVAL_HORIZON_DAYS = 45;
export const ORDINARY_LEAD_DAYS = 14;
export const TERMINAL_LEAD_DAYS = [30, 7] as const;

const DAY_MS = 86_400_000;

/**
 * The before-due leads an item's reminders run at. Terminal items get the Calendar's two; every
 * other item gets one. Database sources are never terminal (a terminal miss is a Calendar
 * concept — dissolution, lost safe harbor, revocation), so this collapses to 14 days for all
 * three of them.
 */
function leadsFor(item: DeadlineItem): number[] {
	return item.terminal ? [...TERMINAL_LEAD_DAYS] : [ORDINARY_LEAD_DAYS];
}

/**
 * The (item, kind) pairs this sweep owes a reminder for.
 *
 * Pure — the caller (`runDeadlineReminderSweep`) sends and records; this decides. Exported for
 * the tests, which assert the decisions rather than the sends.
 */
export function remindersDue(
	items: DeadlineItem[],
	now: Date,
): { item: DeadlineItem; kind: string }[] {
	const out: { item: DeadlineItem; kind: string }[] = [];
	for (const item of items) {
		const dueAt = item.dueAt.getTime();

		// Arrival: database items arrive when the row is created, which a daily sweep sees as
		// "the first sweep that finds it" — no horizon at all, because the row did not exist
		// yesterday. Calendar items arrive inside the arrival horizon, so a filing two years out
		// does not announce itself the day the module is deployed.
		const arrivalHorizon = item.source === "compliance-calendar" ? ARRIVAL_HORIZON_DAYS : Infinity;
		if (now.getTime() >= dueAt - arrivalHorizon * DAY_MS) {
			out.push({ item, kind: "arrival" });
		}

		// Before due: inside the lead window, and only before it — an item the sweep first meets
		// already past due owes no before-due reminder, because the thing it reminded about has
		// happened and the admin home carries it as past due from then on.
		for (const lead of leadsFor(item)) {
			if (now.getTime() >= dueAt - lead * DAY_MS && now.getTime() < dueAt) {
				out.push({ item, kind: `before-due-${lead}` });
			}
		}
	}
	return out;
}

/** A dedupe key, stable for one (item, kind) for ever: the schema comment carries the shape. */
function dedupeKeyFor(item: DeadlineItem, kind: string): string {
	return `deadline:${item.key}:${kind}`;
}

/** The email's subject: names the item and its date, because a subject line is what gets read. */
function subjectFor(item: DeadlineItem): string {
	const date = longDeadlineDate(item.dueAt);
	return `Deadline: ${item.title} — ${date}`;
}

/**
 * Build one reminder's email body. Prose is sentence case; the consequence is the source
 * document's own words, plain and not softened; terminal items state the Calendar's rule about
 * the genuinely independent leg.
 */
function emailBodyFor(item: DeadlineItem, kind: string, now: Date): string {
	const due = longDeadlineDate(item.dueAt);
	const lines: string[] = [];

	if (kind === "arrival") {
		lines.push(
			`<p style="margin:0 0 18px;">A new deadline is on the calendar: <strong>${escapeHtml(item.title)}</strong>.</p>`,
		);
	} else {
		const days = Math.ceil((item.dueAt.getTime() - now.getTime()) / DAY_MS);
		lines.push(
			`<p style="margin:0 0 18px;">A deadline is coming due in ${days} day${days === 1 ? "" : "s"}: <strong>${escapeHtml(item.title)}</strong>.</p>`,
		);
	}

	if (item.windowStart) {
		lines.push(
			`<p style="margin:0 0 18px;">The window for it is open from ${longDeadlineDate(item.windowStart)} until <strong>${due}</strong>.</p>`,
		);
	} else {
		lines.push(`<p style="margin:0 0 18px;">It is due on <strong>${due}</strong>.</p>`);
	}

	lines.push(`<p style="margin:0 0 18px;">If it is missed: ${escapeHtml(item.consequence)}</p>`);

	if (item.condition) {
		lines.push(`<p style="margin:0 0 18px;">${escapeHtml(item.condition)}</p>`);
	}
	if (item.unconfirmed) {
		lines.push(
			'<p style="margin:0 0 18px;">⚠️ The source calendar marks this date\'s underlying text as unconfirmed. Verify it before relying on it.</p>',
		);
	}
	if (item.selfImposed) {
		lines.push(
			'<p style="margin:0 0 18px;">This review is self-imposed rather than statutory — required to keep accurate, ours to schedule.</p>',
		);
	}
	if (item.note) {
		lines.push(`<p style="margin:0 0 18px;">${escapeHtml(item.note)}</p>`);
	}

	// Where to act. An honest absent rather than an invented route: a calendar filing has no
	// admin screen yet, and the email says so rather than pointing at nothing.
	const adminUrl = process.env.ADMIN_URL?.trim().replace(/\/+$/, "");
	if (item.actUrl && adminUrl) {
		lines.push(
			`<p style="margin:0 0 22px;"><a href="${escapeHtml(adminUrl + item.actUrl)}" style="color:#7c3aed;">Open it in the admin app</a> to act on it.</p>`,
		);
	} else if (item.actUrl) {
		lines.push(
			`<p style="margin:0 0 22px;">To act on it, open ${escapeHtml(item.actUrl)} in the admin app.</p>`,
		);
	} else {
		lines.push(
			'<p style="margin:0 0 22px;">There is no admin screen for this yet — it is handled wherever the filing itself is made. The admin home lists it beside everything else with a due date.</p>',
		);
	}

	if (item.terminal) {
		lines.push(
			`<p style="margin:0 0 18px;color:#8f8ba0;font-size:13px;">${terminalSecondLegLine()}</p>`,
		);
	}

	lines.push(
		'<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">This is one of at most three reminders for this deadline — when it arrives, and before it is due. The admin home lists everything with a due date.</p>',
	);
	return lines.join("\n");
}

/**
 * One daily sweep: gather every deadline, send each reminder that is due and has never been sent,
 * and record each send in `deadline_reminders`.
 *
 * Returns what it did, so the worker's log line and the tests can both assert on the same facts.
 */
export async function runDeadlineReminderSweep(now: Date = new Date()): Promise<{
	sent: number;
	skipped: number;
	refused: string | null;
}> {
	const to = process.env.OPERATOR_EMAIL?.trim();
	if (!to) {
		// One refusal line per sweep, not per item: the log somebody reads to find out why nobody
		// was told needs the reason once, not a hundred times.
		console.warn(
			"[deadline-reminders] OPERATOR_EMAIL is unset — nobody was told about any deadline. Set it.",
		);
		return { sent: 0, skipped: 0, refused: "OPERATOR_EMAIL unset" };
	}

	const items = await gatherDeadlines(now);
	const due = remindersDue(items, now);

	let sent = 0;
	let skipped = 0;
	for (const { item, kind } of due) {
		// Claim the (item, kind) pair first: the unique key is what makes a repeated sweep
		// harmless, and claiming before sending fails toward a visible lost reminder
		// (`sent_at` null) rather than a duplicate email.
		const [claimed] = await db
			.insert(deadlineReminders)
			.values({
				dedupeKey: dedupeKeyFor(item, kind),
				source: item.source,
				title: item.title,
				kind,
				recipient: to,
			})
			.onConflictDoNothing({ target: deadlineReminders.dedupeKey })
			.returning({ id: deadlineReminders.id });
		if (!claimed) {
			skipped++;
			continue;
		}

		const { sent: went } = await sendDeadlineReminderEmail({
			to,
			subject: subjectFor(item),
			html: emailBodyFor(item, kind, now),
		});
		if (went) {
			sent++;
			await db
				.update(deadlineReminders)
				.set({ sentAt: now })
				.where(eq(deadlineReminders.id, claimed.id));
		} else {
			// The row stays with `sentAt` null — visible evidence that the reminder was decided
			// on and never reached anybody, rather than a silent gap.
			console.error(
				`[deadline-reminders] reminder for ${item.key} (${kind}) was not accepted by the provider — it stays recorded as unsent.`,
			);
		}
	}

	// The deferred sources are restated in the module docblock; the sweep does not remind about
	// them because they have no dates yet, and does not need to say so on every run.
	void DEFERRED_DEADLINE_SOURCES;

	return { sent, skipped, refused: null };
}
