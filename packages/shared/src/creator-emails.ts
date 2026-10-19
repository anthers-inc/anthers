// SPDX-License-Identifier: Apache-2.0
/**
 * The creator emails Anthers sends, and the one place their preference vocabulary lives.
 *
 * These are the transaction mails a creator can turn off from the Studio's Communications
 * table: a sale on their work, a refund on one, and a payout to their balance. They are
 * `none` or `email` — there is no app-notification counterpart for a receipt, so a second
 * value would be a control that means nothing.
 *
 * ⚠️ **A missing key means `email`.** The default is on, and "never answered" is not a no —
 * the same reading every nullable preference column in this codebase gives. The stored map
 * carries only the kinds somebody has actually turned off.
 */
export const CREATOR_EMAIL_KINDS = ["sale", "refund", "payout"] as const;

export type CreatorEmailKind = (typeof CREATOR_EMAIL_KINDS)[number];

export type CreatorEmailMode = "email" | "none";

/** What every kind starts at, and what an absent key resolves to. */
export const CREATOR_EMAIL_DEFAULT: CreatorEmailMode = "email";

/** The stored map: only the kinds a creator has answered. */
export type CreatorEmailDelivery = Partial<Record<CreatorEmailKind, CreatorEmailMode>>;

/** Resolve one kind's mode, with the default story in one place. */
export function resolvedCreatorEmailMode(
	map: Record<string, string> | null | undefined,
	kind: CreatorEmailKind,
): CreatorEmailMode {
	return map?.[kind] === "none" ? "none" : CREATOR_EMAIL_DEFAULT;
}

/** Resolve every kind, in registry order — what the settings table renders. */
export function resolvedCreatorEmailDelivery(
	map: Record<string, string> | null | undefined,
): Record<CreatorEmailKind, CreatorEmailMode> {
	return Object.fromEntries(
		CREATOR_EMAIL_KINDS.map((kind) => [kind, resolvedCreatorEmailMode(map, kind)]),
	) as Record<CreatorEmailKind, CreatorEmailMode>;
}
