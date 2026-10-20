// SPDX-License-Identifier: Apache-2.0
/**
 * The schedule panel's listing — what the creator has set to go out on its own, and when.
 *
 * 🚨 **Everything here is purely informational, and that is the line it inherits from
 * `studio-panels.ts`.** A scheduled item that would be refused if its time fired right now
 * — an unrated Work, payout setup that has lapsed — is not marked here: the worklist above
 * already names every such condition, keyed on `visibility !== "released"`, which covers a
 * scheduled Work, and the publish sweep clears a scheduled post's date rather than publishing
 * through a refusal. A panel may not warn; a schedule row that carries the warning would be a
 * hideable warning, which is exactly the mistake this module sits below.
 *
 * Pure and kept out of the component that renders it, for the same reason `studio-worklist.ts`
 * is: whether a Work's release time has passed is a fact about the data, not the screen, and
 * a drifted condition renders a plausible schedule — an empty one — that nothing would catch.
 */

import type { PostListItem, Work } from "../../lib/types";

export interface ScheduleItem {
	/** What goes out: a Work's release, or a post's auto-publish. */
	kind: "release" | "post";
	/** Stable React key: the kind plus the row's id, which it never shares with the other kind. */
	id: `release-${number}` | `post-${number}`;
	title: string;
	/** Where the schedule is set — the one place a creator changes it. */
	href: string;
	/** ISO datetime the item goes out at. */
	at: string;
	/**
	 * True when the time has passed and the Work is still here. A release whose time has
	 * passed while its file is still uploading, processing or being checked goes out the
	 * moment it is ready rather than late — the Works row already says so, and the panel
	 * says the same thing instead of a date it cannot promise.
	 */
	waiting: boolean;
}

export interface ScheduleInput {
	works: Work[];
	posts: PostListItem[];
	/** The Studio path for one Work's editor, where its release time is set. */
	editWorkUrl: (work: Work) => string;
	/** The Studio path for one post's editor, where its publish time is set. */
	editPostUrl: (post: PostListItem) => string;
	/** The clock the `waiting` test runs against; the present moment by default. */
	now?: Date;
}

/**
 * Every scheduled thing, soonest first — a past-due release therefore leads the list, since
 * it is closest to going out. Released Works and published or unscheduled posts are not on a
 * schedule and are left out.
 */
export function buildSchedule({
	works,
	posts,
	editWorkUrl,
	editPostUrl,
	now = new Date(),
}: ScheduleInput): ScheduleItem[] {
	const items: ScheduleItem[] = [];

	for (const work of works) {
		if (work.visibility === "released" || !work.scheduledReleaseAt) continue;
		items.push({
			kind: "release",
			id: `release-${work.id}`,
			title: work.title || "Untitled",
			href: editWorkUrl(work),
			at: work.scheduledReleaseAt,
			waiting: Date.parse(work.scheduledReleaseAt) <= now.getTime(),
		});
	}

	for (const post of posts) {
		if (post.isPublished || !post.scheduledFor) continue;
		items.push({
			kind: "post",
			id: `post-${post.id}`,
			title: post.displayTitle || post.title || "Untitled",
			href: editPostUrl(post),
			at: post.scheduledFor,
			waiting: false,
		});
	}

	return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
