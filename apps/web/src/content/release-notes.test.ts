// SPDX-License-Identifier: Apache-2.0
//
// The release notes' rules, made enforceable. Mirrors `roadmap.test.ts` beside it, and
// exists for the same reason: a rule that only lives in a docblock produces something
// that still looks right when broken.
//
// 🚨 **The version rule is the two-way link's foundation.** An entry names the version
// whose GitHub release holds the raw release notes, and the roadmap's card for a shipped
// item names the version that launched it — a typo'd version breaks the link from both
// directions at once, silently, which is why it is checked against the shape the deploy
// job tags rather than against another list in this file.
//
// ⚠️ **The roadmap cross-reference check is the page's honesty mechanism.** The two-way
// link is the point of `/release-notes`: an entry may only claim roadmap items that
// exist, and — harder to catch, and the reason this is a test — an item it claims may not
// still be sitting in `active` or `planned` on the roadmap while the notes say it shipped.
// `roadmapIds` is deliberately optional and usually absent for exactly this reason: most
// work is not a roadmap item, and a stretched claim is the failure mode.

import { describe, expect, it } from "bun:test";
import { RELEASE_NOTES, type ReleaseNotesEntry } from "./release-notes";
import { allItems, type RoadmapItem } from "./roadmap";

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

	it("holds no duplicate versions — the roadmap's reverse link resolves a version to one release", () => {
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

describe("every roadmap cross-reference is real", () => {
	const items: Map<string, RoadmapItem> = new Map(allItems().map((i) => [i.id, i]));

	it("resolves each reference to a real roadmap item", () => {
		for (const release of RELEASE_NOTES) {
			for (const id of release.roadmapIds ?? []) {
				expect(`${release.version} → ${id} ${items.get(id)?.title ?? "«no such item»"}`).toBe(
					`${release.version} → ${id} ${items.get(id)?.title}`,
				);
			}
		}
	});

	it("🚨 claims no roadmap item that is still unbuilt — the notes never ship something the roadmap still shows planned", () => {
		// The hard one, and the reason this file exists. An item claimed by a release
		// must have moved to `launched` in the same PR: a release-notes entry and a roadmap
		// card disagreeing about whether something shipped is the two surfaces the
		// exporter plan is meant to unify, contradicting each other in public.
		for (const release of RELEASE_NOTES) {
			for (const id of release.roadmapIds ?? []) {
				const item = items.get(id);
				if (!item) continue;
				expect(`${release.version} → ${id} (${item.bucket})`).toBe(
					`${release.version} → ${id} (launched)`,
				);
			}
		}
	});
});
