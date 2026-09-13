// SPDX-License-Identifier: Apache-2.0
/**
 * Reviews on a Work — the aggregate, the written reviews, and the form.
 *
 * A verdict cannot be left on its own: choosing one opens a required text field, and nothing
 * is submitted until there are words. That is a deliberate trade of volume for substance —
 * most Works will carry no reviews for a long while, and an honest "no reviews yet" beats a
 * percentage assembled from three drive-by clicks. It also gives moderation something to act
 * on, where a bare thumb is unmoderatable by construction.
 *
 * ⭐ **The aggregate is a proportion and not an average**, because a review recommends a Work
 * or does not. `@anthers/shared/content` carries why, and it is the same reasoning that gives
 * Anthers one opinion primitive rather than two.
 *
 * Bodies render as React text nodes, never as markup — the API stores plain text and nothing
 * here interprets it.
 */

import { REVIEW_MAX, REVIEW_MIN, verdictLabel } from "@anthers/shared/content";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type { ReviewAggregate } from "@anthers/web-shared/types";
import { FlagIcon, HandThumbDownIcon, HandThumbUpIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import ReportDialog from "../ui/ReportDialog";

/**
 * Reviews for a **Work**. Keyed on the Work's id rather than a post slug, because a review
 * is a verdict on a work and a work is reachable without any post existing.
 */
export default function WorkReviews({ workId }: { workId: number }) {
	const { isAuthenticated, user } = useAuth();
	const [agg, setAgg] = useState<ReviewAggregate | null>(null);
	const [draftVerdict, setDraftVerdict] = useState<string | null>(null);
	const [draftBody, setDraftBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reportingReview, setReportingReview] = useState<number | null>(null);

	const fetchReviews = useCallback(() => {
		client.api.content.works[":id"].reviews
			.$get({ param: { id: String(workId) } })
			.then(async (res) => {
				if (!res.ok) return;
				setAgg((await res.json()) as unknown as ReviewAggregate);
			})
			.catch(console.error);
	}, [workId]);

	useEffect(() => {
		fetchReviews();
	}, [fetchReviews]);

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
			fetchReviews();
		} catch {
			setError("That review couldn't be saved. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	if (!agg) return null;

	const tooShort = draftBody.trim().length < REVIEW_MIN;
	const chosen = draftVerdict ?? agg.userVerdict;

	return (
		<div>
			<div className="flex items-center gap-4 mb-3">
				<h2 className="text-xl font-bold">Reviews</h2>
				{agg.recommendedPercent !== null && (
					<span className="text-sm text-base-content/70">
						<span className="font-semibold">{agg.recommendedPercent}% Recommended</span>{" "}
						<span className="text-base-content/50">
							({agg.recommended} of {agg.count})
						</span>
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
							<div className="mt-2 flex items-center gap-2">
								<button
									type="submit"
									className="btn btn-primary btn-sm"
									disabled={submitting || tooShort}
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
				<div className="flex flex-col gap-4">
					{agg.reviews.map((review) => (
						<div key={review.id} className="flex gap-3">
							{review.avatar ? (
								<img
									src={review.avatar}
									alt={review.username}
									className="w-8 h-8 rounded-full object-cover flex-shrink-0"
								/>
							) : (
								<div className="w-8 h-8 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold flex-shrink-0">
									{review.username.charAt(0).toUpperCase()}
								</div>
							)}
							<div className="flex-1">
								<div className="flex items-center gap-2 text-sm">
									<span className="font-medium">{review.username}</span>
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
									{/* Reviews are reportable for the same reason comments are. */}
									{isAuthenticated && review.userId !== user?.id && (
										<button
											type="button"
											className="ml-auto text-base-content/30 hover:text-base-content/70"
											onClick={() => setReportingReview(review.id)}
											title="Report this review"
											aria-label={`Report ${review.username}'s review`}
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
