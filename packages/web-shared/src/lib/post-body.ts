// SPDX-License-Identifier: Apache-2.0
/**
 * The stored body speaks **markdown**; the editor speaks HTML. This is the load-time
 * half of the marked ↔ turndown round trip the write boundary pairs with the same
 * sanitizer (`services/post-markdown.ts`): the HTML the editor opens with converts back
 * to the identical markdown on save, which is why echoing a body back produces a no-op
 * edit and not a new history row.
 */
import { marked } from "marked";

/** The stored body's markdown, as the HTML the rich-text editor opens with. */
export function markdownToEditorHtml(markdown: string | null | undefined): string {
	return marked.parse(markdown ?? "", { async: false });
}
