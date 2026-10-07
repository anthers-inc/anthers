// SPDX-License-Identifier: Apache-2.0
/**
 * The save shim's serving half: the script Anthers injects into a served entry
 * document, the injection itself, and the message contract both ends share.
 *
 * 🚨 **The property under test is "the shim is inert without the parent".** The script
 * carries no fetch, no credential, no Anthers URL — grep-level assertions are the
 * honest form here, because the shim's whole security story is that its authority on
 * Anthers is zero: it can write the frame's own IndexedDB (the floor) and postMessage
 * the parent that framed it. A build that strips it saves locally; a malicious build
 * gains nothing it could not already do. These tests keep that story true in code,
 * not just in the docblock.
 */

import { describe, expect, it } from "bun:test";
import { isSaveShimMessage } from "@anthers/shared/save-shim";
import { saveShimScript } from "../lib/save-shim-script.js";
import { contentTypeIsHtml, injectSaveShim } from "../lib/web-build.js";

describe("save shim script — inert without the parent", () => {
	const script = saveShimScript("godot");

	it("makes no network call and carries no credential surface", () => {
		// The honest grep-level assertions: no fetch/XHR/WebSocket, no Anthers origin,
		// no cookie or token vocabulary anywhere in the shim's source.
		expect(script).not.toMatch(/\bfetch\s*\(/);
		expect(script).not.toMatch(/XMLHttpRequest/);
		expect(script).not.toMatch(/WebSocket/);
		expect(script).not.toMatch(/anthers\.org|anthers\.run/);
		expect(script).not.toMatch(/cookie|Authorization|Bearer|token/i);
	});

	it("speaks only to the parent that framed it", () => {
		expect(script).toContain("window.parent.postMessage");
		// And never anywhere else — no postMessage to other windows, no opener.
		const postTargets = [...script.matchAll(/(\w+(?:\.\w+)*)\.postMessage/g)].map((m) => m[1]);
		expect(postTargets).toEqual(["window.parent"]);
	});

	it("writes the engine's own store shape (the IDBFS record format)", () => {
		// The restore contract: the shim writes the records Godot's IDBFS mount reads.
		expect(script).toContain('indexedDB.open("/userfs")');
		expect(script).toContain("FILE_DATA");
	});

	it("declares the runtime it was built for", () => {
		expect(saveShimScript("godot")).toContain('"godot"');
	});
});

describe("save shim injection", () => {
	const script = "SHIM_CODE"; // raw script source — the injection adds the tag itself

	it("lands the shim as the first thing in <head>, ahead of every engine script", () => {
		const html =
			"<!doctype html><html><head><meta charset='utf-8'><script src='index.js'></script></head><body></body></html>";
		const out = injectSaveShim(html, script);
		expect(out).toContain(
			"<script data-anthers-save-shim>SHIM_CODE</script><meta charset='utf-8'>",
		);
		const shimAt = out.indexOf("SHIM_CODE");
		const engineAt = out.indexOf("index.js");
		expect(shimAt).toBeLessThan(engineAt);
		expect(shimAt).toBeGreaterThan(out.indexOf("<head"));
	});

	it("is idempotent — a document already carrying it is served unchanged", () => {
		const html =
			"<html><head><script data-anthers-save-shim>existing anthers-save-shim</script></head></html>";
		expect(injectSaveShim(html, script)).toBe(html);
	});

	it("fails open to unmodified content shapes — no head, no html", () => {
		const fragment = "<p>not a real document</p>";
		const out = injectSaveShim(fragment, script);
		expect(out.startsWith(`<script data-anthers-save-shim>${script}</script>`)).toBe(true);
		expect(out).toContain("not a real document");
	});
});

describe("the message contract", () => {
	it("recognizes the shim's messages by kind", () => {
		expect(isSaveShimMessage({ type: "anthers-save:load" })).toBe(true);
		expect(isSaveShimMessage({ type: "anthers-save:put", blob: "" })).toBe(true);
		expect(isSaveShimMessage({ type: "anthers-save:loaded", blob: null })).toBe(true);
		expect(isSaveShimMessage({ type: "not-ours" })).toBe(false);
		expect(isSaveShimMessage(null)).toBe(false);
		expect(isSaveShimMessage("anthers-save:load")).toBe(false);
	});
});

describe("HTML kind check", () => {
	it("is true for entries and false for everything a build also carries", () => {
		expect(contentTypeIsHtml("index.html")).toBe(true);
		expect(contentTypeIsHtml("deep/Index.HTML")).toBe(true);
		expect(contentTypeIsHtml("index.js")).toBe(false);
		expect(contentTypeIsHtml("game.pck")).toBe(false);
		expect(contentTypeIsHtml("engine.wasm")).toBe(false);
	});
});
