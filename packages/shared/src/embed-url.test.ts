// SPDX-License-Identifier: Apache-2.0
/**
 * Which embed addresses a game or software Work may carry.
 *
 * The refusals are asserted one scheme and one host at a time, because each is a separate way for
 * a creator's page to run with Anthers' privileges and a check that caught one would not catch the
 * next. `JavaScript:` with a capital and a leading space is in the list because the URL parser
 * normalizes both, so a check written as a string prefix would have let it through.
 */
import { describe, expect, it } from "bun:test";
import { EMBED_URL_MAX, embedUrlProblem } from "./content";

describe("an embed address", () => {
	it("may be empty, meaning the Work has no browser build", () => {
		expect(embedUrlProblem("")).toBeNull();
	});

	it("may be an https page on another site", () => {
		expect(embedUrlProblem("https://games.example.com/embed/build")).toBeNull();
		expect(embedUrlProblem("https://html-classic.itch.zone/html/123/index.html")).toBeNull();
		// A lookalike is another site: only the domain itself and its subdomains are Anthers'.
		expect(embedUrlProblem("https://notanthers.org/build")).toBeNull();
	});

	for (const address of [
		"javascript:alert(document.cookie)",
		" JavaScript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox(1)",
		"blob:https://anthers.org/1234",
		"http://games.example.com/embed",
		"ftp://games.example.com/embed",
	]) {
		it(`may not use the scheme of ${JSON.stringify(address)}`, () => {
			expect(embedUrlProblem(address)).not.toBeNull();
		});
	}

	for (const address of [
		"https://anthers.org/api/content/works/1/assets/2/download",
		"https://ANTHERS.org/anything",
		"https://cdn.anthers.org/build/index.html",
		"https://admin.anthers.org/",
	]) {
		it(`may not be hosted on Anthers' own domain: ${address}`, () => {
			expect(embedUrlProblem(address)).toContain("another site");
		});
	}

	it("may not be something that is not an address at all", () => {
		expect(embedUrlProblem("games.example.com/embed")).not.toBeNull();
		expect(embedUrlProblem("not a url")).not.toBeNull();
	});

	it("may not be longer than the column the Work form has always allowed", () => {
		const long = `https://games.example.com/${"a".repeat(EMBED_URL_MAX)}`;
		expect(embedUrlProblem(long)).toContain(String(EMBED_URL_MAX));
	});
});
