// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "bun:test";
import { wikiAnchor } from "./wiki";

describe("wikiAnchor — this app's copy of the wiki's heading scheme", () => {
	// The five lane headings the release notes point at, pinned against the host's
	// `slugifyHeading`. A drift between the two shows up here as a wrong string rather
	// than as a link that lands at the top of the page, which looks like nothing is wrong.
	it("matches the anchors the roadmap's lanes answer to", () => {
		expect(wikiAnchor("Notifications")).toBe("notifications");
		expect(wikiAnchor("Creator Storage Billing")).toBe("creator-storage-billing");
		expect(wikiAnchor("First-Party Traffic Analytics")).toBe("first-party-traffic-analytics");
		expect(wikiAnchor("Creator Badges & the Badge Maker")).toBe("creator-badges--the-badge-maker");
		expect(wikiAnchor("Observability, Alerting & Rate Limiting")).toBe(
			"observability-alerting--rate-limiting",
		);
	});
});
