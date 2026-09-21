// SPDX-License-Identifier: Apache-2.0
/**
 * Reviews on a Work — the aggregates, the written reviews, and the form.
 *
 * A verdict cannot be left on its own: choosing one opens a required text field, and nothing
 * is submitted until there are words. That is a deliberate trade of volume for substance —
 * most Works will carry no reviews for a long while, and an honest "no reviews yet" beats a
 * percentage assembled from three drive-by clicks. It also gives moderation something to act
 * on, where a bare thumb is unmoderatable by construction.
 *
 * ⭐ **The aggregate is a proportion and not an average**, because a review recommends a Work
 * or does not. `@anthers/shared/content` carries why, and it is the same reasoning that gives
 * Anthers one opinion primitive rather than two. It comes in two rows — **All Time** over every
 * review, and a **Recent** share over a reader-chosen window — so a Work that changed after
 * release can be seen to have changed its readers' minds. All Time is always the constant; the
 * Recent share simply has nothing to say (and says so) when its window holds too few reviews.
 *
 * ⭐ **The list sorts by helpfulness, not by when the review was written** (2026-09-12). What
 * a reader finds worth reading is what other readers found helpful, so the default is Helpful
 * First with Newest First as the explicit alternative — neither is a re-fetch; both are this
 * payload read two ways. Helpfulness is the same vote a post or a comment takes, asked here as
 * "was this helpful?" — and it only ever *sorts*; one person's review counts once in either
 * share however many votes it drew. A new review's `1` is its author's own upvote — posting
 * something says the author thinks it worth reading, so `0` always means a reader said no.
 *
 * Bodies render as React text nodes, never as markup — the API stores plain text and nothing
 * here interprets it.
 */

import {
	REVIEW_MAX,
	REVIEW_MIN,
	REVIEW_WINDOWS,
	type ReviewWindow,
	verdictLabel,
} from "@anthers/shared/content";
import { useAuth } from "@anthers/web-shared/auth";
import {
	INTERACTION_PERMISSION_HINT,
	useInteractionPermissionMissing,
} from "@anthers/web-shared/publishing";
import { client } from "@anthers/web-shared/rpc";
import type { Review, ReviewAggregate } from "@anthers/web-shared/types";
import { FlagIcon, HandThumbDownIcon, HandThumbUpIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import VoteControl from "../post/VoteControl";
import ReportDialog from "../ui/ReportDialog";

/** The two orders the section knows. Helpful is the default; Newest is the alternative. */
type ReviewSort = "helpful" | "newest";

/** A verdict the list may be narrowed to, or everything. */
type VerdictFilter = "all" | "recommended" | "not-recommended";

/** How a window reads next to its share. */
const WINDOW_LABELS: Record<ReviewWindow, string> = {
	week: "past week",
	month: "past month",
	year: "past year",
};

/**
 * Reviews for a **Work**. Keyed on the Work's id rather than a post slug, because a review
 * is a verdict on a work and a work is reachable without any post existing.
 */
export default function WorkReviews({ workId }: { workId: number }) {
	const { isAuthenticated, user } = useAuth();
	// A review is a record in the reviewer's own repository, refused without the permission.
	const permissionMissing = useInteractionPermissionMissing(isAuthenticated) === true;
	const [agg, setAgg] = useState<ReviewAggregate | null>(null);
	const [window, setWindow] = useState<ReviewWindow>("month");
	const [sort, setSort] = useState<ReviewSort>("helpful");
	const [filter, setFilter] = useState<VerdictFilter>("all");
	const [draftVerdict, setDraftVerdict] = useState<string | null>(null);
	const [draftBody, setDraftBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reportingReview, setReportingReview] = useState<number | null>(null);

	const fetchReviews = useCallback(
		(w: ReviewWindow) => {
			client.api.content.works[":id"].reviews
				.$get({ param: { id: String(workId) }, query: { window: w } })
				.then(async (res) => {
					if (!res.ok) return;
					setAgg((await res.json()) as unknown as ReviewAggregate);
				})
				.catch(console.error);
		},
		[workId],
	);

	useEffect(() => {
		fetchReviews(window);
	}, [fetchReviews, window]);

	// Choosing a verdict opens the form; if they have reviewed before, open it on what they
	// already said so editing is a correction rather than a retype.
	const startReview = (verdict: string) => {
		if (!isAuthenticated) return;
		setDraftVerdict(verdict);
		setDraftBody((current) => current || (agg?.userReview ?? ""));
		setError(null);
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (draftVerdict === null || draftBody.trim().length < REVIEW_MIN) return;
		setSubmitting(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].reviews.$post({
				param: { id: String(workId) },
				json: { verdict: draftVerdict, body: draftBody.trim() },
			});
			if (!res.ok) {
				setError("That review couldn't be saved. Please try again.");
				return;
			}
			setDraftVerdict(null);
			setDraftBody("");
			fetchReviews(window);
		} catch {
			setError("That review couldn't be saved. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	// The visible list: the filter narrows it, the sort orders it — both over the one
	// payload so the two controls can never disagree about what was fetched. Newest first
	// breaks a helpfulness tie, recency being the only other thing a reader can check.
	const shown = useMemo(() => {
		if (!agg) return [];
		const filtered =
			filter === "all" ? agg.reviews : agg.reviews.filter((r) => r.verdict === filter);
		const byDate = (a: Review, b: Review) =>
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
		return [...filtered].sort(
			sort === "newest" ? byDate : (a, b) => b.score - a.score || byDate(a, b),
		);
	}, [agg, filter, sort]);

	if (!agg) return null;

	const tooShort = draftBody.trim().length < REVIEW_MIN;
	const chosen = draftVerdict ?? agg.userVerdict;

	return (
		<div>
			<div className="flex items-center gap-4 mb-3 flex-wrap">
				<h2 className="text-xl font-bold">Reviews</h2>
				{agg.recommendedPercent !== null && (
					<span className="text-sm text-base-content/70">
						<span className="font-semibold">{agg.recommendedPercent}% Recommended</span>{" "}
						<span className="text-base-content/50">
							All Time ({agg.recommended} of {agg.count})
						</span>
					</span>
				)}
				{/* The Recent share sits beside All Time rather than replacing it, so All Time is
				    always the constant a reader can compare against. A window holding nothing is
				    stated as such — an absent row would read as a bug. */}
				{agg.count > 0 && (
					<span className="text-sm text-base-content/70 inline-flex items-center gap-1">
						{agg.recent.recommendedPercent !== null ? (
							<>
								<span className="font-semibold">{agg.recent.recommendedPercent}%</span>
								<span className="text-base-content/50">
									({agg.recent.recommended} of {agg.recent.count})
								</span>
							</>
						) : (
							<span className="text-base-content/50">No reviews</span>
						)}{" "}
						<span>in the</span>
						<select
							className="select select-xs select-bordered"
							value={window}
							onChange={(e) => setWindow(e.target.value as ReviewWindow)}
							aria-label="Recent review window"
						>
							{REVIEW_WINDOWS.map((w) => (
								<option key={w} value={w}>
									{WINDOW_LABELS[w]}
								</option>
							))}
						</select>
					</span>
				)}
			</div>

			{isAuthenticated && (
				<div className="mb-6">
					<div className="flex items-center gap-2">
						{/* Two buttons and no third: somebody who feels neither is meant to post
						    nothing, because posting a review is an action and having it mean
						    something is the point. */}
						<button
							type="button"
							className={`btn btn-sm ${chosen === "recommended" ? "btn-primary" : "btn-outline"}`}
							onClick={() => startReview("recommended")}
							aria-pressed={chosen === "recommended"}
						>
							<HandThumbUpIcon className="w-4 h-4" />
							Recommend
						</button>
						<button
							type="button"
							className={`btn btn-sm ${chosen === "not-recommended" ? "btn-primary" : "btn-outline"}`}
							onClick={() => startReview("not-recommended")}
							aria-pressed={chosen === "not-recommended"}
						>
							<HandThumbDownIcon className="w-4 h-4" />
							Don't Recommend
						</button>
						<span className="text-sm text-base-content/60">
							{agg.userVerdict !== null
								? "You've reviewed this — choose again to edit"
								: "Choose one to write a review"}
						</span>
					</div>

					{draftVerdict !== null && (
						<form onSubmit={submit} className="mt-3">
							<textarea
								className="textarea textarea-bordered w-full"
								rows={3}
								maxLength={REVIEW_MAX}
								placeholder="What did you think? A verdict on its own doesn't say much."
								value={draftBody}
								onChange={(e) => setDraftBody(e.target.value)}
							/>
							{error && <p className="mt-1 text-sm text-error">{error}</p>}
							{permissionMissing && (
								<p className="mt-1 text-xs text-warning">{INTERACTION_PERMISSION_HINT}</p>
							)}
							<div className="mt-2 flex items-center gap-2">
								<button
									type="submit"
									className="btn btn-primary btn-sm"
									disabled={submitting || tooShort || permissionMissing}
								>
									{submitting ? (
										<span className="loading loading-spinner loading-sm" />
									) : (
										"Post review"
									)}
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={() => setDraftVerdict(null)}
									disabled={submitting}
								>
									Cancel
								</button>
							</div>
						</form>
					)}
				</div>
			)}

			{agg.reviews.length === 0 ? (
				<p className="text-sm text-base-content/50">
					No reviews yet.{" "}
					{isAuthenticated ? "Be the first to say something." : "Log in to write one."}
				</p>
			) : (
				<>
					{/* The controls over the list, stated as the choices they are rather than as
					    chrome: what order, and which verdicts. They never re-fetch — both read
					    the payload this section already has. */}
					<div className="flex items-center gap-4 mb-3 text-sm">
						<span className="inline-flex items-center gap-1">
							<button
								type="button"
								className={
									sort === "helpful"
										? "font-semibold"
										: "text-base-content/50 hover:text-base-content"
								}
								onClick={() => setSort("helpful")}
								aria-pressed={sort === "helpful"}
							>
								Helpful First
							</button>
							<span className="text-base-content/30">·</span>
							<button
								type="button"
								className={
									sort === "newest"
										? "font-semibold"
										: "text-base-content/50 hover:text-base-content"
								}
								onClick={() => setSort("newest")}
								aria-pressed={sort === "newest"}
							>
								Newest First
							</button>
						</span>
						<select
							className="select select-xs select-bordered"
							value={filter}
							onChange={(e) => setFilter(e.target.value as VerdictFilter)}
							aria-label="Filter reviews by verdict"
						>
							<option value="all">All reviews</option>
							<option value="recommended">Recommended</option>
							<option value="not-recommended">Not Recommended</option>
						</select>
					</div>

					{shown.length === 0 ? (
						<p className="text-sm text-base-content/50">
							None of the {agg.count} {agg.count === 1 ? "review" : "reviews"} is a{" "}
							{filter === "recommended" ? "recommendation" : "non-recommendation"}.
						</p>
					) : (
						<div className="flex flex-col gap-4">
							{shown.map((review) => (
								<div key={review.id} className="flex gap-3">
									{review.avatar ? (
										<img
											src={review.avatar}
											alt={review.handle}
											className="w-8 h-8 rounded-full object-cover flex-shrink-0"
										/>
									) : (
										<div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
											{review.handle.charAt(0).toUpperCase()}
										</div>
									)}
									<div className="flex-1">
										<div className="flex items-center gap-2 text-sm flex-wrap">
											<span className="font-medium">{review.handle}</span>
											<span
												className={
													review.verdict === "recommended"
														? "text-success text-xs font-medium"
														: "text-base-content/60 text-xs font-medium"
												}
											>
												{verdictLabel(review.verdict)}
											</span>
											<span className="text-base-content/40 text-xs">
												{new Date(review.createdAt).toLocaleDateString()}
											</span>
											{/* A review's score is its helpfulness: the same gesture as a
											    comment's vote, asked of a reader's words rather than a
											    creator's thing. It orders the list and nothing else. */}
											<VoteControl
												subjectType="review"
												subjectId={review.id}
												score={review.score}
												viewerVote={review.viewerVote}
												label={`${review.handle}'s review`}
												onChange={({ score, viewerVote }) =>
													setAgg((current) =>
														current
															? {
																	...current,
																	reviews: current.reviews.map((r) =>
																		r.id === review.id ? { ...r, score, viewerVote } : r,
																	),
																}
															: current,
													)
												}
											/>
											{/* Reviews are reportable for the same reason comments are. */}
											{isAuthenticated && review.userId !== user?.id && (
												<button
													type="button"
													className="ml-auto text-base-content/30 hover:text-base-content/70"
													onClick={() => setReportingReview(review.id)}
													title="Report this review"
													aria-label={`Report ${review.handle}'s review`}
												>
													<FlagIcon className="w-3.5 h-3.5" />
												</button>
											)}
										</div>
										{/* "" is a verdict-only review written before text was required. */}
										{review.body && <p className="text-sm mt-1">{review.body}</p>}
									</div>
								</div>
							))}
						</div>
					)}
				</>
			)}

			{reportingReview !== null && (
				<ReportDialog
					subjectType="review"
					subjectId={reportingReview}
					label="this review"
					onClose={() => setReportingReview(null)}
				/>
			)}
		</div>
	);
}
