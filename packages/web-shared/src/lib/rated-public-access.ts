// SPDX-License-Identifier: Apache-2.0
/**
 * The note a creator meets when a Mature or Adult Work is about to be Public Access.
 *
 * 🚨 **It belongs to the Public Access choice and never to the rating** (Parker, 2026-09-18).
 * What a rating does to a Work's audience is kept away from the moment a creator chooses the
 * rating, because a consequence read while choosing invites picking the rung by its cost rather
 * than by what the work is — the under-declaring the wiki's *The Rating Standard* is built to
 * prevent. The note exists for a different reason: "Public Access" reads as "everyone will see
 * it", and a rated Work is not seen by everyone, so the place to say so is where Public Access
 * is chosen.
 *
 * ⚠️ **Any rung above General shows it, including one this build does not know.** A rung added
 * later will restrict its audience at least as much as Mature does, so the note fails toward
 * being shown.
 */

/**
 * Where the note points: the FAQ's answer on what readers control. It moves to *The Rating
 * Standard* once the wiki is served. `faq.test.ts` fails if the anchor stops naming a question.
 */
export const RATED_PUBLIC_ACCESS_HELP = "/faq#content-controls";

/** Whether the Work, as the form stands, is a released rated Work in Public Access. */
export function showsRatedPublicAccessNotice(state: {
	released: boolean;
	publicAccess: boolean;
	maturity: string | null;
}): boolean {
	return (
		state.released &&
		state.publicAccess &&
		state.maturity != null &&
		state.maturity !== "unrated" &&
		state.maturity !== "general"
	);
}
