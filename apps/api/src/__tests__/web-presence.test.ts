// SPDX-License-Identifier: Apache-2.0
/**
 * The presence wiring for hosted builds: the shim's heartbeat (the in-frame input
 * signal that otherwise never leaves the frame) and the play page's tracker (the
 * recording parent for isolation builds, whose frame plays THERE).
 *
 * 🚨 **The properties under test are the two that keep the attention policy honest:**
 *
 * - **No second policy.** The SPA's tracker owns the rules (idle gate, visibility,
 *   claim splitting). The play page's tracker is mechanism only — its one dial, the
 *   idle timeout, is INJECTED from `@anthers/shared/attention` at render; if the page
 *   hardcoded a number, the two tickers would drift and the same played hour would be
 *   scored differently by which surface it played on. Grep-level tests pin that.
 * - **The heartbeat carries no content.** The shim reports "input happened" — not
 *   which key, not where the pointer is. Its own source must not contain the event
 *   payloads a hostile read would want, and it stays inside the message channel that
 *   already exists between the frame and the parent that validates it.
 *
 * These are script-string assertions, the same honest form the shim-script suite
 * took: the scripts run inside frames this suite cannot execute, so the source's
 * shape IS the contract.
 */

import { describe, expect, it } from "bun:test";
import { IDLE_TIMEOUT_MS } from "@anthers/shared/attention";
import { saveShimScript } from "../lib/save-shim-script.js";

describe("the shim's presence heartbeat", () => {
	const script = saveShimScript("godot");

	it("listens to the interaction family and reports alive, throttled to one per second", () => {
		expect(script).toContain('["pointerdown", "keydown", "wheel", "touchstart"]');
		expect(script).toContain('PREFIX + "alive"');
		// The throttle: a beat is dropped inside the 1000ms window.
		expect(script).toMatch(/now - lastBeat < 1000/);
	});

	it("carries no content — only the fact of input", () => {
		// The heartbeat message is exactly one line: send alive, no payload key. The
		// shim's own source must not carry a message construction richer than that.
		const beatSection = script.slice(script.indexOf("presence heartbeat"));
		expect(beatSection).not.toMatch(/clientX|clientY/);
		// The only send in the beat path names the type and nothing else.
		expect(beatSection).toMatch(/send\(\{ type: PREFIX \+ "alive" \}\)/);
	});
});

describe("the play page's tracker — no second policy", () => {
	// The page builds its script inline; the assertions target the module source for
	// the properties that are about the source, and the constants below for the
	// single-homed dial.
	const { readFile } = require("node:fs/promises");
	const path = require("node:path");

	async function pageSource(): Promise<string> {
		return readFile(path.join(import.meta.dir, "..", "routes", "play-page.ts"), "utf8");
	}

	it("injects the idle timeout from the shared policy — never a hardcoded number", async () => {
		const src = await pageSource();
		expect(src).toContain("IDLE_TIMEOUT_MS");
		// The shared dial is one second-minute; if someone edits the page to carry a
		// literal timeout (60_000 as a number in the script), this fails.
		expect(src).not.toMatch(/IDLE_MS = \d/);
		expect(src).toMatch(/\$\{IDLE_TIMEOUT_MS\}/);
		void IDLE_TIMEOUT_MS;
	});

	it("reports through the same endpoint and event vocabulary as every other surface", async () => {
		const src = await pageSource();
		expect(src).toContain("/api/subscriptions/attention");
		// The event type is the shared vocabulary's decision, computed server-side.
		expect(src).toContain("eventTypeFor(work.type)");
		// Range identity rides with the event, so a retried flush is one range.
		expect(src).toContain("clientId");
	});
});
