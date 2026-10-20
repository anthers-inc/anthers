// SPDX-License-Identifier: Apache-2.0
/**
 * The Network tab's membership control (Parker, 2026-10-19).
 *
 * A source-text guard, in the family of `three-tabs.test.ts`: the control is one
 * component with four route values, and the page must both render it and hand its
 * value to the feed request. A refactor that quietly left `network_source` out of the
 * query would render a working-looking filter that changed nothing.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");

const page = read("AuthenticatedHomePage.tsx");
const section = read("../components/layout/NetworkMembershipSection.tsx");

describe("the Network membership control", () => {
	it("offers the four routes into the network", () => {
		for (const id of ['id: ""', 'id: "following"', 'id: "subscribed"', 'id: "saved"']) {
			expect(section, `the ${id} option is missing`).toContain(id);
		}
		expect(section).toContain("Everyone in your network");
		expect(section).toContain("Creators you follow");
		expect(section).toContain("Creators you support");
		expect(section).toContain("Saved or purchased from");
	});

	it("is rendered by the Network page, above the lenses", () => {
		expect(page).toContain("<NetworkMembershipSection");
		expect(page.indexOf("<NetworkMembershipSection")).toBeLessThan(
			page.indexOf("<SharedLensesSection"),
		);
	});

	it("carries its value into the feed request", () => {
		expect(page).toContain('searchParams.get("network_source")');
		expect(page).toContain("network_source: networkSource");
	});
});
