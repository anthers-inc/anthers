// SPDX-License-Identifier: Apache-2.0
/**
 * Reviews on a Work — the aggregates, the written reviews, and the composer, split into
 * a **Your Review** section and an **Other Reviews** section.
 *
 * ⭐ **Your Review is one card with three modes** (Parker, 2026-11-11): closed with the
 * reason the reader cannot review yet, open for a new review, or holding the one they
 * wrote and can manage. The composer is the tallest, and the other two hold its height, so
 * a review landing replaces the composer in place rather than changing the tab's shape —
 * which also means the review a reader wrote is never shown twice, because Other Reviews
 * leaves their own words out.
 *
 * ⭐ **The section keeps itself current.** Eligibility is the server's answer on each read,
 * and the browser's attention engine tells this component when the reader starts earning
 * on this Work; that moment is flushed and the section re-read, so pressing play opens the
 * composer without a reload. A slow poll covers a change this tab did not witness.
 *
 * The composer stands open for a signed-in user, and the verdict is what makes it
 * postable: choosing one is a selection, not a reveal, and text is optional. A
 * verdict alone counts in both shares and stays out of the list below, where only
 * reviews with words appear — a list of bare verdicts is nothing a reader can read.
 *
 * ⭐ **The aggregate is a proportion and not an average**, because a review recommends a Work
 * or does not. `@anthers/shared/content` carries why, and it is the same reasoning that gives
 * Anthers one opinion primitive rather than two. It comes as a **review bar** under the
 * composer (Parker, 2026-11-07): **All Time** over every review beside a **Recent** share over
 * a user-chosen window — so a Work that changed after release can be seen to have changed its
 * users' minds — with the list's own controls in the same card. The Recent share simply has
 * nothing to say (and says so) when its window holds no reviews.
 *
 * ⭐ **A Work with more than one media version may be narrowed to the current one**, and when it
 * is, every figure on the row describes that narrower set — which is why the filter is a query
 * parameter rather than a local list filter, and why the label stops saying All Time. A review
 * names no version, so the server measures it by `createdAt` against the version's date; the
 * proxy and its two leaks are documented where the cutoff is computed.
 *
 * ⭐ **The list sorts by helpfulness, not by when the review was written** (2026-09-12). What
 * a user finds worth reading is what other users found helpful, so the default is Helpful
 * First with Newest First as the explicit alternative — neither is a re-fetch; both are this
 * payload read two ways. Helpfulness is the same vote a post or a comment takes, asked here as
 * "was this helpful?" — and it only ever *sorts*; one person's review counts once in either
 * share however many votes it drew. A new review's `1` is its author's own upvote — posting
 * something says the author thinks it worth reading, so `0` always means a user said no.
 *
 * Bodies render as React text nodes, never as markup — the API stores plain text and nothing
 * here interprets it. {@link ReviewBody} is the one renderer: a timestamp a reviewer wrote
 * YouTube-comment style (`starts at 0:00`) reads as a link that seeks the page's player when
 * there is one — parse-side only, the body still being text the reviewer meant, nothing
 * structured riding on it.
 */

import {
	REVIEW_MAX,
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
import {
	ChevronDownIcon,
	FlagIcon,
	HandThumbDownIcon,
	HandThumbUpIcon,
} from "@heroicons/react/24/outline";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { flushAttentionNow, subscribeAttentionStarted } from "../../lib/attention";
import { useSeekPlayer } from "../../lib/work-player";
import TimestampedText from "../media/TimestampedText";
import StickerChooser, { givePendingSticker } from "../post/StickerChooser";
import VoteControl from "../post/VoteControl";
import ReportDialog from "../ui/ReportDialog";
import { WORK_DETAILS_HEADING_CLASS } from "../work/WorkLayout";

/** The two orders the section knows. Helpful is the default; Newest is the alternative. */
type ReviewSort = "helpful" | "newest";

/** A verdict the list may be narrowed to, or everything. */
type VerdictFilter = "all" | "recommended" | "not-recommended";

/** Which versions' reviews to read, when the Work has more than one. */
type VersionFilter = "all" | "current";

/**
 * How often a closed Your Review section re-reads its eligibility.
 *
 * The quick path is the attention engine's own signal: a claim that starts earning is
 * flushed and the section re-read at once, so pressing play opens the composer without a
 * reload. This interval is the fallback for a change this tab never witnessed — a
 * scheduled release arriving, a grant made from another tab — and it stops as soon as
 * the section opens.
 */
const ELIGIBILITY_POLL_MS = 15_000;

/**
 * The Your Review card's floor, and the reason it is a constant: the composer is the
 * tallest of the section's three modes, and the other two hold its height so the tab does
 * not move when a review lands. A long review body may still grow the card — clamping a
 * reader's own words to keep a layout fixed would hide them.
 */
const YOUR_REVIEW_HEIGHT = "min-h-[11rem]";

/** How a window reads as a scope label. */
const WINDOW_LABELS: Record<ReviewWindow, string> = {
	week: "Past Week",
	month: "Past Month",
	year: "Past Year",
};

/** The verdict the list may be narrowed to, in the order the row states them. */
const VERDICT_OPTIONS: { value: VerdictFilter; label: string }[] = [
	{ value: "all", label: "All Reviews" },
	{ value: "recommended", label: "Recommended" },
	{ value: "not-recommended", label: "Not Recommended" },
];

/**
 * A **scope control** — the quiet, borderless select with a chevron that decides what the
 * figures measure (which version's reviews, which recent window). It is deliberately not a
 * segmented button group: the segmented rows below it choose how to *read* the list, and a
 * scope changes *what the numbers are about*, so the two read as different kinds of choice.
 */
function ScopeSelect<T extends string>({
	value,
	onChange,
	options,
	label,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string }[];
	/** The select's accessible name — the visible text beside it names the choice, not the control. */
	label: string;
}) {
	return (
		<span className="inline-flex items-center gap-0.5">
			<select
				className="-ml-0.5 w-auto cursor-pointer appearance-none bg-transparent text-xs font-medium text-base-content/50 outline-none hover:text-base-content/80 focus-visible:text-base-content"
				value={value}
				onChange={(e) => onChange(e.target.value as T)}
				aria-label={label}
			>
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
			<ChevronDownIcon className="size-3 shrink-0 text-base-content/40" aria-hidden />
		</span>
	);
}

/**
 * One recommendation share in the review bar: what scope it measures, the figure, and
 * the reviews behind it. `label` is a node so the recent share can pass its window select
 * — the scope is the control rather than a select floating in a sentence beside it.
 *
 * The null case is the recent share's: a window holding no reviews has no percentage to
 * give, and says so in the figure's place rather than dropping the column.
 */
function ShareFigure({
	label,
	percent,
	recommended,
	count,
	emptyNote = "No reviews",
}: {
	label: ReactNode;
	percent: number | null;
	recommended: number;
	count: number;
	/** What the column says in place of a figure — the recent share's empty window. */
	emptyNote?: string;
}) {
	return (
		<div className="px-3 py-3">
			<div className="text-xs font-medium text-base-content/50">{label}</div>
			<p className="mt-1 text-2xl font-semibold leading-none tabular-nums">
				{percent === null ? <span className="text-base-content/30">—</span> : `${percent}%`}
			</p>
			<p className="mt-1.5 text-xs text-base-content/55">
				{percent === null ? emptyNote : `${recommended} of ${count} recommended it`}
			</p>
		</div>
	);
}

/**
 * A review's written body — the one place a body's text renders. A timestamp the
 * reviewer wrote seeks the page's player through the binding when a player is
 * mounted on this Work; elsewhere it stays text, exactly as the reviewer wrote it.
 */
function ReviewBody({ body }: { body: string }) {
	const seek = useSeekPlayer();
	return <TimestampedText text={body} onSeek={seek} className="text-sm mt-1 whitespace-pre-line" />;
}

/**
 * Reviews for a **Work**. Keyed on the Work's id rather than a post slug, because a review
 * is a verdict on a work and a work is reachable without any post existing.
 *
 * The composer stands open for a signed-in user (Parker, 2026-10-13): the text field is
 * always visible, and choosing a verdict selects it rather than revealing the form — the
 * "choose one to write a review" instruction is gone, because the selected state and the
 * disabled post button say the same thing. **Text is optional** (Parker, 2026-10-19), so the
 * button enables on the verdict alone; words are what make a review appear in the list
 * below, and a verdict without them still counts in both shares. The verdict buttons split
 * the row evenly, and a non-recommendation wears red when it is the chosen verdict, so the
 * two verdicts read like the two answers they are rather than like two flavors of one
 * choice.
 */
export default function WorkReviews({
	workId,
	creatorId,
}: {
	workId: number;
	/** The Work's creator, so the reader's own Work is known without another read. */
	creatorId: number | null;
}) {
	const { isAuthenticated, user } = useAuth();
	// A review is a record in the reviewer's own repository, refused without the permission.
	const permissionMissing = useInteractionPermissionMissing(isAuthenticated) === true;
	const [agg, setAgg] = useState<ReviewAggregate | null>(null);
	const [window, setWindow] = useState<ReviewWindow>("month");
	const [sort, setSort] = useState<ReviewSort>("helpful");
	const [filter, setFilter] = useState<VerdictFilter>("all");
	const [versionFilter, setVersionFilter] = useState<VersionFilter>("all");
	// Which scope the payload in `agg` actually answers. Held separately from the select so a
	// figure is never labeled with a scope the server has not returned yet: the label follows
	// the data, not the reader's next click.
	const [appliedVersion, setAppliedVersion] = useState<VersionFilter>("all");
	const [draftVerdict, setDraftVerdict] = useState<string | null>(null);
	const [draftBody, setDraftBody] = useState("");
	// An existing review is shown as the reader's own; the composer opens only when they
	// choose to change it, rather than standing open and inviting a second one.
	const [editing, setEditing] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [removing, setRemoving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reportingReview, setReportingReview] = useState<number | null>(null);
	const [stickerKey, setStickerKey] = useState<string | null>(null);
	const [stickerProblem, setStickerProblem] = useState<string | null>(null);

	const fetchReviews = useCallback(
		(w: ReviewWindow, version: VersionFilter) => {
			client.api.content.works[":id"].reviews
				.$get({ param: { id: String(workId) }, query: { window: w, version } })
				.then(async (res) => {
					if (!res.ok) return;
					setAgg((await res.json()) as unknown as ReviewAggregate);
					setAppliedVersion(version);
				})
				.catch(console.error);
		},
		[workId],
	);

	// The version scope is the server's, so changing it re-reads the section: both shares
	// are computed over the reviews that arrive, which is the difference between this
	// control and the verdict one below — a verdict narrows a list, a version narrows the
	// Work's whole review history as far as this section is concerned.
	useEffect(() => {
		fetchReviews(window, versionFilter);
	}, [fetchReviews, window, versionFilter]);

	// The section is waiting on something the server decides, so it listens for the one
	// change that arrives from this tab: attention starting on this Work. `startedWorkId`
	// is null for a claim that is not a Work, and another Work's player is not this one.
	const waitingForEligibility =
		agg?.eligibility != null && !agg.eligibility.canReview && agg.eligibility.code !== "own_work";

	useEffect(() => {
		if (!waitingForEligibility) return;
		return subscribeAttentionStarted((startedWorkId) => {
			if (startedWorkId !== workId) return;
			// The engine holds the seconds until its own cadence; the gate is answered
			// from rows, so the range is flushed before the section is re-read.
			void flushAttentionNow().then(() => fetchReviews(window, versionFilter));
		});
	}, [waitingForEligibility, workId, fetchReviews, window, versionFilter]);

	// The fallback poll: a release date passing, a grant made elsewhere, or a flush this
	// tab did not make. Visibility-gated because a background tab has nothing to show.
	useEffect(() => {
		if (!waitingForEligibility) return;
		const id = setInterval(() => {
			if (document.visibilityState === "visible") fetchReviews(window, versionFilter);
		}, ELIGIBILITY_POLL_MS);
		return () => clearInterval(id);
	}, [waitingForEligibility, fetchReviews, window, versionFilter]);

	// Choosing a verdict opens the form. An existing review opens on what they already
	// said, so editing is a correction rather than a retype.
	const startReview = (verdict: string) => {
		if (!isAuthenticated) return;
		setDraftVerdict(verdict);
		setDraftBody((current) => current || (agg?.userReview ?? ""));
		setError(null);
	};

	/** Open the composer on the review already written, words and verdict together. */
	const startEdit = () => {
		if (!agg?.userVerdict) return;
		setDraftVerdict(agg.userVerdict);
		setDraftBody(agg.userReview ?? "");
		setEditing(true);
		setError(null);
	};

	const cancelEdit = () => {
		setEditing(false);
		setDraftVerdict(null);
		setDraftBody("");
		setError(null);
		setStickerKey(null);
	};

	const remove = async () => {
		if (removing) return;
		if (
			!confirm(
				"Remove your review? Your verdict and words go, along with the helpfulness votes on them. A Sticker you gave stays with the creator.",
			)
		) {
			return;
		}
		setRemoving(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].reviews.$delete({
				param: { id: String(workId) },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "That review couldn't be removed. Please try again.");
			}
			cancelEdit();
			fetchReviews(window, versionFilter);
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "That review couldn't be removed. Please try again.",
			);
		} finally {
			setRemoving(false);
		}
	};

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (draftVerdict === null) return;
		setSubmitting(true);
		setError(null);
		try {
			const res = await client.api.content.works[":id"].reviews.$post({
				param: { id: String(workId) },
				json: { verdict: draftVerdict, body: draftBody.trim() },
			});
			if (!res.ok) {
				// The server's own refusal names the state (own Work, unlocked, unseen);
				// a generic failure message would hide the one thing the reader can act on.
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "That review couldn't be saved. Please try again.");
				return;
			}
			const { review } = (await res.json()) as { review: { id: number } };
			// The Sticker rides the review just written — the review's id is the subject, and
			// the money goes to the Work's creator whether or not the reviewer is one.
			if (stickerKey) {
				setStickerProblem(await givePendingSticker("review", review.id, stickerKey));
				setStickerKey(null);
			}
			setDraftVerdict(null);
			setDraftBody("");
			setEditing(false);
			fetchReviews(window, versionFilter);
		} catch {
			setError("That review couldn't be saved. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	// The visible list: the filter narrows it, the sort orders it — both over the one
	// payload so the two controls can never disagree about what was fetched. Newest first
	// breaks a helpfulness tie, recency being the only other thing a user can check.
	//
	// A reader's own review is deliberately not in this list: it is theirs to manage in
	// Your Review above, and repeating it under Other Reviews would show one voice twice.
	const shown = useMemo(() => {
		if (!agg) return [];
		const others = agg.reviews.filter((r) => r.userId !== user?.id);
		const filtered = filter === "all" ? others : others.filter((r) => r.verdict === filter);
		const byDate = (a: Review, b: Review) =>
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
		return [...filtered].sort(
			sort === "newest" ? byDate : (a, b) => b.score - a.score || byDate(a, b),
		);
	}, [agg, filter, sort, user?.id]);

	// Written reviews that belong to somebody else — the only rows Other Reviews can show.
	// Kept separate from `shown` because an empty verdict filter and an empty list are
	// different answers, and the empty state says which one it is.
	const otherReviews = useMemo(
		() => agg?.reviews.filter((r) => r.userId !== user?.id) ?? [],
		[agg, user?.id],
	);

	if (!agg) return null;

	const chosen = draftVerdict ?? agg.userVerdict;
	const isOwnWork = isAuthenticated && user?.id === creatorId;
	const hasReview = agg.userVerdict !== null;
	const locked = !hasReview && agg.eligibility !== null && !agg.eligibility.canReview;
	// The gate is the composer's; an existing review stays editable unless it was never
	// this reader's to write (their own Work), where Remove is the way out.
	const canEdit = agg.eligibility?.code !== "own_work";
	// True only while the payload really is the current version's: a Work with a single
	// version never offers the control, and the label follows the scope the server answered.
	const narrowed = appliedVersion === "current" && agg.versionSince !== null;

	return (
		<div>
			{isAuthenticated && (
				<section aria-labelledby="your-review-heading" className="mb-6 flex flex-col gap-2">
					<h3 id="your-review-heading" className={WORK_DETAILS_HEADING_CLASS}>
						Your Review
					</h3>
					{/* One card, one floor, three modes: closed with the reason, open for a new
					    review, and holding the review already written. The composer is the
					    tallest, so the other two borrow its height — a section that grew only
					    when a review landed would move the tab under a reader's cursor. */}
					<div
						data-testid="your-review"
						className={`flex ${YOUR_REVIEW_HEIGHT} flex-col rounded-box border border-base-300 p-3`}
					>
						{hasReview && !editing ? (
							<>
								{/* The section's own heading already says whose review this is, so the
								    card opens on the verdict rather than repeating it. */}
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<span
										className={
											agg.userVerdict === "recommended"
												? "text-success text-xs font-medium"
												: "text-base-content/60 text-xs font-medium"
										}
									>
										{verdictLabel(agg.userVerdict ?? "")}
									</span>
								</div>
								<div className="mt-2 flex-1">
									{agg.userReview && <ReviewBody body={agg.userReview} />}
								</div>
								<div className="mt-2 flex items-center justify-end gap-2">
									{canEdit && (
										<button
											type="button"
											className="btn btn-ghost btn-xs"
											disabled={removing}
											onClick={startEdit}
										>
											Edit
										</button>
									)}
									<button
										type="button"
										className="btn btn-ghost btn-xs text-error"
										disabled={removing}
										onClick={() => void remove()}
									>
										{removing ? "Removing…" : "Remove"}
									</button>
								</div>
								{error && <p className="mt-1 text-sm text-error">{error}</p>}
							</>
						) : locked ? (
							/* The reason IS the card in this mode: no disabled controls to read
							   past, and nothing to press that would only refuse. */
							<div className="flex flex-1 items-center justify-center">
								<p className="max-w-[22rem] text-center text-sm text-base-content/60">
									{agg.eligibility?.reason}
								</p>
							</div>
						) : (
							<>
								<div className="flex items-center gap-2 flex-wrap">
									{/* Two buttons and no third: somebody who feels neither is meant to post
								    nothing, because posting a review is an action and having it mean
								    something is the point. The split is even — each verdict takes half
								    this row's width — and the non-recommendation wears its own answer's
								    color, red, when it is the one chosen. */}
									<div className="flex flex-1 min-w-64 basis-56 items-center gap-2">
										<button
											type="button"
											className={`btn btn-sm ${chosen === "recommended" ? "btn-primary" : "btn-outline"} flex-1`}
											onClick={() => startReview("recommended")}
											aria-pressed={chosen === "recommended"}
										>
											<HandThumbUpIcon className="w-4 h-4" />
											Recommend
										</button>
										<button
											type="button"
											className={`btn btn-sm ${chosen === "not-recommended" ? "btn-error" : "btn-outline"} flex-1`}
											onClick={() => startReview("not-recommended")}
											aria-pressed={chosen === "not-recommended"}
										>
											<HandThumbDownIcon className="w-4 h-4" />
											Don't Recommend
										</button>
									</div>
								</div>
								{/* The field is not gated behind a verdict: it reads with the buttons. Text is
							    optional, so the post button enables on the verdict alone — the words are
							    what put the review in the list below. */}
								<form onSubmit={submit} className="mt-3 flex flex-1 flex-col">
									{/* `min-h-16` beats the component's own five-rem floor: this field
									    is sized by the card around it, not by a form's default. */}
									<textarea
										className="textarea textarea-bordered w-full flex-1 resize-none min-h-16"
										rows={2}
										maxLength={REVIEW_MAX}
										placeholder="Say more if you like. A verdict on its own still counts."
										value={draftBody}
										onChange={(e) => {
											setDraftBody(e.target.value);
											if (draftVerdict === null && agg?.userVerdict != null) {
												setDraftVerdict(agg.userVerdict);
											}
										}}
									/>
									{error && <p className="mt-1 text-sm text-error">{error}</p>}
									{permissionMissing && (
										<p className="mt-1 text-xs text-warning">{INTERACTION_PERMISSION_HINT}</p>
									)}
									<div className="mt-2 flex items-center gap-2">
										<button
											type="submit"
											className="btn btn-primary btn-sm"
											disabled={submitting || chosen === null || permissionMissing}
										>
											{submitting ? (
												<span className="loading loading-spinner loading-sm" />
											) : editing ? (
												"Save changes"
											) : (
												"Post review"
											)}
										</button>
										<button
											type="button"
											className="btn btn-ghost btn-sm"
											onClick={cancelEdit}
											disabled={submitting}
										>
											Cancel
										</button>
										<StickerChooser
											value={stickerKey}
											onChange={setStickerKey}
											label="your review"
											recipientOf={{ subjectType: "work", subjectId: workId }}
										/>
									</div>
									{stickerProblem && (
										<p className="mt-1 text-xs text-error" role="alert">
											Your review is posted, but the Sticker could not be given: {stickerProblem}
										</p>
									)}
								</form>
							</>
						)}
					</div>
				</section>
			)}

			<section aria-labelledby="other-reviews-heading" className="flex flex-col gap-4">
				<h3 id="other-reviews-heading" className={WORK_DETAILS_HEADING_CLASS}>
					Other Reviews
				</h3>

				{/* The review bar (Parker, 2026-11-07): the two shares and the controls that read
				    the words below them, one card under the composer. The shares used to share a
				    line with the heading, where the recent share's percentage, counts and window
				    select wrapped into a stack of fragments; a figure now stands in its own
				    column, and the scope it measures is the column's own label — the window
				    select on the recent one, so picking a window is a heading rather than a
				    control floating in a sentence. */}
				{agg.count > 0 && (
					<section
						aria-label="Review summary and controls"
						className="overflow-hidden rounded-box border border-base-300"
					>
						<div className="grid grid-cols-2 divide-x divide-base-300">
							<ShareFigure
								// Narrowed to the current version, the figures describe that set and not
								// the Work's whole history, so the label cannot say All Time — the
								// number beside it would then be a count of something else.
								label={narrowed ? "Since This Version" : "All Time"}
								percent={agg.recommendedPercent}
								recommended={agg.recommended}
								count={agg.count}
							/>
							<ShareFigure
								label={
									<ScopeSelect
										value={window}
										onChange={setWindow}
										options={REVIEW_WINDOWS.map((w) => ({
											value: w,
											label: WINDOW_LABELS[w],
										}))}
										label="Recent review window"
									/>
								}
								// The Recent share sits beside All Time rather than replacing it, so All
								// Time is always the constant a user can compare against. A window
								// holding nothing is stated as such — an absent column would read as a
								// bug — and the window control stays in its label either way.
								percent={agg.recent.recommendedPercent}
								recommended={agg.recent.recommended}
								count={agg.recent.count}
								emptyNote="No reviews in this window"
							/>
						</div>

						{/* The version scope, when there is one: only a Work whose current build
					    arrived after its release has anything to narrow — with one version,
					    every review is already the current one's. It scopes the shares above
					    as well as the list, which is why it stands with them rather than among
					    the list's own controls. The option names the version by what it is
					    rather than by a name the payload does not carry; the page's byline
					    states the date. */}
						{agg.versionSince && (
							<div className="flex items-center gap-2 border-t border-base-300 px-3 py-2 text-xs text-base-content/55">
								<span>Showing</span>
								<ScopeSelect
									value={versionFilter}
									onChange={setVersionFilter}
									options={[
										{ value: "all", label: "Every Version" },
										{ value: "current", label: "Since This Version" },
									]}
									label="Filter reviews by media version"
								/>
							</div>
						)}

						{/* The list's own controls, one row: which verdicts, in what order. Both read
					    the payload this section already has, so neither re-fetches, and both
					    wear the page's segmented language — the same `join` of buttons the tab
					    bars use — rather than one row of bare text beside a dropdown. Offered
					    only when the list has somebody else's words to arrange. */}
						{otherReviews.length > 0 && (
							<div className="flex flex-col gap-2 border-t border-base-300 p-3">
								<fieldset className="join min-w-0 w-full" aria-label="Filter reviews by verdict">
									{VERDICT_OPTIONS.map((option) => (
										<button
											key={option.value}
											type="button"
											className={`btn btn-xs join-item flex-1 whitespace-nowrap px-1 ${
												filter === option.value ? "btn-active" : ""
											}`}
											onClick={() => setFilter(option.value)}
											aria-pressed={filter === option.value}
										>
											{option.label}
										</button>
									))}
								</fieldset>
								<fieldset className="join min-w-0 w-full" aria-label="Order reviews">
									<button
										type="button"
										className={`btn btn-xs join-item flex-1 ${sort === "helpful" ? "btn-active" : ""}`}
										onClick={() => setSort("helpful")}
										aria-pressed={sort === "helpful"}
									>
										Helpful First
									</button>
									<button
										type="button"
										className={`btn btn-xs join-item flex-1 ${sort === "newest" ? "btn-active" : ""}`}
										onClick={() => setSort("newest")}
										aria-pressed={sort === "newest"}
									>
										Newest First
									</button>
								</fieldset>
							</div>
						)}
					</section>
				)}

				{agg.reviews.length === 0 ? (
					<p className="text-sm text-base-content/50">
						{/* A narrowed section with nothing in it normally carries the version control
					    in the bar above; only a Work with no reviews at all loses that control
					    with the figures, so the way back rides the sentence there. */}
						{narrowed ? (
							<>
								{agg.count > 0
									? "No written reviews since this version."
									: "No reviews since this version."}{" "}
								{agg.count === 0 && (
									<button type="button" className="link" onClick={() => setVersionFilter("all")}>
										Show every version
									</button>
								)}
							</>
						) : agg.count > 0 ? (
							<>
								No written reviews yet.{" "}
								{hasReview
									? "Add words to yours above."
									: isAuthenticated
										? "Add yours."
										: "Log in to add yours."}
							</>
						) : (
							<>
								No reviews yet.{" "}
								{isAuthenticated ? "Be the first to say something." : "Log in to write one."}
							</>
						)}
					</p>
				) : otherReviews.length === 0 ? (
					<p className="text-sm text-base-content/50">No other written reviews yet.</p>
				) : shown.length === 0 ? (
					<p className="text-sm text-base-content/50">
						None of the other written reviews is a{" "}
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
										{/* The review's own record, open on the network beside the
											    Work's reviews (the widening task, 2026-10-10) — the record
											    is public, and a review carries a link the way the Work it
											    reviews does. */}
										{review.recordUrl && (
											<a
												href={review.recordUrl}
												target="_blank"
												rel="noreferrer"
												className="link link-hover text-xs text-base-content/40"
											>
												View the record
											</a>
										)}
										{/* A review's score is its helpfulness: the same gesture as a
											    comment's vote, asked of a user's words rather than a
											    creator's thing. It orders the list and nothing else. */}
										<VoteControl
											subjectType="review"
											subjectId={review.id}
											score={review.score}
											userVote={review.userVote}
											label={`${review.handle}'s review`}
											disabledReason={
												isOwnWork ? "You can't vote on reviews of your own Work." : undefined
											}
											onChange={({ score, userVote }) =>
												setAgg((current) =>
													current
														? {
																...current,
																reviews: current.reviews.map((r) =>
																	r.id === review.id ? { ...r, score, userVote } : r,
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
									{/* Every listed review carries words — the list excludes a verdict
										    left on its own — so the guard is a type narrowing, not a shape. */}
									{review.body && <ReviewBody body={review.body} />}
								</div>
							</div>
						))}
					</div>
				)}
			</section>

			<ReportDialog
				subject={
					reportingReview !== null
						? { type: "review", id: reportingReview, label: "this review" }
						: null
				}
				onClose={() => setReportingReview(null)}
			/>
		</div>
	);
}
