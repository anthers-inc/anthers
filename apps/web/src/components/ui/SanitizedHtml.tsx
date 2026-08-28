// SPDX-License-Identifier: AGPL-3.0-or-later

import { censorHtml, useLanguageFilter } from "@anthers/web-shared/language-filter";

/**
 * Render creator-authored HTML that was sanitized server-side at write time
 * (see apps/api/src/services/sanitize.ts) — the single, audited place the app
 * sets innerHTML.
 *
 * ⚠️ **The language filter is applied here and only here for HTML**, because this is the one
 * component that renders it. Applying it at the API would rewrite what is stored and what
 * every other reader sees; applying it in each page would be five places to forget. Note it
 * runs on markup that is *already* sanitized, so it is a text transformation rather than a
 * second security boundary — `censorHtml` parses so it can leave tags and URLs alone, not
 * because this input is untrusted.
 */
export default function SanitizedHtml({ html, className }: { html: string; className?: string }) {
	const filtered = useLanguageFilter();
	const body = filtered ? censorHtml(html) : html;
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side at write time (apps/api/src/services/sanitize.ts)
	return <div className={className} dangerouslySetInnerHTML={{ __html: body }} />;
}
