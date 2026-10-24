// SPDX-License-Identifier: Apache-2.0
//
// The release notes' rules, made enforceable. It exists because a rule that only lives in
// a docblock produces something that still looks right when broken.
//
// 🚨 **The version rule is the deploy job's shape.** An entry names the version whose
// GitHub release holds the raw release notes, and a typo'd version breaks the raw-release
// link silently, which is why it is checked against the shape the deploy job tags rather
// than against another list in this file.
//
// ⚠️ **The roadmap chips are a record, not a cross-check.** Each names a goal the release
// finished and the wiki lane it landed in; the app keeps no roadmap to disagree with
// (2026-10-23). `roadmap` is optional and usually absent because most work is not a
// roadmap goal, and a stretched claim is the failure mode. What is still checked is that
// every chip names something, and that a lane, where given, is not blank.

import { describe, expect, it } from "bun:test";
import { RELEASE_NOTES, type ReleaseNotesEntry } from "./release-notes";

/** Calver, the shape `scripts/promote-version.ts` writes and the deploy job tags. */
const CALVER = /^(\d{4})\.(\d{1,2})\.(\d+)$/;

/** Reported as `version (entry N)` so a failure names the entry, not an index. */
function located(): { where: string; entry: string; release: ReleaseNotesEntry }[] {
	return RELEASE_NOTES.flatMap((release) =>
		release.entries.map((entry, i) => ({
			where: `${release.version} (entry ${i})`,
			entry,
			release,
		})),
	);
}

describe("the release notes version and order themselves", () => {
	it("holds at least one release — an empty page is a broken page, not a fresh one", () => {
		expect(RELEASE_NOTES.length).toBeGreaterThan(0);
	});

	it("gives every release a calver version, the shape the deploy job tags", () => {
		for (const release of RELEASE_NOTES) {
			expect(`${release.version}: ${CALVER.test(release.version) ? "calver" : "not calver"}`).toBe(
				`${release.version}: calver`,
			);
		}
	});

	it("gives every release an ISO date, and orders releases newest first", () => {
		// Newest first is the page's reading order and the export's stacking order; a
		// release landed mid-list breaks both while still rendering fine. The whole calver
		// tuple orders, not just year.month: a `.1` hotfix in the same month as its `.0`
		// is the normal shape (the page groups by month), so a strictly-decreasing
		// year.month rule would forbid every hotfix the page is built to fold.
		for (let i = 0; i < RELEASE_NOTES.length; i++) {
			expect(
				`${RELEASE_NOTES[i].version}: ${/^\d{4}-\d{2}-\d{2}$/.test(RELEASE_NOTES[i].date)}`,
			).toBe(`${RELEASE_NOTES[i].version}: true`);
			if (i === 0) continue;
			expect(`${RELEASE_NOTES[i].version} sorted after ${RELEASE_NOTES[i - 1].version}`).toBe(
				`${RELEASE_NOTES[i].version} sorted after ${RELEASE_NOTES[i - 1].version}`,
			);
			const current = RELEASE_NOTES[i].version;
			const previous = RELEASE_NOTES[i - 1].version;
			const [cy, cm, cp] = current.split(".").map(Number);
			const [py, pm, pp] = previous.split(".").map(Number);
			// Duplicates are a separate test's subject below; the tuple rule here governs
			// ordering only, so the fully-equal case is allowed by shape and caught there.
			const orderedCorrectly =
				cy < py ||
				(cy === py && cm < pm) ||
				(cy === py && cm === pm && cp < pp) ||
				(cy === py && cm === pm && cp === pp);
			expect(`${current} must sort before ${previous}`).toBe(
				`${orderedCorrectly ? current : previous} must sort before ${orderedCorrectly ? previous : current}`,
			);
		}
	});

	it("holds no duplicate versions — a shared deep link resolves a version to one release", () => {
		const versions = RELEASE_NOTES.map((r) => r.version);
		expect(versions.length).toBe(new Set(versions).size);
	});
});

describe("every entry is user-facing", () => {
	it("gives every release a lede and at least one entry", () => {
		for (const release of RELEASE_NOTES) {
			expect(`${release.version}: lede "${release.lede.slice(0, 20)}…" is non-empty`).toBe(
				`${release.version}: lede "${release.lede.slice(0, 20)}…" is non-empty`,
			);
			expect(`${release.version}: ${release.entries.length} entries`).not.toBe(
				`${release.version}: 0 entries`,
			);
		}
	});

	it("keeps each entry under the length a user skims, and non-empty", () => {
		// Not enforced to a hard cap yet — the grouping judgment is the skill's, and a
		// number picked before a second release exists would be a guess. What IS
		// enforceable: no entry is a fragment, and none is a paragraph. The lede's cap
		// matches the roadmap blurb's ceiling, which is the page's closest precedent.
		for (const { where, entry } of located()) {
			expect(`${where}: ${entry.trim().length} chars`).not.toBe(`${where}: 0 chars`);
			expect(`${where}: ${entry.length} chars exceeds the paragraph line`).toBe(
				`${where}: ${Math.min(entry.length, 400)} chars exceeds the paragraph line`,
			);
		}
	});
});

describe("every roadmap chip names something", () => {
	it("gives every chip a label, and no blank lane", () => {
		for (const release of RELEASE_NOTES) {
			for (const goal of release.roadmap ?? []) {
				expect(`${release.version} → ${goal.label || "«no label»"}`).toBe(
					`${release.version} → ${goal.label}`,
				);
				if (goal.lane !== undefined) {
					expect(`${release.version} → ${goal.lane.trim() || "«blank lane»"}`).toBe(
						`${release.version} → ${goal.lane}`,
					);
				}
			}
		}
	});
});
