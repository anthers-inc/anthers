// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What a like and a dislike add up to, and when a comment folds away.
 *
 * ⭐ **One number is published, and it is the net** (Parker, 2026-09-04). Neither count is
 * shown on its own: a dislike does visible work by pulling the score down, and a pile-on
 * gets no dislike counter to run up. Parker rejected hiding the dislike outright —
 * *"YouTube's decision to not show dislikes is pretty universally disdained by audiences…
 * Having a dislike that has no visible impact on a value the user can see is the worst case
 * scenario."*
 *
 * 🚨 **Everything that decides an order is a number the reader can see** (Parker,
 * 2026-09-04: *"there's nothing ranking stuff that the users can't see"*). That is why
 * `commentScore` is what sorts as well as what renders. Sorting on the *true* net while
 * showing the floored one would order two comments that both display `0` by a difference
 * nobody can observe — invisible ranking, arrived at by accident, in the exact range where
 * a reader most wants to know what happened.
 *
 * ⚠️ **So the floor is a display rule and the true net is still needed.** `netScore` is what
 * the collapse threshold and moderation read, and it goes negative. Storing or sorting the
 * floored value would throw away the only signal that separates a mildly unpopular comment
 * from a buried one.
 */

/** A person's reaction to one thing. `+1` likes it, `-1` dislikes it. */
export type ReactionValue = 1 | -1;

export function isReactionValue(v: unknown): v is ReactionValue {
	return v === 1 || v === -1;
}

/** The like and dislike totals for one subject. */
export interface ReactionTally {
	likes: number;
	dislikes: number;
}

/**
 * The true net, which goes negative.
 *
 * Internal to ranking, collapsing and moderation — never published on its own, because a
 * negative number published beside a comment is the pile-on scoreboard the floor exists to
 * withhold. The one place a reader meets it is on a comment that has already collapsed,
 * where it is the stated reason rather than a running tally.
 */
export function netScore(t: ReactionTally): number {
	return t.likes - t.dislikes;
}

/**
 * The score as published, and as sorted on. Floored at zero.
 *
 * 🚨 **Sort by this, not by `netScore`.** They differ only below zero, which is precisely
 * where sorting on the unpublished one would be ranking by something invisible. Below zero
 * every comment is equally "at zero" and falls back to recency, and the ones that have gone
 * far enough are collapsed — which is a visible state rather than a hidden position.
 */
export function commentScore(t: ReactionTally): number {
	return Math.max(0, netScore(t));
}

/**
 * How far below zero a comment goes before it folds away.
 *
 * ⚠️ **A dial, and today it is a guess.** Anthers has no traffic yet, so there is no
 * distribution to set this against; -5 is chosen because it cannot be reached without at
 * least five separate accounts disliking and nobody liking. 🚨 **Five accounts is not many**,
 * and collapsing is the one reaction behavior that removes something from view, so this
 * number wants revisiting against real threads rather than being left where a pre-launch
 * guess put it.
 */
export const COLLAPSE_NET_THRESHOLD = -5;

/**
 * Whether a comment folds away, given its tally.
 *
 * ⚠️ **Collapsed is neither hidden nor deleted, and the three must never look alike.** A
 * moderation removal is `moderation_status` and never reaches a reader at all; a tombstone
 * is an author who left. This is a comment the readers pushed down, it stays in the thread,
 * it says why, and anyone can open it. Conflating it with either of the others would have
 * Anthers telling people a moderator acted when the crowd did.
 */
export function isCollapsed(t: ReactionTally): boolean {
	return netScore(t) <= COLLAPSE_NET_THRESHOLD;
}

/**
 * How many reactions one account may cast in `REACTION_WINDOW_MS`.
 *
 * ⚠️ **This bounds one account spraying a thread and nothing more.** The unique index makes
 * a single person's vote on a single item structural, and this stops that person walking a
 * hundred comments in a minute. 🚨 **Neither touches the actual threat**, which is many
 * accounts arriving together — that is a moderation and account-provenance problem, and
 * saying so here is better than a cap that implies it was solved.
 */
export const REACTION_WINDOW_MS = 60 * 1000;
export const REACTION_MAX_PER_WINDOW = 30;
