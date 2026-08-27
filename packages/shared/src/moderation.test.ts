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
	MODERATION_REASON_GROUPS,
	MODERATION_REASON_VALUES,
	MODERATION_REASONS,
	MODERATION_STATUSES,
	MODERATION_SUBJECT_TYPES,
	moderationReasonLabel,
	reasonsInGroup,
	reportRequiresDetails,
} from "./moderation.js";

describe("Report taxonomy", () => {
	it("pins the stored reason codes — renaming one is a data migration", () => {
		expect([...MODERATION_REASON_VALUES]).toEqual([
			"csam",
			"violence",
			"illegal",
			"pornography",
			"unrated-mature",
			"harassment",
			"spam",
			"other",
		]);
	});

	it("orders the legal group first, and orders each group most serious first", () => {
		// 🚨 One of the three mitigations that make splitting the old single sexual reason
		// safe: a reporter who has something involving a minor meets the legal option before
		// the rule-break. The others are the pornography hint and its confirmation, below.
		expect(MODERATION_REASON_GROUPS.map((g) => g.key)).toEqual(["law", "rules"]);
		expect(reasonsInGroup("law").map((r) => r.value)).toEqual(["csam", "violence", "illegal"]);
		expect(reasonsInGroup("rules").map((r) => r.value)).toEqual([
			"pornography",
			"unrated-mature",
			"harassment",
			"spam",
			"other",
		]);
	});

	it("puts a confirmation on the pornography reason, and it switches rather than warns", () => {
		// A warning a reporter can read and ignore leaves the misfiled report filed. The
		// control has to move them, which means the reason has to name where to.
		const porn = MODERATION_REASONS.find((r) => r.value === "pornography");
		expect(porn?.confirm?.switchTo).toBe("csam");
		expect(porn?.confirm?.question).toContain("18");
	});

	it("never names queer lives anywhere in the taxonomy", () => {
		// 🚨 An early draft of the pornography hint listed "queer lives" as an example of
		// mature work, which asserts precisely the premise wiki 40.13 exists to refuse. The
		// refusal belongs on /safety at a length that makes it a refusal, and nowhere
		// shorter — anything that fits beside a radio button reads as the concession.
		const copy = MODERATION_REASONS.map((r) => `${r.label} ${r.hint}`)
			.join(" ")
			.toLowerCase();
		expect(copy).not.toContain("queer");
		expect(copy).not.toContain("lgbt");
		expect(copy).not.toContain("trans ");
	});

	it("keeps a retired code readable without letting anything file a new one", () => {
		// `moderation_reports.reason` holds `sexual` verbatim on rows written while it was
		// the code the form steered a child-safety reporter toward. An operator opening one
		// has to see what the reporter picked; nothing may write another.
		expect(moderationReasonLabel("sexual")).toBe("Sexual content");
		expect(isModerationReason("sexual")).toBe(false);
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
		// A comment IS the evidence; a person is not. That asymmetry is why adding people
		// did NOT need a reason of their own — the taxonomy fits, and what doesn't
		// transfer is the subject implying its own evidence. A Work is its own evidence
		// the way a comment is — the operator opens it and sees what the reporter saw.
		expect(reportRequiresDetails("user")).toBe(true);
		expect(reportRequiresDetails("comment")).toBe(false);
		expect(reportRequiresDetails("rating")).toBe(false);
		expect(reportRequiresDetails("work")).toBe(false);
		// Adding a person and a Work did not touch the taxonomy — pinned here because
		// "the reasons don't fit a person" is the reasonable-sounding change that would
		// make renaming a stored value look like a copy edit. The count is asserted by
		// the exact-list test above; what this one says is that nothing here moved it.
		expect(MODERATION_REASON_VALUES).not.toContain("person");
	});
});
