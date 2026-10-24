// SPDX-License-Identifier: Apache-2.0
/**
 * Who counts as a verified creator.
 *
 * `isCreator` is a self-serve switch that any account with a verified email can turn on, so
 * it says what somebody wants the Studio for rather than what they have made. A surface that
 * claims somebody is a creator — the Discord server's creators-only channels are the first —
 * needs the stronger claim, and this is its one definition so that no feature invents another.
 *
 * 🚨 **A Work, not a post.** Posts announce; Works carry access. Publishing a post says
 * nothing about whether a creator has made a thing, so an account with ten posts and no Work
 * is not verified.
 *
 * ⚠️ **This is the rule, not the query.** `releasedWorkCount` arrives from the caller because
 * the shared package cannot reach the database; `services/creator-standing.ts` is the one
 * place that answers it, and it counts `works.released_at` rather than `visibility` so that a
 * withdrawn Work still counts.
 */
export type CreatorStanding = {
	isCreator: boolean | null;
	/** Released Works the account owns — `works.released_at` set, withdrawn included. */
	releasedWorkCount: number;
};

export function verifiedCreator({ isCreator, releasedWorkCount }: CreatorStanding): boolean {
	return isCreator === true && releasedWorkCount > 0;
}
