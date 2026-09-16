// SPDX-License-Identifier: Apache-2.0
/**
 * Content-model bounds shared by the API and every client.
 *
 * These live here rather than in `constants.ts` because that file is the
 * economics dials — the docs point at it as the source of truth for the model —
 * and mixing text-length limits into it muddies what it's for. They're shared at
 * all so the textarea's `maxLength` and the server's validator can't drift: a
 * client that lets someone type 2,000 characters into a 1,000-character field
 * turns a validation rule into lost work.
 */

/**
 * A review carries a verdict AND written text — a verdict can't be left on its own.
 *
 * The minimum is deliberately low, and it is not a quality filter: it's a blunt
 * instrument, and "lol" clears any threshold worth setting. The reason to require
 * text at all is that a written verdict gives a reader something to weigh and a
 * moderator something to act on, where a bare thumb is unmoderatable by
 * construction. Raising this to chase quality would mostly punish the terse.
 */
export const REVIEW_MIN = 4;
export const REVIEW_MAX = 5000;

/**
 * A review's verdict: whether the reviewer recommends the work.
 *
 * 🚨 **A verdict rather than a score on a scale** (Parker, 2026-09-12). A star
 * rating asks each person to convert a feeling into a number, which they do
 * inconsistently and mostly by picking an extreme — the distribution comes out
 * J-shaped, so the extra resolution measures nothing. Averaging it is worse
 * than useless: a mean of ordinal answers assumes the gap between 3 and 4
 * equals the gap between 4 and 5, and it does not, least of all across people.
 * A yes-or-no leaves the nuance to the aggregate, where "94% recommended" is a
 * proportion — an honest statistic rather than arithmetic performed on guesses.
 *
 * ⭐ **It also gives Anthers one opinion primitive instead of two.** Everything
 * else here aggregates up and down votes; a second, differently-shaped way to
 * say "I liked this" is a thing every reader would have to learn twice.
 *
 * ⚠️ **A string and not a boolean, and the reason is permanence.** A boolean's
 * type could never grow, and this is the record most likely to want a middle
 * verdict one day. The published Lexicon carries the same two values as an open
 * set, so adding a third is a value rather than a schema change. Somebody who
 * feels neither is meant to post nothing — posting a review is an action, and
 * having it mean something is the point.
 */
export const REVIEW_VERDICTS = ["recommended", "not-recommended"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
	return typeof v === "string" && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

/**
 * How a verdict reads to a person. Title case, because it labels a thing rather
 * than saying something about one.
 *
 * ⚠️ An unrecognized verdict is returned as-is rather than guessed at. The
 * published set is open, so a value this build has never heard of is a record
 * from a later version rather than corruption, and showing it verbatim is more
 * honest than folding it into one of the two we know.
 */
export function verdictLabel(verdict: string): string {
	if (verdict === "recommended") return "Recommended";
	if (verdict === "not-recommended") return "Not Recommended";
	return verdict;
}

/**
 * The share of visible reviews that recommend a work, 0–100, or null when there
 * are none.
 *
 * ⚠️ **Every review counts once.** Helpfulness sorts the list and does not
 * weight the aggregate: a review somebody found useful is not a stronger
 * recommendation, it is an easier one to read. If that ever changes it would
 * only be to stop counting reviews voted net-unhelpful, which is a different
 * thing from scaling their contribution.
 */
export function recommendedPercent(recommended: number, total: number): number | null {
	if (total <= 0) return null;
	return Math.round((recommended / total) * 100);
}

/** A comment's body. Matches the limit the comment route has always enforced. */
export const COMMENT_MAX = 10000;

/**
 * What a comment is attached to.
 *
 * Distinct from `ModerationSubjectType`, which is what gets *moderated* (a comment, a
 * review). This is what a comment hangs off: a **Post** — discussion of an announcement —
 * or a **Work** — discussion of the thing itself. Both are real and they are not the same
 * conversation, which is why the column is polymorphic rather than one or the other.
 */
export type CommentSubjectType = "post" | "work";

export const COMMENT_SUBJECT_TYPES: readonly CommentSubjectType[] = ["post", "work"];

export function isCommentSubjectType(value: string): value is CommentSubjectType {
	return (COMMENT_SUBJECT_TYPES as readonly string[]).includes(value);
}

/** The longest embed address a game or software Work may carry. */
export const EMBED_URL_MAX = 500;

/** The domain Anthers serves itself from. Nothing under it may be embedded as a Work's build. */
const ANTHERS_DOMAIN = "anthers.org";

/**
 * Why an embed address for a game or software Work cannot be used, or null when it can. An empty
 * address is fine and means the Work has no browser build.
 *
 * The address becomes the `src` of the Work page's "Play in Browser" iframe, so the server
 * refuses a bad one on the way in, the serializer refuses to hand one out, and the Studio form
 * shows the same reason before anybody submits.
 *
 * 🚨 **https only, and the check is here rather than trusted to the renderer.** React replaces a
 * `javascript:` URL in `src` with one that throws, but without this check that would be the only
 * thing stopping a creator's script from running as Anthers in every viewer's browser, and a
 * protection that important belongs in code Anthers owns. A plain `http:` build would be blocked
 * as mixed content on an https page anyway.
 *
 * 🚨 **Nothing on Anthers' own domain.** The iframe's sandbox allows both scripts and same-origin
 * access, because a real web build keeps its saves in its own origin's storage and breaks
 * without that. That combination is safe only while the framed page has an origin different from
 * the page framing it: a same-origin page can reach into its parent and remove its own sandbox.
 * No creator file is served from Anthers' own origin today, so refusing the domain costs nothing
 * and keeps a future route that serves one from turning into a sandbox escape. Hosting builds on
 * Anthers will need a separate origin for them rather than an exception here.
 */
export function embedUrlProblem(value: string): string | null {
	if (value === "") return null;
	if (value.length > EMBED_URL_MAX) {
		return `The embed address can be at most ${EMBED_URL_MAX} characters.`;
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "Enter the full address of the page that runs the build, starting with https://.";
	}
	if (url.protocol !== "https:") return "The embed address has to start with https://.";
	const host = url.hostname.toLowerCase();
	if (host === ANTHERS_DOMAIN || host.endsWith(`.${ANTHERS_DOMAIN}`)) {
		return `The embed has to be hosted on another site, not on ${ANTHERS_DOMAIN}.`;
	}
	return null;
}
