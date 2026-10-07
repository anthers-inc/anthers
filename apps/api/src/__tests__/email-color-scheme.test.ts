// SPDX-License-Identifier: Apache-2.0
/**
 * The email shell's color-scheme declaration.
 *
 * Anthers' email is light-authored — every color is a light-theme hex baked inline — so a
 * mail client that re-themes the message for a dark reader setting produces the one
 * combination the mail can neither predict nor test against. The shell therefore declares
 * `color-scheme: only light` in every form the major clients read: the `meta` tags Apple
 * Mail and Outlook honor, and the CSS property Outlook Android's translation pass reads
 * when the metas alone are missed. This file pins those declarations so a template
 * restructuring cannot drop them silently — the failure direction is a mobile dark-mode
 * reader's washed-out receipt, which is exactly the report that earned this test.
 */
import { describe, expect, it } from "bun:test";
import { shell } from "../services/email";

describe("the email shell's color-scheme", () => {
	it("declares only-light in the meta tags and the CSS, so no client re-themes it", () => {
		const html = shell("Test heading", "<p>Body</p>");
		// The head is present at all — the shell previously emitted none, which is what
		// let clients apply their own defaults to the whole document.
		expect(html).toContain("<head>");
		// The meta form, in both spellings the clients use.
		expect(html).toContain('<meta name="color-scheme" content="only light">');
		expect(html).toContain('<meta name="supported-color-schemes" content="only light">');
		// The CSS form, which Outlook Android's theming pass reads.
		expect(html).toContain("color-scheme: only light");
	});
});
