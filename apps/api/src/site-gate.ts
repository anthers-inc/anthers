// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Secrets that authorize a visitor past the pre-launch SiteGate: the password
 * typed into the gate (`SITE_PASSWORD`), and the invite keys carried in the
 * `?invite=` links we hand out (`SITE_ACCESS_KEYS`, comma-separated). Both open
 * the same gate. Keys are kept separate from the password so a link can be
 * revoked — by dropping it from the list — without rotating the password out
 * from under everyone who types it. Read at call time, not at import, so tests
 * can set the vars and a redeploy picks up an edited list.
 */

/** An unset or empty secret must never open the gate, so it matches nothing. */
export function matchesSitePassword(candidate: string): boolean {
	const expected = process.env.SITE_PASSWORD ?? "";
	return expected !== "" && candidate === expected;
}

export function matchesInviteKey(candidate: string): boolean {
	const keys = (process.env.SITE_ACCESS_KEYS ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter((key) => key !== "");
	return keys.includes(candidate);
}
