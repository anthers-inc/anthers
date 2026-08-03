// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reviews on a post — the aggregate, the written reviews, and the form.
 *
 * A score cannot be left on its own: picking stars opens a required text field,
 * and nothing is submitted until there are words. That's a deliberate trade of
 * volume for substance — most posts will carry no reviews for a long while, and
 * an honest "no reviews yet" beats a five-star average assembled from three
 * drive-by clicks. It also gives moderation something to act on, where a bare
 * 1-star is unmoderatable by construction.
 *
 * Bodies render as React text nodes, never as markup — the API stores plain text
 * and nothing here interprets it.
 */

import { REVIEW_MAX, REVIEW_MIN } from "@anthers/shared/content";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type { RatingAggregate } from "@anthers/web-shared/types";
import { FlagIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import ReportDialog from "../ui/ReportDialog";
import StarRating from "../ui/StarRating";

/**
 * Reviews for a **Work**. Keyed on the Work's id rather than a post slug, because a review
 * is a verdict on a work and a work is reachable without any post existing.
 */
export default function ProjectRating({ workId }: { workId: number }) {
	const { isAuthenticated, user } = useAuth();
	const [rating, setRating] = useState<RatingAggregate | null>(null);
	const [draftScore, setDraftScore] = useState<number | null>(null);
	const [draftBody, setDraftBody] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reportingReview, setReportingReview] = useState<number | null>(null);

	const fetchRating = useCallback(() => {
		client.api.content.works[":id"].ratings
			.$get({ param: { id: String(workId) } })
			.then(async (res) => {
				if (!res.ok) return;
				setRating((await res.json()) as unknown as RatingAggregate);
			})
			.catch(console.error);
	}, [workId]);

	useEffect(() => {
		fetchRating();
	}, [fetchRating]);

	// Picking stars opens the form; if they've reviewed before, open it on what
	// they already said so editing is a correction rather than a retype.
	const startReview = (score: number) => {
		if (!isAuthenticated) return;
		setDraftScore(score);
		setDraftBody((current) => current || (rating?.userReview ?? ""));
		setError(null);
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (draftScore === null || draftBody.trim().length < REVIEW_MIN) return;
		setSubmitting(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].ratings.$post({
				param: { id: String(workId) },
				json: { score: draftScore, body: draftBody.trim() },
			});
			if (!res.ok) {
				setError("That review couldn't be saved. Please try again.");
				return;
			}
			setDraftScore(null);
			setDraftBody("");
			fetchRating();
		} catch {
			setError("That review couldn't be saved. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	if (!rating) return null;

	const tooShort = draftBody.trim().length < REVIEW_MIN;

	return (
		<div>
			<div className="flex items-center gap-4 mb-3">
				<h2 className="text-xl font-bold">Reviews</h2>
				<StarRating rating={rating.average} count={rating.count} />
			</div>

			{isAuthenticated && (
				<div className="mb-6">
					<div className="flex items-center gap-3">
						<StarRating rating={draftScore ?? rating.userRating} interactive onRate={startReview} />
						<span className="text-sm text-base-content/60">
							{rating.userRating !== null
								? "You've reviewed this — pick a score to edit"
								: "Pick a score to write a review"}
						</span>
					</div>

					{draftScore !== null && (
						<form onSubmit={submit} className="mt-3">
							<textarea
								className="textarea textarea-bordered w-full"
								rows={3}
								maxLength={REVIEW_MAX}
								placeholder="What did you think? A score on its own doesn't say much."
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
									onClick={() => setDraftScore(null)}
									disabled={submitting}
								>
									Cancel
								</button>
							</div>
						</form>
					)}
				</div>
			)}

			{rating.reviews.length === 0 ? (
				<p className="text-sm text-base-content/50">
					No reviews yet.{" "}
					{isAuthenticated ? "Be the first to say something." : "Log in to write one."}
				</p>
			) : (
				<div className="flex flex-col gap-4">
					{rating.reviews.map((review) => (
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
									<StarRating rating={review.score} size="sm" />
									<span className="text-base-content/40 text-xs">
										{new Date(review.createdAt).toLocaleDateString()}
									</span>
									{/* Reviews are reportable for the same reason comments are — and
									    until text existed there was nothing here to report. */}
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
								{/* "" is a score-only review written before text was required. */}
								{review.body && <p className="text-sm mt-1">{review.body}</p>}
							</div>
						</div>
					))}
				</div>
			)}

			{reportingReview !== null && (
				<ReportDialog
					subjectType="rating"
					subjectId={reportingReview}
					label="this review"
					onClose={() => setReportingReview(null)}
				/>
			)}
		</div>
	);
}
