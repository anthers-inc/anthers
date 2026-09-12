// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mapping a creator's posts and projects onto the records that describe them.
 *
 * Pure functions that write nothing, for the reason `atproto-records.ts` gives: a Lexicon
 * nobody has mapped real rows onto is a guess. A Work's listing lives in that file; these are
 * the two records beside it.
 *
 * 🚨 **A post record is not the post.** `org.anthers.post` carries a link, a date, and
 * whatever of the post anybody may read — never a deliverable, and never a claim about who
 * may reach the thing it points at.
 */

/** Why a creator's row has no record. Returned rather than thrown: not every row has one. */
export type UnpublishableCreatorReason = "no_creator" | "not_published" | "missing_title";

// ── Post ─────────────────────────────────────────────────────────────────────────────────

/** The post columns a record is derived from. Deliberately narrow. */
export interface PublishablePost {
	creatorId: number | null;
	slug: string;
	publicId: number;
	publishedAt: Date | null;
}

export interface PostRecord {
	$type: "org.anthers.post";
	url: string;
	publishedAt: string;
	content?: { format: string; value: string };
}

/**
 * Whether a post may be described on the network.
 *
 * ⚠️ **A post with no creator is a tombstone rather than a draft.** `posts.creator_id` is
 * `set null` on account deletion, because deleting a departing creator's posts would destroy
 * the comment threads other people wrote under them. There is no repository left to write
 * into, so the record is refused rather than written somewhere it does not belong.
 *
 * 🚨 **An unpublished post is a draft, and publishing one would put somebody's unfinished
 * writing on a network with no way to take it back.** `published_at` is the test rather than
 * any scheduling column: a scheduled post is still a draft until the sweep publishes it.
 */
export function unpublishablePostReason(post: PublishablePost): UnpublishableCreatorReason | null {
	if (post.creatorId === null) return "no_creator";
	if (!post.publishedAt) return "not_published";
	return null;
}

/** The canonical page for a post. Mirrors the app's `/posts/{slug}-{publicId}` route. */
export function postUrl(post: PublishablePost, baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/posts/${post.slug}-${post.publicId}`;
}

/**
 * Build the record for a post, or `null` when it must not have one.
 *
 * 🚨 **`content` is deliberately absent, and it is absent because there is nothing to put in
 * it yet.** The Lexicon publishes content as markdown; a post is authored in TipTap and
 * stored as sanitized HTML in `body_html`, with `body` kept as a plain-text shadow for
 * search. Converting HTML to markdown here would make the mapper the place a lossy
 * conversion happens on every write, invisibly, rather than once where somebody decided it.
 * Until the stored form is markdown, a post record is a listing — which the schema allows,
 * because `content` is optional precisely so this could ship without it.
 */
export function postToRecord(post: PublishablePost, opts: { baseUrl: string }): PostRecord | null {
	if (unpublishablePostReason(post) !== null) return null;
	// Re-derived rather than asserted, so the two cannot drift into a lie.
	if (!post.publishedAt) return null;
	return {
		$type: "org.anthers.post",
		url: postUrl(post, opts.baseUrl),
		publishedAt: post.publishedAt.toISOString(),
	};
}

// ── Project ──────────────────────────────────────────────────────────────────────────────

/** The project columns a record is derived from. */
export interface PublishableProject {
	creatorId: number | null;
	slug: string;
	title: string;
	description: string | null;
}

export interface ProjectRecord {
	$type: "org.anthers.project";
	title: string;
	url: string;
	description?: string;
}

/**
 * Whether a project may be described on the network.
 *
 * ⚠️ **An untitled project gets no record, on the same reasoning that refuses an untitled
 * Work**: the Lexicon requires a title, and `title ?? ""` would satisfy that structurally
 * while naming nothing at all — an anonymous entry in somebody's public catalog.
 */
export function unpublishableProjectReason(
	project: PublishableProject,
): UnpublishableCreatorReason | null {
	if (project.creatorId === null) return "no_creator";
	if (!project.title?.trim()) return "missing_title";
	return null;
}

/** The canonical page for a project. Mirrors the app's `/projects/{slug}` route. */
export function projectUrl(project: PublishableProject, baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/projects/${project.slug}`;
}

/**
 * Build the record for a project, or `null` when it must not have one.
 *
 * 🚨 **It carries no list of what is in it, and that is the design rather than an omission.**
 * A record naming its own contents has to be rewritten every time a work is added or removed,
 * which broadcasts a new version on every change and makes the record a worse copy of a
 * query. Membership belongs on the other end, as an optional field on the work — and an
 * optional field may be added to a published schema whenever it is wanted.
 */
export function projectToRecord(
	project: PublishableProject,
	opts: { baseUrl: string },
): ProjectRecord | null {
	if (unpublishableProjectReason(project) !== null) return null;

	const record: ProjectRecord = {
		$type: "org.anthers.project",
		title: project.title,
		url: projectUrl(project, opts.baseUrl),
	};
	// An empty string is not a value: writing `description: ""` says the creator wrote an
	// empty description, where absence says they wrote none.
	if (project.description?.trim()) record.description = project.description;
	return record;
}
