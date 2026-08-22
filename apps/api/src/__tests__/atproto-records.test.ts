// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mapping a Work onto its public `org.anthers.work` record.
 *
 * ⭐ The load-bearing assertion is that the produced record passes the Lexicon's OWN
 * validator — the one generated from `lexicons/org/anthers/work.json`. Asserting field by
 * field against a hand-written expectation would only restate the mapper's formula; running
 * the schema is the one check that can tell us the Lexicon is adequate for our data, which
 * has to be true before it is published as a public commitment.
 */
import { describe, expect, it } from "bun:test";
import { workRecord } from "@anthers/shared/lexicons";
import {
	type PublishableWork,
	unpublishableReason,
	workToRecord,
	workUrl,
} from "../services/atproto-records.js";

const BASE = "https://anthers.org";
const RELEASED = new Date("2026-07-01T00:00:00.000Z");

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
		releasedAt: RELEASED,
		...overrides,
	};
}

describe("what may be published at all", () => {
	it("publishes a released, active Work", () => {
		expect(unpublishableReason(openWork())).toBeNull();
		expect(workToRecord(openWork(), { baseUrl: BASE })).not.toBeNull();
	});

	// 🚨 Each of these is a promise a public record would break, not a tidiness rule.
	it.each([
		["private", { visibility: "private" }, "not_released"],
		["withdrawn", { visibility: "withdrawn" }, "not_released"],
		["taken down", { takedownStatus: "taken_down" }, "taken_down"],
	])("refuses to publish a %s Work", (_label, overrides, reason) => {
		const work = openWork(overrides as Partial<PublishableWork>);
		expect(unpublishableReason(work)).toBe(reason as never);
		expect(workToRecord(work, { baseUrl: BASE })).toBeNull();
	});

	it("fails closed on a visibility value it does not recognise", () => {
		// A record, once public, cannot be recalled by deleting it — the firehose already
		// carried it — so an unknown state must not default to publishable.
		expect(unpublishableReason(openWork({ visibility: "some_future_state" }))).toBe("not_released");
	});
});

describe("the record validates against its own Lexicon", () => {
	it("accepts a fully populated record", () => {
		const record = workToRecord(openWork(), { baseUrl: BASE });
		expect(workRecord.safeParse(record).success).toBe(true);
	});

	it("accepts a record with every optional field absent", () => {
		const record = workToRecord(openWork({ description: "" }), { baseUrl: BASE });
		expect(record).not.toHaveProperty("description");
		expect(workRecord.safeParse(record).success).toBe(true);
	});
});

describe("the release date", () => {
	it("reports the Work's own release date", () => {
		expect(workToRecord(openWork(), { baseUrl: BASE })?.releasedAt).toBe(
			"2026-07-01T00:00:00.000Z",
		);
	});

	it("refuses to publish a released Work with no release date", () => {
		// 🚨 No current path produces this: the update route stamps `releasedAt` on first
		// release and the seed script sets it too. The only rows carrying it in the dev
		// database come from test fixtures inserting `visibility: "released"` directly.
		// So reporting it beats approximating it — if it ever appears in production it is a
		// bug worth seeing, and the alternative was writing a date we know is wrong into a
		// record other people cache.
		const work = openWork({ releasedAt: null });
		expect(unpublishableReason(work)).toBe("missing_release_date");
		expect(workToRecord(work, { baseUrl: BASE })).toBeNull();
	});
});

describe("access is what a stranger would find", () => {
	it("marks a freely-openable Work open", () => {
		expect(workToRecord(openWork(), { baseUrl: BASE })?.access).toEqual({ state: "open" });
	});

	it("marks a Work behind a creator's Badge gated", () => {
		const work = openWork({
			seedAccess: [
				{ threshold: 0, allow: false, price: "0" },
				{ threshold: 9, allow: true, price: "0" },
			] as never,
		});
		expect(workToRecord(work, { baseUrl: BASE })?.access).toEqual({ state: "gated" });
	});

	it("marks a purchasable Work gated", () => {
		const work = openWork({
			seedAccess: [{ threshold: 0, allow: true, price: "12.00" }] as never,
		});
		expect(workToRecord(work, { baseUrl: BASE })?.access).toEqual({ state: "gated" });
	});

	it("is an object rather than a bare string, so context can be added later", () => {
		// 🚨 `knownValues` is open, so new *values* are free — but "types can not change",
		// so a string could never become an object. Under atproto Spaces a listing may need
		// to name the space that grants access, and only an object can grow that way.
		const shape = (workRecord.schema as { shape?: Record<string, unknown> }).shape;
		expect(shape).toBeDefined();
		const record = workToRecord(openWork(), { baseUrl: BASE });
		expect(typeof record?.access).toBe("object");
	});
});

describe("what the record must never carry", () => {
	it("has no field capable of holding the deliverable", () => {
		// The Lexicon's shape is the guarantee, so this asserts the schema rather than the
		// mapper: a repo is world-readable, and a `body` field would be a gate bypass no
		// amount of care in the mapper could close.
		const props = Object.keys(
			(workRecord.schema as { shape?: Record<string, unknown> }).shape ?? {},
		);
		// ⚠️ Without this the test is a tautology: if `shape` ever moves, `props` is empty
		// and every assertion below passes by describing nothing.
		expect(props.length).toBeGreaterThan(3);
		expect(props).toContain("title");
		for (const forbidden of ["body", "bodyHtml", "lyrics", "sourceKey", "embedUrl"]) {
			expect(props).not.toContain(forbidden);
		}
	});

	it("carries no field that assumes what kind of thing a Work is", () => {
		// ⭐ The principle that removed `durationSeconds` and `authoredAt`: a listing must
		// not encode assumptions about a Work's shape. Duration assumed time-based media;
		// an authored date assumed a finished artifact, which excludes actively developed
		// software, patched games and serial comics. Both are mediums Anthers welcomes.
		const props = Object.keys(
			(workRecord.schema as { shape?: Record<string, unknown> }).shape ?? {},
		);
		expect(props.length).toBeGreaterThan(3);
		for (const shaped of [
			"durationSeconds",
			"authoredAt",
			"authoredPrecision",
			"readMinutes",
			"pageCount",
			"extent",
			"fileSize",
		]) {
			expect(props).not.toContain(shaped);
		}
	});

	it("names every medium the platform actually has a consumption mode for", async () => {
		// 🚨 The first draft of this list came from a stale comment in `content.ts` and was
		// missing `ebook` — a real medium with its own reader, added the week before. The
		// authority is `CONSUMPTION` in `attention.ts`, because a type absent from there
		// earns its creator nothing; a type absent from here merely reads oddly.
		//
		// ⚠️ Asserted against the Lexicon JSON rather than the generated validator, because
		// `knownValues` is an OPEN set and so is not a validation constraint — the generated
		// schema drops it, which is exactly why adding a medium later is not a breaking
		// change. The JSON is the artefact that gets published, so the JSON is what to check.
		const lexicon = await Bun.file("lexicons/org/anthers/work.json").json();
		const known: string[] = lexicon.defs.main.record.properties.kind.knownValues;
		const attention = await Bun.file("packages/shared/src/attention.ts").text();
		const consumption = attention.slice(
			attention.indexOf("const CONSUMPTION"),
			attention.indexOf("};", attention.indexOf("const CONSUMPTION")),
		);
		const mediums = [...consumption.matchAll(/^\t(\w+):/gm)].map((m) => m[1]);
		expect(mediums.length).toBeGreaterThan(5);
		for (const medium of mediums) expect(known).toContain(medium);
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
