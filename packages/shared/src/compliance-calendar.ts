// SPDX-License-Identifier: Apache-2.0
/**
 * The Compliance Calendar's dated obligations — the transcription of `13 - Compliance Calendar`
 * (Anthers-Wiki, `Internal Wiki/10-19 Governance & Records/13 - Compliance Calendar`, § Dated and
 * § Then annually), and the place a date is added.
 *
 * Pure (no clock reads, no I/O — `now` is always a parameter), like `sales-tax-thresholds.ts` and
 * `content-rating.ts`, so the API, the worker and the admin app read the same calendar rather than
 * each carrying a copy of a markdown file. The Calendar owns the dates; this module owns nothing of
 * its own.
 *
 * **Recompute, don't edit — the Calendar's own rule, restated where the code lives.** Every date
 * below is downstream of a source fact the Calendar names (formation 2026-08-07, fiscal year end
 * December 31, DMCA registration 2026-08-15, NCMEC registration 2026-08-27). A date that looks wrong
 * means a source fact changed: fix it in the Calendar and this transcription together, never either
 * alone — editing the transcription without the Calendar is how two documents end up disagreeing
 * about when a filing is due.
 *
 * **What is transcribed, and what deliberately is not:**
 *
 * - § Dated — every row, including HB26-1223's ⚠️ unconfirmed enrolled text, transcribed with the
 *   same flag rather than softened: a warning is only worth carrying if it survives transcription.
 * - § Then annually — the recurring cadences as recurrence rules computed at read time, so the
 *   module never holds a stale year.
 * - § Behavioral — NOT transcribed. Those are gates on an action, checked at the act; a reminder
 *   would misrepresent them by attaching a date to something that has none until somebody acts.
 * - § Running, not yet dated — NOT transcribed. No date exists to compute. This includes the sales
 *   tax return cadence, which is "the frequency the Department of Revenue assigns at licensing" —
 *   no license, no frequency, so there is nothing to resolve until licensing assigns one.
 *
 * **Terminal misses, exactly the three the Calendar names** (§ Rules that keep this honest): the
 * Colorado Periodic Report (administrative dissolution), the DMCA designated agent (§ 512(c) safe
 * harbor), and the Form 990 (automatic revocation on the third consecutive miss). The Calendar says
 * one channel is not redundancy and that the genuinely independent leg is the SOS and Copyright
 * Office's own notification emails — so anything built on this transcription is **one leg, not the
 * redundancy**, and its copy must say so rather than claim to be the second reminder.
 */

/** How an obligation repeats. Resolved at read time by `calendarDeadlines`, never stored as a year. */
export type CalendarRecurrence =
	| { kind: "fixed"; date: string }
	| { kind: "annual"; first: string; month: number; day: number }
	| {
			kind: "annual-window";
			first: string;
			startMonth: number;
			startDay: number;
			endMonth: number;
			endDay: number;
	  };

/** One dated obligation, transcribed from the Calendar's tables. */
export interface ComplianceObligation {
	/** Stable machine id, used in dedupe keys — never renamed once anything stores it. */
	id: string;
	/** What is owed, as the Calendar words the obligation. */
	title: string;
	/**
	 * What missing it costs, in the Calendar's own words — plain and not softened, because the
	 * Calendar is the document a person reads when a reminder fires in 2029 and asks them to do
	 * something they no longer remember agreeing to.
	 */
	consequence: string;
	/** The Calendar's two-reminder rule applies to exactly the three terminal misses. */
	terminal: boolean;
	/** The Calendar marks HB26-1223's enrolled text unconfirmed; the flag survives transcription. */
	unconfirmed?: boolean;
	/** The Calendar marks the NCMEC contact review self-imposed rather than statutory. */
	selfImposed?: boolean;
	/** A check to make rather than a date to assert — the 990-T's "only if there is unrelated business income". */
	condition?: string;
	/** The Calendar's own note where the row carries one beyond the consequence. */
	note?: string;
	recurrence: CalendarRecurrence;
}

/** Midnight UTC on the calendar date `YYYY-MM-DD`, the only timezone these dates exist in. */
function utcDate(iso: string): Date {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, d));
}

/** Midnight UTC on `month`/`day` of `year` (1-based month), matching the Calendar's absolute dates. */
function utc(year: number, month: number, day: number): Date {
	return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Every dated and recurring obligation the Calendar carries.
 *
 * Read a row, do not restatiate it: the whole point of this module is that the endpoint, the worker
 * and the admin home render the transcription rather than each carrying a copy.
 */
export const COMPLIANCE_OBLIGATIONS: readonly ComplianceObligation[] = [
	{
		id: "hb26-1223",
		title: "HB26-1223 ends Colorado's downloadable-software sales-tax exemption",
		consequence:
			"Collecting the wrong tax on every digital sale from that day, in the one area where the audit shield protects nothing.",
		terminal: false,
		// ⚠️ The Calendar marks this row's enrolled text unconfirmed, and this transcription does not
		// soften it: the date is real enough to watch and the uncertainty is real enough to carry.
		unconfirmed: true,
		note: "A taxability change aimed at a game-download marketplace, not a filing.",
		recurrence: { kind: "fixed", date: "2027-01-01" },
	},
	{
		id: "form-990",
		title: "Form 990 for the short year 2026-08-07 → 2026-12-31",
		consequence:
			"Three consecutive misses is automatic revocation of exempt status under IRC § 6033(j) — no notice, no hearing.",
		terminal: true,
		note: "Owed even while the Form 1023 is pending. Which form applies turns on the flow-through reading of gross receipts.",
		// The 15th day of the 5th month after a December 31 fiscal year end — May 15. First instance
		// is the short year's return, due 2027-05-15.
		recurrence: { kind: "annual", first: "2027-05-15", month: 5, day: 15 },
	},
	{
		id: "charity-registration-renewal",
		title: "Colorado charity registration renewal",
		consequence: "A $60 fine, and suspension of solicitation authority.",
		terminal: false,
		note: "An automatic 3-month extension is available, and a second on request. Same day as the 990 — the single-date coincidence is the reason December 31 was chosen.",
		condition: "Only if the charity registration has been filed by then.",
		recurrence: { kind: "annual", first: "2027-05-15", month: 5, day: 15 },
	},
	{
		id: "periodic-report",
		title: "Colorado Periodic Report",
		consequence:
			"A $50 late fee, then noncompliant, then delinquent at 90 days, then administrative dissolution and loss of the name.",
		terminal: true,
		note: "A five-month window, not a deadline: the anniversary month is August, opening two months before and closing two months after.",
		// June 1 → October 31 each year; the first instance is the 2027 window.
		recurrence: {
			kind: "annual-window",
			first: "2027-06-01",
			startMonth: 6,
			startDay: 1,
			endMonth: 10,
			endDay: 31,
		},
	},
	{
		id: "form-990-t",
		title: "Form 990-T",
		consequence:
			"Real corporate tax if the storefront is unrelated business income — not hypothetical.",
		terminal: false,
		condition:
			"Only if there is unrelated business income — a flag to check rather than a date to assert.",
		recurrence: { kind: "annual", first: "2027-05-15", month: 5, day: 15 },
	},
	{
		id: "form-1023",
		title: "Form 1023 — the full 1023, not the EZ",
		consequence:
			"Exemption runs from the submission date instead of 2026-08-07: Form 1120 exposure for the gap, non-deductible donations, no retroactive donor benefit.",
		terminal: false,
		note: "27 months after the end of the month of formation.",
		recurrence: { kind: "fixed", date: "2028-11-30" },
	},
	{
		id: "dmca-designated-agent",
		title: "DMCA designated agent designation expires (Copyright Office DMCA-1078418)",
		consequence:
			"An expired designation is an invalid one. § 512(c) safe harbor lapses from that moment — not reduced, gone — for a platform whose entire content model is user uploads.",
		terminal: true,
		note: "Three years from registration unless amended or resubmitted first. The Copyright Office sends courtesy reminders at 90, 60, 30 and 7 days to whatever address was on the registration, and that kind of mail gets filtered — which is the Calendar's reason a second leg must be genuinely independent.",
		recurrence: { kind: "fixed", date: "2029-08-15" },
	},
	{
		id: "ncmec-contact-review",
		title: "Re-confirm the NCMEC ESP contact details",
		consequence:
			"§ 2258A(a) makes the mailing address, phone, email and named individual part of the duty, so keeping them accurate is required while the review itself is ours to schedule. The thing most likely to go stale is the named human.",
		terminal: false,
		// ⚠️ Self-imposed rather than statutory, in the Calendar's own words — a flag the reader needs
		// before deciding how much weight to give a reminder about it.
		selfImposed: true,
		recurrence: { kind: "annual", first: "2027-08-27", month: 8, day: 27 },
	},
];

/**
 * One obligation's instance in a given year, resolved for tests and for the recurrence math —
 * callers at read time use `calendarDeadlines` instead.
 *
 * A window's `dueAt` is its closing date: the window is when the filing may be made, and the
 * deadline is the day it stops being makable.
 */
export function obligationInstanceIn(
	obligation: ComplianceObligation,
	year: number,
): { dueAt: Date; windowStart: Date | null } {
	switch (obligation.recurrence.kind) {
		case "fixed":
			return { dueAt: utcDate(obligation.recurrence.date), windowStart: null };
		case "annual": {
			const { month, day } = obligation.recurrence;
			return { dueAt: utc(year, month, day), windowStart: null };
		}
		case "annual-window": {
			const r = obligation.recurrence;
			return {
				windowStart: utc(year, r.startMonth, r.startDay),
				dueAt: utc(year, r.endMonth, r.endDay),
			};
		}
	}
}

/**
 * Every deadline the Calendar holds, resolved around `now`.
 *
 * Each obligation contributes the instance that is still upcoming, and — once an instance has
 * passed — the most recent passed one beside it. A passed instance is not dropped: nothing in this
 * module knows whether the filing was made, and a missed obligation stays owed until it is, which
 * is exactly what the Calendar's dissolution-and-revocation consequences describe. A fixed date
 * contributes itself for ever, for the same reason.
 *
 * Nothing is filtered by horizon; the caller decides how far out is worth showing.
 */
export function calendarDeadlines(now: Date): CalendarDeadline[] {
	const out: CalendarDeadline[] = [];
	for (const obligation of COMPLIANCE_OBLIGATIONS) {
		if (obligation.recurrence.kind === "fixed") {
			out.push(deadlineOf(obligation, obligationInstanceIn(obligation, 0)));
			continue;
		}
		const firstYear = Number(obligation.recurrence.first.slice(0, 4));
		const year = now.getUTCFullYear();
		// The nearest upcoming instance. A row's `first` is the first year it ever recurs —
		// asking for "the 2026 instance" of something that starts in 2027 would invent a
		// deadline the Calendar does not carry, so years before the first are skipped.
		for (const y of [year, year + 1]) {
			if (y < firstYear) continue;
			const instance = obligationInstanceIn(obligation, y);
			if (instance.dueAt > now) {
				out.push(deadlineOf(obligation, instance));
				break;
			}
		}
		// The most recent instance that has passed, when there is one: the missed obligation
		// that is still owed.
		for (const y of [year, year - 1]) {
			if (y < firstYear) continue;
			const instance = obligationInstanceIn(obligation, y);
			if (instance.dueAt <= now) {
				out.push(deadlineOf(obligation, instance));
				break;
			}
		}
	}
	return out;
}

/** A resolved deadline: the obligation plus the dates that instance resolves to. */
export interface CalendarDeadline extends ComplianceObligation {
	/** The date the obligation is due — a window's closing date. */
	dueAt: Date;
	/** The date a window opens, or null where there is no window. */
	windowStart: Date | null;
	/**
	 * Names the instance in dedupe keys — next year's instance is a new deadline with its own
	 * reminders, and this is what keeps the two apart.
	 */
	instance: string;
}

function deadlineOf(
	obligation: ComplianceObligation,
	instance: { dueAt: Date; windowStart: Date | null },
): CalendarDeadline {
	const iso = instance.dueAt.toISOString().slice(0, 10);
	return { ...obligation, dueAt: instance.dueAt, windowStart: instance.windowStart, instance: iso };
}

/**
 * The Calendar's two-reminder rule, as data: how many days before `dueAt` each before-due
 * reminder fires. Terminal items get two (the Calendar names exactly three, and their misses end
 * in dissolution, lost safe harbor or revocation); everything else gets one.
 *
 * ⚠️ This module states the rule's shape, and the worker states the actual lead times — they are
 * a delivery decision rather than a Calendar fact, so they live where the sending happens.
 */
export function reminderLeadDays(obligation: { terminal: boolean }): number[] {
	return obligation.terminal ? [30, 7] : [14];
}
