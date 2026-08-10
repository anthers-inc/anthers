// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data-rights vocabulary — the kinds of request a person can make, and the window we
 * promised to answer in.
 *
 * Pure and shared, like `moderation.ts`, so the form a user fills in and the API that
 * validates it read one list. 51.05 states these rights and extends them to everyone
 * rather than branching by region.
 *
 * **Two of the six rights the policy names are deliberately absent here**, because
 * they are buttons rather than requests: *get a copy* is `GET /me/export` and *delete*
 * is `DELETE /me`. Routing a self-serve action through a 30-day queue would be worse
 * service dressed as more process, so the form points at them instead.
 */

export interface RightsRequestKind {
	value: string;
	label: string;
	hint: string;
}

export const RIGHTS_REQUEST_KINDS: readonly RightsRequestKind[] = [
	{
		value: "access",
		label: "Tell me what you hold about me",
		hint: "A written answer about what we have and why. For the data itself, use Download instead — it is immediate.",
	},
	{
		value: "rectification",
		label: "Correct something that is wrong",
		hint: "For anything you can't already edit in your settings.",
	},
	{
		value: "objection",
		label: "Object to how something is used",
		hint: "Tell us what you want us to stop doing, and why.",
	},
	{
		value: "portability",
		label: "Send my data somewhere else",
		hint: "Beyond the download — if you need it delivered to another service in a particular form.",
	},
	{
		value: "other",
		label: "Something else",
		hint: "Anything about your data that the options above don't cover.",
	},
] as const;

export const RIGHTS_REQUEST_KIND_VALUES: readonly string[] = RIGHTS_REQUEST_KINDS.map(
	(k) => k.value,
);

export function isRightsRequestKind(value: string): boolean {
	return RIGHTS_REQUEST_KIND_VALUES.includes(value);
}

/**
 * The response window, in days, as promised in 51.05.
 *
 * Stamped onto each request at creation rather than computed at read time, so changing
 * this number never silently moves a deadline already committed to.
 */
export const RIGHTS_RESPONSE_DAYS = 30;

export const RIGHTS_DETAILS_MAX = 2000;
