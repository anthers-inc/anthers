// SPDX-License-Identifier: AGPL-3.0-or-later
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
 * A review carries a score AND written text — a score can't be left on its own.
 *
 * The minimum is deliberately low, and it is not a quality filter: it's a blunt
 * instrument, and "lol" clears any threshold worth setting. The reason to require
 * text at all is that a written verdict gives a reader something to weigh and a
 * moderator something to act on, where a bare 1-star is unmoderatable by
 * construction. Raising this to chase quality would mostly punish the terse.
 */
export const REVIEW_MIN = 4;
export const REVIEW_MAX = 5000;

/** A comment's body. Matches the limit the comment route has always enforced. */
export const COMMENT_MAX = 10000;
