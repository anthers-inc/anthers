// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The moderation vocabulary, pinned.
 *
 * Two things here are load-bearing in a way the type system can't express:
 *
 * 1. **The reason codes are STORED VALUES.** `moderation_reports.reason` and
 *    `moderation_actions.reason` hold these strings verbatim, so renaming one
 *    orphans every row already carrying it — a rename is a data migration, not
 *    a copy edit. Labels are free to change; the exact-set assertion below is
 *    what makes the difference visible when someone edits this list.
 *
 * 2. **There is no terminal status.** `ModerationStatus` is deliberately just
 *    visible/hidden, because "removal is a state transition, never a delete" is
 *    the constraint that keeps appeals, creator-side tools and labelers as later
 *    features rather than later migrations. A `deleted` value would be that
 *    constraint quietly dying in a type alias.
 */
import { describe, expect, it } from "bun:test";
import {
	isModeratableContent,
	isModerationReason,
	isModerationSubjectType,
	MODERATION_REASON_VALUES,
	MODERATION_REASONS,
	MODERATION_STATUSES,
	MODERATION_SUBJECT_TYPES,
	moderationReasonLabel,
	reportRequiresDetails,
} from "./moderation.js";

describe("Report taxonomy", () => {
	it("pins the stored reason codes — renaming one is a data migration", () => {
		expect([...MODERATION_REASON_VALUES]).toEqual([
			"spam",
			"harassment",
			"sexual",
			"violence",
			"illegal",
			"other",
		]);
	});

	it("keeps codes unique, so two reasons can't collapse into one stored value", () => {
		expect(new Set(MODERATION_REASON_VALUES).size).toBe(MODERATION_REASONS.length);
	});

	it("gives every reason a label and a hint a reporter can act on", () => {
		for (const reason of MODERATION_REASONS) {
			expect(reason.label.length).toBeGreaterThan(0);
			expect(reason.hint.length).toBeGreaterThan(0);
		}
	});

	it("keeps `other` last — it's the catch-all, not a peer", () => {
		expect(MODERATION_REASON_VALUES.at(-1)).toBe("other");
	});

	it("validates membership rather than accepting any string", () => {
		expect(isModerationReason("spam")).toBe(true);
		expect(isModerationReason("misinformation")).toBe(false);
		expect(isModerationReason("")).toBe(false);
	});

	it("labels a known code and falls back to the code itself for an unknown one", () => {
		expect(moderationReasonLabel("spam")).toBe("Spam or advertising");
		// Forward compatibility: a client on an older bundle renders a code it has
		// never heard of as the code, not as blank.
		expect(moderationReasonLabel("future-reason")).toBe("future-reason");
	});
});

describe("Moderation states", () => {
	it("has exactly two states, and neither of them means deleted", () => {
		expect([...MODERATION_STATUSES]).toEqual(["visible", "hidden"]);
		expect(MODERATION_STATUSES).not.toContain("deleted");
		expect(MODERATION_STATUSES).not.toContain("removed");
	});
});

describe("Subject types", () => {
	it("covers the two user-generated row types plus a person and a Work, and validates membership", () => {
		expect([...MODERATION_SUBJECT_TYPES]).toEqual(["comment", "rating", "user", "work"]);
		expect(isModerationSubjectType("comment")).toBe(true);
		expect(isModerationSubjectType("user")).toBe(true);
		expect(isModerationSubjectType("work")).toBe(true);
		expect(isModerationSubjectType("post")).toBe(false);
	});

	it("says a person is reportable but NOT hideable, and a Work is reportable but NOT hideable through the moderation path", () => {
		// The distinction is the whole reason `user` could be added as a value rather
		// than as a new table: it goes through the same report path, and stops short of
		// the same action path. Hiding an account is suspension, which has to answer what
		// becomes of their Works, their buyers' purchases, the support pointed at them and
		// any payout in flight — none of it decided.
		//
		// `work` follows the same shape for a different reason: a Work takedown is a DMCA
		// action with its own service (`services/dmca.ts`), its own table (`dmca_notices`),
		// and its own state column (`works.takedown_status`) — NOT a moderation hide. A
		// Work can be reported through the moderation queue, and a DMCA notice is a
		// separate intake; `isModeratableContent` keeps the moderation hide/restore path
		// from accepting a Work it can't handle.
		expect(isModeratableContent("comment")).toBe(true);
		expect(isModeratableContent("rating")).toBe(true);
		expect(isModeratableContent("user")).toBe(false);
		expect(isModeratableContent("work")).toBe(false);
	});

	it("requires the reporter's own words for a person, and not for content or a Work", () => {
		// A comment IS the evidence; a person is not. That asymmetry is why the six
		// reasons did NOT need a seventh entry for people — the taxonomy fits, and what
		// doesn't transfer is the subject implying its own evidence. A Work is its own
		// evidence the way a comment is — the operator opens it and sees what the
		// reporter saw.
		expect(reportRequiresDetails("user")).toBe(true);
		expect(reportRequiresDetails("comment")).toBe(false);
		expect(reportRequiresDetails("rating")).toBe(false);
		expect(reportRequiresDetails("work")).toBe(false);
		// Adding a person and a Work did not touch the taxonomy — pinned here because
		// "the reasons don't fit a person" is the reasonable-sounding change that would
		// make renaming a stored value look like a copy edit.
		expect(MODERATION_REASON_VALUES.length).toBe(6);
	});
});
