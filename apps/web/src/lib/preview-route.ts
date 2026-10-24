// SPDX-License-Identifier: Apache-2.0
/**
 * The document routes the web origin can describe, read from the path alone.
 *
 * The shell ships one site-level card because a folder of files cannot know which Work a
 * URL names. The server can, and this is the half that decides *which* it is: a Work's own
 * page, a post's permalink, or the share link a Work was pasted as. Each resolves to a card,
 * and each declares the document's own canonical address rather than the address it was
 * fetched at — a share link is a locator and never a page of its own, so `/s/{token}` must
 * not claim to be one.
 *
 * Resolution is here rather than in `serve.ts` because the path shapes are the thing worth
 * testing on their own: the fetches beside them need a live API, and a matcher that quietly
 * stopped matching after a route was renamed is exactly the failure this area exists to
 * avoid.
 */

/**
 * What a document path is about.
 *
 * `work` and `share` are the two shapes that can carry a card today. `null` is every other
 * route, which keeps the site card exactly as the shell shipped it.
 */
export type PreviewRoute =
	| {
			kind: "work";
			/** The route parameter the card endpoint accepts: `slug`, `slug-publicId`, or an id. */
			param: string;
			/** Where the Work canonically lives, as a path — a trailing slash is not one. */
			canonicalPath: string;
	  }
	| {
			kind: "post";
			/** The post's `slug` or `slug-publicId`, as the permalink carries it. */
			param: string;
			/** Where the post canonically lives, as a path. */
			canonicalPath: string;
	  }
	| {
			kind: "share";
			/** The opaque share token, which the API resolves to a Work. */
			token: string;
	  }
	| null;

/** `/works/{slug}-{publicId}` — a Work's own page. */
const WORK_PATH = /^\/works\/([^/]+)\/?$/;

/** `/posts/{slug}-{publicId}` — a post's permalink. */
const POST_PATH = /^\/posts\/([^/]+)\/?$/;

/**
 * `/s/{token}` — where a share link lands — and `/embed/{token}`, the same token rendered as
 * a player. The server answers both with the Work's card, because the address a sharer
 * actually pastes is the share link, not the page it points at.
 */
const SHARE_PATH = /^\/(?:s|embed)\/([^/]+)\/?$/;

export function previewRoute(pathname: string): PreviewRoute {
	const work = WORK_PATH.exec(pathname);
	if (work) return { kind: "work", param: work[1], canonicalPath: `/works/${work[1]}` };
	const post = POST_PATH.exec(pathname);
	if (post) return { kind: "post", param: post[1], canonicalPath: `/posts/${post[1]}` };
	const share = SHARE_PATH.exec(pathname);
	if (share) return { kind: "share", token: share[1] };
	return null;
}
