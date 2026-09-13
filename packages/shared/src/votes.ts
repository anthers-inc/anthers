// SPDX-License-Identifier: Apache-2.0
/**
 * What an upvote and a downvote add up to, and when a comment folds away.
 *
 * ⭐ **One number is published, and it is the net** (Parker, 2026-09-04). Neither count is
 * shown on its own: a downvote does visible work by pulling the score down, and a pile-on
 * gets no downvote counter to run up. Parker rejected hiding the downvote outright —
 * *"YouTube's decision to not show dislikes is pretty universally disdained by audiences…
 * Having a dislike that has no visible impact on a value the user can see is the worst case
 * scenario."*
 *
 * ⭐ **A vote is named for its effect rather than for a feeling** (Parker, 2026-09-12). It is
 * the input to ranking — *more people should see this*, or *fewer should* — and calling it
 * approval invites the bind where somebody withholds a vote from work they think is important
 * but did not enjoy. Both directions are published as records; what Anthers shows is the net
 * below, and a creator sees the raw counts.
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
 *
 * ⚠️ **Nothing weights a vote** (Parker, 2026-09-12). Every vote is one unit, a Sticker is
 * chrome that may highlight something and never moves it up the ranking, and there is no plan
 * to weight one by Badge or by anything else. A weighted vote would be rival — it would take
 * ranking position from other people's votes, on content the payer did not make — so
 * re-opening it is a values decision rather than a tuning one.
 */

/** Which way a person wants one thing to move. */
export type VoteDirection = "up" | "down";

export function isVoteDirection(v: unknown): v is VoteDirection {
	return v === "up" || v === "down";
}

/** The upvote and downvote totals for one subject. */
export interface VoteTally {
	up: number;
	down: number;
}

/**
 * The true net, which goes negative.
 *
 * Internal to ranking, collapsing and moderation — never published on its own, because a
 * negative number published beside a comment is the pile-on scoreboard the floor exists to
 * withhold. The one place a reader meets it is on a comment that has already collapsed,
 * where it is the stated reason rather than a running tally.
 */
export function netScore(t: VoteTally): number {
	return t.up - t.down;
}

/**
 * The score as published, and as sorted on. Floored at zero.
 *
 * 🚨 **Sort by this, not by `netScore`.** They differ only below zero, which is precisely
 * where sorting on the unpublished one would be ranking by something invisible. Below zero
 * every comment is equally "at zero" and falls back to recency, and the ones that have gone
 * far enough are collapsed — which is a visible state rather than a hidden position.
 */
export function commentScore(t: VoteTally): number {
	return Math.max(0, netScore(t));
}

/**
 * How far below zero a comment goes before it folds away.
 *
 * ⚠️ **A dial, and today it is a guess.** Anthers has no traffic yet, so there is no
 * distribution to set this against; -5 is chosen because it cannot be reached without at
 * least five separate accounts downvoting and nobody upvoting. 🚨 **Five accounts is not
 * many**, and collapsing is the one way a vote removes something from view, so this number
 * wants revisiting against real threads rather than being left where a pre-launch guess put
 * it — possibly as a proportional rule, or one weighted by account age (Parker, 2026-09-12).
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
export function isCollapsed(t: VoteTally): boolean {
	return netScore(t) <= COLLAPSE_NET_THRESHOLD;
}

/**
 * How many votes one account may cast in `VOTE_WINDOW_MS`.
 *
 * ⚠️ **This bounds one account spraying a thread and nothing more.** The unique index makes
 * a single person's vote on a single item structural, and this stops that person walking a
 * hundred comments in a minute. 🚨 **Neither touches the actual threat**, which is many
 * accounts arriving together — that is a moderation and account-provenance problem, and
 * saying so here is better than a cap that implies it was solved.
 */
export const VOTE_WINDOW_MS = 60 * 1000;
export const VOTE_MAX_PER_WINDOW = 30;
