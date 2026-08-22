// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mapping a Work onto its public `org.anthers.work` record.
 *
 * ⭐ The load-bearing assertion is that the produced record passes the Lexicon's OWN
 * validator — the one generated from `lexicons/org/anthers/work.json`. Asserting field by
 * field against a hand-written expectation would only restate the mapper's formula; running
 * the schema is the one check that can tell us the Lexicon is actually adequate for our
 * data, which is what has to be true before it is published as a public commitment.
 */
import { describe, expect, it } from "bun:test";
import { workRecord } from "@anthers/shared/lexicons";
import {
	type PublishableWork,
	unpublishableReason,
	workToRecord,
	workUrl,
} from "../services/atproto-records.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const BASE = "https://anthers.org";

/** A released Work that anyone may open: one baseline row, allowed, priced at zero. */
function openWork(overrides: Partial<PublishableWork> = {}): PublishableWork {
	return {
		id: 1,
		creatorId: 42,
		streamEnabled: true,
		downloadEnabled: false,
		takedownStatus: "active",
		visibility: "released",
		seedAccess: [{ threshold: 0, allow: true, price: "0" }] as never,
		type: "video",
		title: "A Short Film",
		description: "Ten minutes of something.",
		slug: "a-short-film",
		publicId: 90210,
		tags: ["film", "short"],
		websiteUrl: "",
		sourceUrl: "",
		durationSeconds: 600,
		authoredAt: null,
		authoredPrecision: null,
		releasedAt: new Date("2026-07-01T00:00:00.000Z"),
		...overrides,
	};
}

describe("what may be published at all", () => {
	it("publishes a released, active Work", () => {
		expect(unpublishableReason(openWork())).toBeNull();
		expect(workToRecord(openWork(), { baseUrl: BASE, now: NOW })).not.toBeNull();
	});

	// 🚨 Each of these is a promise a public record would break, not a tidiness rule.
	it.each([
		["private", { visibility: "private" }, "not_released"],
		["withdrawn", { visibility: "withdrawn" }, "not_released"],
		["taken down", { takedownStatus: "taken_down" }, "taken_down"],
	])("refuses to publish a %s Work", (_label, overrides, reason) => {
		const work = openWork(overrides as Partial<PublishableWork>);
		expect(unpublishableReason(work)).toBe(reason as never);
		expect(workToRecord(work, { baseUrl: BASE, now: NOW })).toBeNull();
	});

	it("fails closed on a visibility value it does not recognise", () => {
		// A record, once public, cannot be recalled by deleting it — so an unknown state
		// must not default to publishable.
		const work = openWork({ visibility: "some_future_state" });
		expect(unpublishableReason(work)).toBe("not_released");
	});
});

describe("the record validates against its own Lexicon", () => {
	it("accepts a fully populated record", () => {
		const record = workToRecord(
			openWork({
				websiteUrl: "https://example.com/film",
				sourceUrl: "https://example.com/film/source",
				authoredAt: new Date("2015-01-01T00:00:00.000Z"),
				authoredPrecision: "year",
			}),
			{ baseUrl: BASE, now: NOW },
		);
		const result = workRecord.safeParse(record);
		expect(result.success).toBe(true);
	});

	it("accepts a minimal record", () => {
		const record = workToRecord(
			openWork({
				description: "",
				tags: [],
				durationSeconds: null,
				releasedAt: null,
			}),
			{ baseUrl: BASE, now: NOW },
		);
		expect(workRecord.safeParse(record).success).toBe(true);
	});
});

describe("access is what a stranger would find", () => {
	it("marks a freely-openable Work open", () => {
		const record = workToRecord(openWork(), { baseUrl: BASE, now: NOW });
		expect(record?.access).toBe("open");
	});

	it("marks a Work behind a creator's Badge gated", () => {
		const work = openWork({
			seedAccess: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 9, allow: true, price: "0" },
			] as never,
		});
		expect(workToRecord(work, { baseUrl: BASE, now: NOW })?.access).toBe("gated");
	});

	it("marks a purchasable Work gated", () => {
		const work = openWork({
			seedAccess: [{ threshold: 0, allow: true, price: "12.00" }] as never,
		});
		expect(workToRecord(work, { baseUrl: BASE, now: NOW })?.access).toBe("gated");
	});
});

describe("what the record must never carry", () => {
	it("has no field capable of holding the deliverable", () => {
		// The Lexicon's shape is the guarantee, so this asserts the schema rather than the
		// mapper: a repo is world-readable, and a `body` field would be a gate bypass that
		// no amount of care in the mapper could close.
		const props = Object.keys(
			(workRecord.schema as { shape?: Record<string, unknown> }).shape ?? {},
		);
		// ⚠️ Without this the test is a tautology: if `shape` ever moves, `props` is empty
		// and every assertion below passes by describing nothing.
		expect(props.length).toBeGreaterThan(5);
		expect(props).toContain("title");
		for (const forbidden of ["body", "bodyHtml", "lyrics", "sourceKey", "embedUrl"]) {
			expect(props).not.toContain(forbidden);
		}
	});

	it("omits empty strings rather than publishing them as values", () => {
		const record = workToRecord(openWork({ description: "", websiteUrl: "", sourceUrl: "" }), {
			baseUrl: BASE,
			now: NOW,
		});
		expect(record).not.toHaveProperty("description");
		expect(record).not.toHaveProperty("website");
		expect(record).not.toHaveProperty("source");
	});
});

describe("the two authored fields travel together", () => {
	it("emits neither when the date is absent", () => {
		const record = workToRecord(openWork({ authoredAt: null, authoredPrecision: "year" }), {
			baseUrl: BASE,
			now: NOW,
		});
		expect(record).not.toHaveProperty("authoredAt");
		expect(record).not.toHaveProperty("authoredPrecision");
	});

	it("emits both when the date is present", () => {
		const record = workToRecord(
			openWork({ authoredAt: new Date("2015-06-01T00:00:00.000Z"), authoredPrecision: "month" }),
			{ baseUrl: BASE, now: NOW },
		);
		expect(record?.authoredAt).toBe("2015-06-01T00:00:00.000Z");
		expect(record?.authoredPrecision).toBe("month");
	});
});

describe("the canonical url", () => {
	it("matches the app's own work route", () => {
		expect(workUrl(openWork(), BASE)).toBe("https://anthers.org/works/a-short-film-90210");
	});

	it("tolerates a base url with a trailing slash", () => {
		expect(workUrl(openWork(), "https://anthers.org/")).toBe(
			"https://anthers.org/works/a-short-film-90210",
		);
	});
});
