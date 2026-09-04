// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The licensing assertion, and the committed data it runs against.
 *
 * 🚨 **The case worth testing is the license nobody has read yet.** Real provenance
 * is uniformly `creative-commons-attribution` today, so a test over the committed
 * data alone would pass just as happily against a check that accepted everything.
 * The synthetic cases below are the ones that decide whether this fails closed.
 */

import { describe, expect, it } from "bun:test";
import {
	auditCurated,
	type CuratedIcon,
	type IconProvenance,
	LICENSES,
	readCurated,
	readProvenance,
} from "./provenance";

const icon = (over: Partial<CuratedIcon> = {}): CuratedIcon => ({
	id: "test-icon",
	nounId: 999999,
	path: "nature/x/noun-test-999999.svg",
	...over,
});

const record = (over: Partial<IconProvenance> = {}): IconProvenance => ({
	nounId: 999999,
	term: "Test",
	license: "creative-commons-attribution",
	attribution: "Test by Somebody from Noun Project",
	permalink: "/icon/test-999999/",
	creator: { name: "Somebody", username: "somebody", permalink: "/creator/somebody/" },
	fetchedAt: "2026-09-04",
	...over,
});

describe("the licensing audit", () => {
	it("accepts a license this repository has established it may redistribute under", () => {
		const { failures, rows } = auditCurated([icon()], new Map([[999999, record()]]));
		expect(failures).toEqual([]);
		expect(rows).toHaveLength(1);
	});

	it("🚨 fails on a license nobody has read, rather than passing it through", () => {
		// The failure mode this exists for: a new license string arrives from the vendor
		// and is treated as fine because the code only knew how to recognize a bad one.
		const { failures, rows } = auditCurated(
			[icon()],
			new Map([[999999, record({ license: "some-new-license-2027" })]]),
		);
		expect(rows).toEqual([]);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("some-new-license-2027");
		// The message has to name the decision, because the fix is a person reading terms.
		expect(failures[0]).toContain("LICENSES");
	});

	it("🚨 fails on an empty license, which is what a missing field looks like", () => {
		const { failures } = auditCurated([icon()], new Map([[999999, record({ license: "" })]]));
		expect(failures).toHaveLength(1);
	});

	it("fails when an icon has no provenance at all, and says how to get it", () => {
		const { failures } = auditCurated([icon()], new Map());
		expect(failures[0]).toContain("--backfill");
	});

	it("fails when there is nobody to attribute, or nowhere to point", () => {
		expect(
			auditCurated([icon()], new Map([[999999, record({ creator: { name: "" } })]])).failures,
		).toHaveLength(1);
		expect(
			auditCurated([icon()], new Map([[999999, record({ permalink: "" })]])).failures,
		).toHaveLength(1);
	});

	it("⚠️ matches provenance by noun id, not by position", () => {
		// The two lists are maintained independently — one authored, one fetched — so an
		// icon added to the middle of the curated set must not shift anybody's artist.
		const { failures } = auditCurated(
			[icon({ id: "a", nounId: 1 }), icon({ id: "b", nounId: 2 })],
			new Map([
				[2, record({ nounId: 2, creator: { name: "Second" } })],
				[1, record({ nounId: 1, creator: { name: "First" } })],
			]),
		);
		expect(failures).toEqual([]);
	});
});

describe("the committed curated set", () => {
	const curated = readCurated();
	const provenance = readProvenance();

	it("passes its own audit", () => {
		expect(auditCurated(curated, provenance).failures).toEqual([]);
	});

	it("carries a Noun Project id that agrees with the filename", () => {
		// The id is what ties an asset to its artist. Both numbers are written down so
		// they can disagree out loud, because nothing downstream could catch a swap.
		for (const c of curated) {
			const inName = /-(\d+)\.svg$/.exec(c.path)?.[1];
			expect({ id: c.id, fromName: Number(inName) }).toEqual({ id: c.id, fromName: c.nounId });
		}
	});

	it("has no duplicate friendly id and no duplicate noun id", () => {
		expect(new Set(curated.map((c) => c.id)).size).toBe(curated.length);
		expect(new Set(curated.map((c) => c.nounId)).size).toBe(curated.length);
	});

	it("names only licenses the audit knows", () => {
		for (const p of provenance.values()) expect(Object.keys(LICENSES)).toContain(p.license);
	});
});
