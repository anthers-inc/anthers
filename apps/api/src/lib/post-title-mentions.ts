// SPDX-License-Identifier: Apache-2.0
/**
 * Reading and writing `@` mentions of a Work in a Post's title — the server half of
 * `@anthers/shared/post-title`.
 *
 * 🚨 **Two rules decide every query here, and both are about the reader rather than the
 * author.** A mention resolves only to a Work the READER may see, so a post title can
 * never become a back door around the Adult rung or a block; and it resolves to the
 * Work's CURRENT name, so a retitle reaches every title that mentions it. A mention that
 * does not resolve falls back to the text the author stored, which is a name they typed
 * into a public title.
 *
 * The write path is the same rule with the author as the reader: a mention to a Work that
 * is not released, or that the author cannot see, is stripped to plain text before the
 * title is stored. That is deliberately a query against `works` rather than a shape check
 * — a client is not trusted to have picked from the picker.
 */

import { db } from "@anthers/db/client";
import { posts, works } from "@anthers/db/schema";
import {
	mentionedWorkPublicIds,
	postTitleSegments,
	resolvedPostTitle,
	workMentionMarkdown,
} from "@anthers/shared/post-title";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { notSuspendedAccount, notTestAccount } from "../services/account-visibility.js";
import { notBlockedBy } from "../services/blocks.js";
import { adultVisibility } from "../services/content-preferences.js";
import { parentalVisibility } from "../services/parental-controls.js";
import { pgWorkTitleMentionPattern } from "./post-work-links.js";

/** A Work a title may name: the durable id plus what a mention renders and links with. */
export interface MentionableWork {
	publicId: number;
	slug: string;
	title: string;
	/**
	 * The Work's thumbnail, or null.
	 *
	 * Carried because a post's tile shows the first Work its body embeds, and that image
	 * reaches the same audience a title does — so it answers to the same allow-list. A card
	 * that read `works` directly for the thumbnail would be showing the cover of an Adult
	 * Work to a reader the rung keeps from its existence.
	 */
	thumbnail: string | null;
}

/**
 * The Works among `publicIds` that `viewerId` may see, keyed by public id.
 *
 * 🚨 **This is a listing of Works and carries the full listing allow-list** on purpose.
 * A title is public, so resolving an Adult Work's name for an unverified reader would be
 * exactly the leak `maturityHiddenFrom` exists to prevent, and a blocked creator's Work
 * has no business appearing in a title either. Released-only is the other half: a draft
 * is not something a public post may name, its own author's included.
 */
export async function mentionableWorks(
	publicIds: number[],
	viewerId: number | null,
): Promise<Map<number, MentionableWork>> {
	const map = new Map<number, MentionableWork>();
	const ids = [...new Set(publicIds)];
	if (ids.length === 0) return map;

	const [adult, parental] = await Promise.all([
		adultVisibility(viewerId),
		parentalVisibility(viewerId),
	]);
	const rows = await db
		.select({
			publicId: works.publicId,
			slug: works.slug,
			title: works.title,
			thumbnail: works.thumbnail,
		})
		.from(works)
		.where(
			and(
				inArray(works.publicId, ids),
				eq(works.visibility, "released"),
				notBlockedBy(viewerId, works.creatorId),
				notSuspendedAccount(works.creatorId),
				notTestAccount(works.creatorId),
				adult.hidden,
				parental.hidden,
			),
		);
	for (const row of rows) {
		map.set(row.publicId, {
			...row,
			title: row.title ?? "",
			thumbnail: row.thumbnail === "" ? null : row.thumbnail,
		});
	}
	return map;
}

/**
 * The title as it will be stored: every mention's link rewritten to the Work's current
 * name, and a mention to a Work the author cannot publish about reduced to its plain
 * text. A title with no mentions is returned untouched, so the ordinary path pays one
 * cheap parse and no query.
 */
export async function canonicalizePostTitle(
	title: string | null | undefined,
	authorId: number,
): Promise<string | null | undefined> {
	if (!title) return title;
	const ids = mentionedWorkPublicIds(title);
	if (ids.length === 0) return title;

	const found = await mentionableWorks(ids, authorId);
	return postTitleSegments(title)
		.map((segment) => {
			if (segment.kind === "text") return segment.text;
			const work = found.get(segment.publicId);
			return work ? workMentionMarkdown(work) : segment.text;
		})
		.join("");
}

/**
 * The display titles for a page of posts, resolved in one lookup — the shape every list
 * serializer wants. `titles` may hold nulls; the result is parallel to it.
 */
export async function displayPostTitles(
	titles: Array<string | null | undefined>,
	viewerId: number | null,
): Promise<Array<string | null>> {
	const ids = [...new Set(titles.flatMap((title) => mentionedWorkPublicIds(title)))];
	const found = await mentionableWorks(ids, viewerId);
	return titles.map((title) =>
		title ? resolvedPostTitle(title, (id) => found.get(id)?.title) : (title ?? null),
	);
}

/** One title's display form — the detail route's convenience over the batch above. */
export async function displayPostTitle(
	title: string | null | undefined,
	viewerId: number | null,
): Promise<string | null> {
	const [display] = await displayPostTitles([title], viewerId);
	return display ?? null;
}

/** The Works a title names, resolved for the post page's linked heading. */
export async function mentionedWorksForTitle(
	title: string | null | undefined,
	viewerId: number | null,
): Promise<MentionableWork[]> {
	const ids = mentionedWorkPublicIds(title);
	if (ids.length === 0) return [];
	const found = await mentionableWorks(ids, viewerId);
	return ids.map((id) => found.get(id)).filter((work): work is MentionableWork => work != null);
}

/** One published post whose title names a Work, as the Showings panel lists it. */
export interface WorkMentioningPost {
	slug: string;
	publicId: number;
	title: string | null;
	/** The title with the Work's current name — `title` is the raw stored form. */
	displayTitle: string | null;
	publishedAt: Date | null;
}

/**
 * The published posts whose TITLE names this Work.
 *
 * The public id is in the title's link destination, so the same SQL pattern the body's
 * posting history uses finds it — no table, and no way for a mention and its record to
 * drift apart. Drafts are excluded: a mention in a draft has not been made in public.
 * The reader's blocks and the suspended/test accounts are the listing filters every
 * other surface uses.
 */
export async function postsMentioningWork(
	workPublicId: number,
	viewerId: number | null,
): Promise<WorkMentioningPost[]> {
	const rows = await db
		.select({
			slug: posts.slug,
			publicId: posts.publicId,
			title: posts.title,
			publishedAt: posts.publishedAt,
		})
		.from(posts)
		.where(
			and(
				eq(posts.isPublished, true),
				sql`${posts.title} ~ ${pgWorkTitleMentionPattern(workPublicId)}` as SQL,
				notSuspendedAccount(posts.creatorId),
				notTestAccount(posts.creatorId),
				notBlockedBy(viewerId, posts.creatorId),
			),
		)
		.orderBy(desc(posts.publishedAt))
		.limit(50);

	const displays = await displayPostTitles(
		rows.map((row) => row.title),
		viewerId,
	);
	return rows.map((row, index) => ({ ...row, displayTitle: displays[index] ?? row.title }));
}
