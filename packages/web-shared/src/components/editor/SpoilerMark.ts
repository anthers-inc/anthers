// SPDX-License-Identifier: Apache-2.0
/**
 * The editor's Spoiler mark.
 *
 * ⭐ **The mark is `span.spoiler` in HTML and `||…||` in storage**, which is the same pair
 * every other surface speaks: the sanitizer admits exactly that span, turndown turns it back
 * into the delimiters, and `marked` parses the delimiters into the span again on load. A
 * creator who selects text and presses the toolbar's Spoiler button and a creator who types
 * `||…||` end up with the identical stored body.
 *
 * The input rule is the typed spelling, so the convention is usable without the button and
 * the editor shows what it will look like rather than a run of pipes.
 */
import { Mark, markInputRule, mergeAttributes } from "@tiptap/core";

export const SpoilerMark = Mark.create({
	name: "spoiler",
	/**
	 * Above the ordinary marks, so the spoiler stays the outer wrapper. A spoiler around bold
	 * text or a link is one pair of delimiters, and the editor has to serialize it as
	 * `<span class="spoiler"><strong>…</strong></span>`; with the default priority it would
	 * serialize as `<strong><span class="spoiler">…</span></strong>` and a save would turn one
	 * spoiler into three around the marks inside it. The Link extension sets 1000, so this sits
	 * above it too — otherwise a link inside a spoiler wraps the reveal control instead of
	 * living inside it.
	 */
	priority: 1100,

	parseHTML() {
		return [{ tag: "span.spoiler" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["span", mergeAttributes(HTMLAttributes, { class: "spoiler" }), 0];
	},

	addInputRules() {
		return [
			markInputRule({
				find: /\|\|([^|]+)\|\|$/,
				type: this.type,
			}),
		];
	},
});
