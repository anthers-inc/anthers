// SPDX-License-Identifier: Apache-2.0
/**
 * The Compliance Calendar transcribed and its recurrence math resolved — the Calendar's dated and
 * annual tables restated as assertions, one per obligation, plus a resolution of the recurring
 * ones at moments that make the boundaries real (the first instance, the year it recurs, a year
 * before the first, and each window's edges).
 *
 * 🚨 **The terminal flags are the load-bearing rows.** The Calendar's two-reminder rule names
 * exactly three obligations — the Periodic Report, the DMCA designation, the Form 990 — and a
 * fourth flag appearing here would silently grant or deny reminders to something whose miss does
 * or does not end the organization. The unconfirmed flag on HB26-1223 is the same kind of fact:
 * the Calendar marks its enrolled text unconfirmed, and a transcription that softened it would be
 * a different document from the one it cites.
 *
 * ⚠️ § Behavioral and § Running-not-yet-dated are deliberately absent from the assertion list:
 * a behavioral gate has no date until somebody acts, and a running clock's date does not exist
 * yet. Neither may be turned into a reminder, which is why they are not transcribed at all — and
 * the obligation-count assertion is what keeps a future edit from adding one.
 */
import { describe, expect, it } from "bun:test";
import {
	calendarDeadlines,
	COMPLIANCE_OBLIGATIONS,
	type ComplianceObligation,
	obligationInstanceIn,
	reminderLeadDays,
} from "./compliance-calendar.js";

function at(iso: string): Date {
	return new Date(iso);
}

function byId(id: string): ComplianceObligation {
	const row = COMPLIANCE_OBLIGATIONS.find((o) => o.id === id);
	if (!row) throw new Error(`no obligation ${id}`);
	return row;
}

describe("COMPLIANCE_OBLIGATIONS — the Calendar's dated and annual tables", () => {
	it("carries every dated and recurring row, and no behavioral or running one", () => {
		// Eight: five dated (HB26-1223, first 990, charity renewal, periodic report, 1023,
		// DMCA agent) plus the recurring-only rows (990-T, NCMEC review) — nothing from
		// § Behavioral, nothing from § Running, not even the sales-tax return cadence,
		// whose frequency does not exist until licensing assigns one.
		expect(COMPLIANCE_OBLIGATIONS.map((o) => o.id)).toEqual([
			"hb26-1223",
			"form-990",
			"charity-registration-renewal",
			"periodic-report",
			"form-990-t",
			"form-1023",
			"dmca-designated-agent",
			"ncmec-contact-review",
		]);
	});

	it("resolves every fixed date to the Calendar's absolute", () => {
		expect(obligationInstanceIn(byId("hb26-1223"), 2026).dueAt).toEqual(at("2027-01-01T00:00:00Z"));
		expect(obligationInstanceIn(byId("form-1023"), 2026).dueAt).toEqual(at("2028-11-30T00:00:00Z"));
		expect(obligationInstanceIn(byId("dmca-designated-agent"), 2026).dueAt).toEqual(
			at("2029-08-15T00:00:00Z"),
		);
		// A fixed date is the same in any year asked of it — there is no recurrence to compute.
		expect(obligationInstanceIn(byId("form-1023"), 2029).dueAt).toEqual(at("2028-11-30T00:00:00Z"));
	});

	it("resolves the first instances to the Calendar's absolutes", () => {
		expect(obligationInstanceIn(byId("form-990"), 2027).dueAt).toEqual(at("2027-05-15T00:00:00Z"));
		expect(obligationInstanceIn(byId("charity-registration-renewal"), 2027).dueAt).toEqual(
			at("2027-05-15T00:00:00Z"),
		);
		expect(obligationInstanceIn(byId("form-990-t"), 2027).dueAt).toEqual(at("2027-05-15T00:00:00Z"));
		// The window: June 1 opens it, October 31 closes it, and the deadline is the closing date.
		const window = obligationInstanceIn(byId("periodic-report"), 2027);
		expect(window.windowStart).toEqual(at("2027-06-01T00:00:00Z"));
		expect(window.dueAt).toEqual(at("2027-10-31T00:00:00Z"));
		// The NCMEC review counts from the 2026-08-27 registration, so its first anniversary is
		// 2027-08-27 — the Calendar's own arithmetic, not a generic "annually".
		expect(obligationInstanceIn(byId("ncmec-contact-review"), 2027).dueAt).toEqual(
			at("2027-08-27T00:00:00Z"),
		);
	});

	it("recurs on the calendar day, computed rather than stored", () => {
		expect(obligationInstanceIn(byId("form-990"), 2028).dueAt).toEqual(at("2028-05-15T00:00:00Z"));
		expect(obligationInstanceIn(byId("form-990"), 2031).dueAt).toEqual(at("2031-05-15T00:00:00Z"));
		expect(obligationInstanceIn(byId("periodic-report"), 2028).windowStart).toEqual(
			at("2028-06-01T00:00:00Z"),
		);
		expect(obligationInstanceIn(byId("periodic-report"), 2028).dueAt).toEqual(
			at("2028-10-31T00:00:00Z"),
		);
		expect(obligationInstanceIn(byId("ncmec-contact-review"), 2029).dueAt).toEqual(
			at("2029-08-27T00:00:00Z"),
		);
	});

	it("flags terminal exactly the three the Calendar names", () => {
		const terminal = COMPLIANCE_OBLIGATIONS.filter((o) => o.terminal).map((o) => o.id);
		expect(terminal).toEqual(["form-990", "periodic-report", "dmca-designated-agent"]);
	});

	it("carries the Calendar's own uncertainty marks", () => {
		expect(byId("hb26-1223").unconfirmed).toBe(true);
		expect(COMPLIANCE_OBLIGATIONS.filter((o) => o.unconfirmed).map((o) => o.id)).toEqual([
			"hb26-1223",
		]);
		expect(byId("ncmec-contact-review").selfImposed).toBe(true);
		expect(byId("form-990-t").condition).toBeTruthy();
	});

	it("states the two-reminder rule on terminal items and one lead otherwise", () => {
		expect(reminderLeadDays(byId("periodic-report"))).toEqual([30, 7]);
		expect(reminderLeadDays(byId("dmca-designated-agent"))).toEqual([30, 7]);
		expect(reminderLeadDays(byId("form-990"))).toEqual([30, 7]);
		for (const other of COMPLIANCE_OBLIGATIONS.filter((o) => !o.terminal)) {
			expect(reminderLeadDays(other)).toEqual([14]);
		}
	});
});

describe("calendarDeadlines — resolution around a moment", () => {
	it("before every first instance, contributes only the upcoming ones", () => {
		const rows = calendarDeadlines(at("2026-10-01T00:00:00Z"));
		expect(rows.length).toBe(8);
		expect(rows.find((r) => r.id === "hb26-1223")?.dueAt).toEqual(at("2027-01-01T00:00:00Z"));
		// The recurring rows have not started: their first instances are 2027's.
		expect(rows.find((r) => r.id === "form-990")?.dueAt).toEqual(at("2027-05-15T00:00:00Z"));
		expect(rows.find((r) => r.id === "ncmec-contact-review")?.dueAt).toEqual(
			at("2027-08-27T00:00:00Z"),
		);
	});

	it("carries a passed instance beside the next one, and never drops a fixed date", () => {
		// Mid-2027: HB26-1223 has passed and stays — a missed taxability change is still owed —
		// and the 2027 990 has passed with the 2028 one beside it.
		const rows = calendarDeadlines(at("2027-06-15T00:00:00Z"));
		const nines = rows.filter((r) => r.id === "form-990");
		// Upcoming first, passed beside it — a passed filing is still owed, but the live one
		// is the one the reader came for.
		expect(nines.map((r) => r.instance)).toEqual(["2028-05-15", "2027-05-15"]);
		expect(rows.some((r) => r.id === "hb26-1223")).toBe(true);
		// The periodic report window is open: the passed-instances rule does not apply to a
		// window until its closing date passes.
		const periodic = rows.find((r) => r.id === "periodic-report");
		expect(periodic?.dueAt).toEqual(at("2027-10-31T00:00:00Z"));
	});

	it("names each instance, so next year's deadline is a different item", () => {
		const rows = calendarDeadlines(at("2027-06-15T00:00:00Z"));
		expect(new Set(rows.map((r) => `${r.id}:${r.instance}`)).size).toBe(rows.length);
	});
});