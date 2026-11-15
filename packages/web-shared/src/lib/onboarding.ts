// SPDX-License-Identifier: Apache-2.0
/**
 * The two onboarding checklists' rows, derived from the account's own facts, and the call
 * that puts a card away.
 *
 * ⭐ **A row is done because the thing it names happened, never because it was clicked.**
 * `SetupChecklist`'s docblock carries the same rule from the component's side, and
 * `services/onboarding.ts` is where the facts come from. The rows therefore split into
 * account facts the boot payload already carries (a picture, a line about you, creator
 * mode) and counts this module fetches (followed creators, saved things, Works, posts,
 * Badges).
 *
 * ⭐ **The reader's checklist is orientation and the creator's is momentum.** The reader's
 * four rows each name a part of the app and open it, and none of them gates anything;
 * the creator's five follow the publishing gate and stop at the point a catalog exists.
 * Neither is a conversion surface: nothing here asks for money, and the creator's Badge
 * row is about their own support ladder rather than about supporting Anthers.
 */

import { useEffect, useState } from "react";
import type { SetupChecklistItem } from "../components/ui/SetupChecklist";
import type { User } from "./auth";
import { profileUrl } from "./profile";
import { client } from "./rpc";
import { studioNewPostUrl, studioNewWorkUrl, studioUrl } from "./studio";

/** What `GET /api/accounts/me/onboarding` answers; mirrors `OnboardingFacts` in the API. */
export interface OnboardingFacts {
	following: number;
	saved: number;
	works: number;
	releasedWorks: number;
	posts: number;
	badges: number;
}

/** Which checklist the dismissal applies to. */
export type OnboardingChecklist = "reader" | "creator";

/**
 * The account's onboarding facts, read once on mount.
 *
 * ⚠️ **`null` means not answered yet, and no checklist draws until it is.** The counts
 * are what separate a done row from a todo one, so rendering before they arrive would
 * show a brand-new creator a list of things they have already done. A failed request
 * leaves the answer null, which reads the same way: the card simply does not appear.
 */
export function useOnboardingFacts(): OnboardingFacts | null {
	const [facts, setFacts] = useState<OnboardingFacts | null>(null);

	useEffect(() => {
		let live = true;
		client.api.accounts.me.onboarding
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as OnboardingFacts;
				if (live) setFacts(data);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	return facts;
}

/**
 * Put one checklist away for good, and answer whether the server took it.
 *
 * The caller refreshes the account afterwards rather than trusting a local opinion: the
 * dismissal is a column on the account, and the next boot reads it.
 */
export async function dismissOnboardingChecklist(which: OnboardingChecklist): Promise<boolean> {
	try {
		const res = await client.api.accounts.me.onboarding.dismiss.$post({
			json: { checklist: which },
		});
		return res.ok;
	} catch {
		return false;
	}
}

/** What the reader checklist reads off the account itself rather than from a count. */
type ReaderProfile = Pick<User, "avatar" | "bio" | "creatorMode">;

/**
 * The reader's checklist: four parts of the app, each opened by its row.
 *
 * ⚠️ **Creator mode is an offer, not a step.** Every creator begins as a reader, but most
 * readers will never want the Studio, so the row says what the door is for and nothing
 * more. Its link goes to `/studio`, whose gate is already the place that explains creator
 * mode and leads to the switch.
 *
 * ⚠️ **The follow row has no door because the card stands where following happens.** The
 * checklist is drawn at the top of Discovery (`DiscoverPage`), and a row whose link
 * pointed back at the page the reader is on would be furniture pretending to be a control.
 * The row still names the act, so the part it teaches is the feed underneath it.
 */
export function readerChecklistItems(
	facts: OnboardingFacts,
	user: ReaderProfile,
): SetupChecklistItem[] {
	return [
		{
			key: "follow",
			label: "Follow a creator you want to see again",
			state: facts.following > 0 ? "done" : "todo",
		},
		{
			key: "save",
			label: "Save a Work or a post to your Library",
			state: facts.saved > 0 ? "done" : "todo",
			href: "/library",
		},
		{
			key: "profile",
			label: "Give your profile a picture and a line about you",
			state: user.avatar && user.bio ? "done" : "todo",
			href: "/settings?tab=account",
		},
		{
			key: "studio",
			label: "Open the Studio if you want to make something",
			state: user.creatorMode ? "done" : "todo",
			href: "/studio",
		},
	];
}

/** Whether every row on a list is done, which is when its card stops drawing. */
export function checklistComplete(items: SetupChecklistItem[]): boolean {
	return items.every((item) => item.state === "done");
}

/**
 * The creator's follow-up checklist: the steps that turn a publishing account into a
 * catalog people can find and support.
 *
 * A post counts once it exists at all, drafts included, because the row says *write* one;
 * the Work rows separate making from releasing, since an unreleased Work is the state
 * most first Works sit in.
 */
export function creatorChecklistItems(
	facts: OnboardingFacts,
	user: Pick<User, "avatar" | "bio" | "handle">,
): SetupChecklistItem[] {
	return [
		{
			key: "profile",
			label: "Add a picture and a line about you",
			state: user.avatar && user.bio ? "done" : "todo",
			href: "/settings?tab=account",
		},
		{
			key: "work",
			label: "Create your first Work",
			state: facts.works > 0 ? "done" : "todo",
			href: studioNewWorkUrl(),
		},
		{
			key: "release",
			label: "Release a Work so people can find it",
			state: facts.releasedWorks > 0 ? "done" : "todo",
			href: studioUrl("/works"),
		},
		{
			key: "post",
			label: "Write your first post",
			state: facts.posts > 0 ? "done" : "todo",
			href: studioNewPostUrl(),
		},
		{
			key: "badges",
			label: "Set up your Badges so people can support you monthly",
			state: facts.badges > 0 ? "done" : "todo",
			href: `${profileUrl(user.handle)}?tab=badges`,
		},
	];
}
