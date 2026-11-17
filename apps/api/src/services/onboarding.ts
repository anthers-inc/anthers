// SPDX-License-Identifier: Apache-2.0
/**
 * What an account has done, for the two onboarding checklists, and the only writer of
 * their dismissal timestamps.
 *
 * ⭐ **The checklists are orientation, not gates, and these are the facts their rows
 * stand on.** The user's checklist points somebody at the app's parts and the creator's
 * follows the publishing gate with the steps that make a catalog; neither may claim a row
 * is done because a button was clicked, so each answer here is a count of the thing
 * itself. `SetupChecklist`'s docblock carries the same rule from the component's side.
 *
 * ⚠️ **Saving is not the Library's row count.** A creator's own Works join the Library at
 * creation (`services/library.ts`), so counting every row would check the user's "save
 * something" on an account that has only ever made something. The saved count excludes
 * Works whose `creatorId` is the account, which is exactly the set that arrives without a
 * save; a Post or a Project in the Library was saved by the person, since nothing inserts
 * those on their behalf.
 *
 * The counts are deliberately small and indexed: Discovery and the Studio's Works page
 * each ask once when they mount, and neither asks again until the page does.
 */
import { db } from "@anthers/db/client";
import {
	badges,
	follows,
	posts,
	userLibraryItems,
	userPreferences,
	works,
} from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { badgeOwnedBy } from "./badge-owners.js";
import { workOwnedBy } from "./work-owners.js";

/** Which checklist a dismissal applies to. */
export type OnboardingChecklist = "reader" | "creator";

/** The account facts both checklists derive their rows from. */
export interface OnboardingFacts {
	/** Creators this account follows. */
	following: number;
	/** Things in the Library that the account saved rather than made. */
	saved: number;
	/** Works the account owns, including ones it co-owns. */
	works: number;
	/** Of those, the ones that have been released at least once. */
	releasedWorks: number;
	/** Posts the account has written, drafts included. */
	posts: number;
	/** Rungs the account owns on a Badge ladder, its own and accepted co-ownerships. */
	badges: number;
}

/**
 * The account's onboarding facts, in one round of parallel counts.
 *
 * A single failed count fails the request rather than answering a half-truth; the client
 * treats a failed read as "not answered yet" and draws no checklist at all, which is also
 * what it does before the first answer lands.
 */
export async function onboardingFactsFor(userId: number): Promise<OnboardingFacts> {
	const [followed, saved, made, written, ladder] = await Promise.all([
		db
			.select({ n: sql<number>`count(*)::int` })
			.from(follows)
			.where(eq(follows.followerId, userId)),
		db
			.select({ n: sql<number>`count(*)::int` })
			.from(userLibraryItems)
			.leftJoin(works, eq(works.id, userLibraryItems.workId))
			.where(
				and(
					eq(userLibraryItems.userId, userId),
					// A row with no Work is a Post or a Project, and a null `creatorId`
					// there is distinct from the account, so it counts. A Work the account
					// created (the one `saveOwnWork` inserts) does not.
					sql`${works.creatorId} IS DISTINCT FROM ${userId}`,
				),
			),
		db
			.select({
				total: sql<number>`count(*)::int`,
				released: sql<number>`count(*) filter (where ${works.releasedAt} is not null)::int`,
			})
			.from(works)
			.where(workOwnedBy(userId)),
		db.select({ n: sql<number>`count(*)::int` }).from(posts).where(eq(posts.creatorId, userId)),
		db.select({ n: sql<number>`count(*)::int` }).from(badges).where(badgeOwnedBy(userId)),
	]);

	return {
		following: followed[0]?.n ?? 0,
		saved: saved[0]?.n ?? 0,
		works: made[0]?.total ?? 0,
		releasedWorks: made[0]?.released ?? 0,
		posts: written[0]?.n ?? 0,
		badges: ladder[0]?.n ?? 0,
	};
}

/**
 * Put one checklist away for good.
 *
 * ⚠️ **Write-once in effect, not enforced as write-once.** The route is the only caller
 * and a second dismiss writes a new moment, which changes nothing the card reads (whether
 * a timestamp exists). Refusing a repeat would buy nothing and would need a read first.
 *
 * Insert-or-update, like every other `user_preferences` write: an account with no row sets
 * its first preference here without a separate creation step.
 */
export async function dismissChecklist(
	userId: number,
	which: OnboardingChecklist,
): Promise<{ dismissedAt: Date }> {
	const dismissedAt = new Date();
	const write =
		which === "reader"
			? { readerChecklistDismissedAt: dismissedAt }
			: { creatorChecklistDismissedAt: dismissedAt };
	await db
		.insert(userPreferences)
		.values({ userId, ...write })
		.onConflictDoUpdate({
			target: userPreferences.userId,
			set: { ...write, updatedAt: dismissedAt },
		});
	return { dismissedAt };
}
