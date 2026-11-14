// SPDX-License-Identifier: Apache-2.0
/**
 * `||spoiler||` — the one spelling of a spoiler, from a post's stored markdown down to a
 * comment's plain text.
 *
 * ⭐ **A text convention rather than a markdown node, because the three surfaces do not share
 * a syntax.** A post's body is markdown, but a comment's body is plain text (and
 * `org.anthers.comment` publishes it as plain text, never markup), and a reply is a comment.
 * `||…||` survives all three unchanged and publishes literally, so a consumer that does not
 * know the convention shows the words with their pipes rather than losing them — the same
 * courtesy Discord's spoiler tag extends, and the reason this task borrowed its spelling.
 *
 * ⚠️ **The words stay in the served text.** This is a courtesy convention, not access
 * control: the server sends the hidden words, and the reader's own renderer withholds them
 * until they ask. A gate is the mechanism for keeping something from somebody; this is the
 * mechanism for not printing an ending above the fold.
 *
 * Pairing is left to right and flat: the first `||` opens, the next closes, an unpaired `||`
 * stays literal, and a `||` inside a code span is code. Nesting has no spelling and never
 * parses — `||a ||b|| c||` opens at the first, closes at the second, and leaves the rest as
 * text. A backslash escape (`\|\|`) is markdown's own and works in a post; a comment is not
 * markdown, so a comment shows it as typed.
 */
import type { MarkedExtension, Tokens } from "marked";

/** The delimiter, spelled in one place so the parser, the storage round trip and the UI agree. */
export const SPOILER_DELIMITER = "||";

/** One run of a plain-text body, either shown as it is or hidden behind a reveal. */
export interface SpoilerSegment {
	kind: "text" | "spoiler";
	value: string;
}

/**
 * A plain-text body split into shown and hidden runs.
 *
 * This is what the comment renderer walks, and it is the definition of the convention the
 * markdown side implements in `spoilerMarkedExtension` and the remark plugin mirrors for
 * posts. Empty delimiters (`||||`) are left as literal text rather than drawn as an empty
 * spoiler nobody could have meant to write.
 */
export function splitSpoilers(text: string): SpoilerSegment[] {
	const segments: SpoilerSegment[] = [];
	const pushText = (value: string) => {
		if (!value) return;
		const last = segments.at(-1);
		if (last?.kind === "text") last.value += value;
		else segments.push({ kind: "text", value });
	};

	let cursor = 0;
	let open = -1;
	let openAt = -1;
	let search = 0;
	for (;;) {
		const at = text.indexOf(SPOILER_DELIMITER, search);
		if (at < 0) break;
		if (open < 0) {
			pushText(text.slice(cursor, at));
			open = at + SPOILER_DELIMITER.length;
			openAt = at;
			search = open;
			continue;
		}
		// An empty pair is not a spoiler; keep it as the text the person typed.
		if (at === open) pushText(text.slice(openAt, at + SPOILER_DELIMITER.length));
		else segments.push({ kind: "spoiler", value: text.slice(open, at) });
		cursor = at + SPOILER_DELIMITER.length;
		open = -1;
		search = cursor;
	}

	// An unclosed opener is literal, so the tail from the opener is shown as typed.
	pushText(text.slice(open < 0 ? cursor : openAt));
	return segments;
}

/** A marked token carrying parsed inline children between a pair of delimiters. */
export interface SpoilerToken extends Tokens.Generic {
	type: "spoiler";
	raw: string;
	text: string;
	tokens: Tokens.Generic[];
}

/**
 * The marked half of the convention: `||…||` becomes `<span class="spoiler">…</span>` while
 * the words inside are parsed as inline markdown, so bold, emphasis and links inside a
 * spoiler keep working.
 *
 * ⭐ **`start` is what makes a mid-word spoiler work.** Marked's text tokenizer otherwise
 * swallows `hello||secret||` as one run, so the extension tells the lexer where the next
 * `||` begins and the text is cut there first. The same hook is why a `||` inside a code
 * span or a link destination is safe: those tokenizers consume their whole construct before
 * the text run that would have needed cutting.
 *
 * The output is sanitized like any other body HTML — `apps/api/src/services/sanitize.ts`
 * admits exactly `span.spoiler`, which is also what turndown turns back into `||…||`.
 */
export const spoilerMarkedExtension: MarkedExtension = {
	extensions: [
		{
			name: "spoiler",
			level: "inline",
			start(src) {
				const at = src.indexOf(SPOILER_DELIMITER);
				return at < 0 ? undefined : at;
			},
			tokenizer(src) {
				const match = /^\|\|([\s\S]+?)\|\|/.exec(src);
				if (!match) return undefined;
				const text = match[1];
				return {
					type: "spoiler",
					raw: match[0],
					text,
					tokens: this.lexer.inlineTokens(text),
				} satisfies SpoilerToken;
			},
			renderer(token) {
				const spoiler = token as SpoilerToken;
				return `<span class="spoiler">${this.parser.parseInline(spoiler.tokens)}</span>`;
			},
		},
	],
};
