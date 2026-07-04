// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Render creator-authored HTML that was sanitized server-side at write time
 * (see apps/api/src/services/sanitize.ts) — the single, audited place the app
 * sets innerHTML.
 */
export default function SanitizedHtml({ html, className }: { html: string; className?: string }) {
	// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server-side at write time (apps/api/src/services/sanitize.ts)
	return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
