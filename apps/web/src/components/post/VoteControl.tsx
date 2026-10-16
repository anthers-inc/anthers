// SPDX-License-Identifier: Apache-2.0
/**
 * A like, a dislike, and the one number they add up to.
 *
 * ⭐ **One number is shown, never two** (Parker, 2026-09-04). A dislike does visible work by
 * pulling the score down, and a pile-on gets no dislike counter to run up. The alternative
 * Parker rejected outright is hiding the dislike: *"Having a dislike that has no visible
 * impact on a value the user can see is the worst case scenario."*
 *
 * ⭐ **What this shows is what ordered the thread.** The score is the ranking key, so a
 * user can always account for the order from what is in front of them. `@anthers/shared/votes`
 * carries why the published number and the sort key have to be the same one.
 *
 * ⚠️ **Optimistic, and it reconciles with the server rather than trusting itself.** The
 * server returns the recomputed score, because the local guess is wrong the moment anybody
 * else has reacted since the page loaded — and a score that drifts from its rows looks
 * exactly like a score.
 */

import type { VoteDirection } from "@anthers/shared/votes";
import { useAuth } from "@anthers/web-shared/auth";
import {
	INTERACTION_PERMISSION_HINT,
	useInteractionPermissionMissing,
} from "@anthers/web-shared/publishing";
import { client } from "@anthers/web-shared/rpc";
import { HandThumbDownIcon, HandThumbUpIcon } from "@heroicons/react/24/outline";
import {
	HandThumbDownIcon as HandThumbDownSolid,
	HandThumbUpIcon as HandThumbUpSolid,
} from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";

/**
 * The control's two shapes (Parker, 2026-10-16). A comment thread and a review's
 * helpfulness row carry the subtle one — an icon that leans on its neighbors, the net
 * score between them. A post page carries `boxed`: outlined buttons in the Recommend /
 * Don't Recommend shape its page's vote row shares, filled (`btn-primary` up,
 * `btn-error` down) when chosen, each carrying its own count — the numbers on the
 * buttons (Parker, 2026-10-16, second note), YouTube's shape with the down side
 * filled in too. The single-subject read serves both counts to every reader now,
 * revising the one-number display of 2026-09-04 for this surface; the net still sorts
 * the thread and still reads out on the screen reader.
 */
export type VoteVariant = "subtle" | "boxed";

export type VoteSubject = "post" | "comment" | "review";

/** A direction as the number it contributes to a net score. Null contributes nothing. */
function weight(d: VoteDirection | null): number {
	return d === "up" ? 1 : d === "down" ? -1 : 0;
}

export default function VoteControl({
	subjectType,
	subjectId,
	score,
	userVote,
	up,
	down,
	label,
	onChange,
	variant = "subtle",
}: {
	subjectType: VoteSubject;
	subjectId: number;
	/**
	 * The current state, when the caller already has it.
	 *
	 * ⭐ **Omit both and the control fetches its own.** A comment thread has every score in
	 * the payload it already loaded, so passing them costs nothing; a Work or post page
	 * would otherwise have to thread a score through several serializer branches for one
	 * small control. Two ways in, one component.
	 */
	score?: number;
	userVote?: VoteDirection | null;
	/**
	 * The exact counts, shown only to whoever authored the thing.
	 *
	 * ⚠️ **Undefined means "not yours to see", never "zero".** The server omits the keys for
	 * anybody else, so a falsy check that treated `0` and absent alike would hide a real
	 * count of zero from its own author and — worse the other way — invite a default that
	 * shows everyone a breakdown.
	 */
	up?: number;
	down?: number;
	/** Names the thing being reacted to, for a screen reader. */
	label: string;
	/** Subtle (comments, review helpfulness) or boxed (a post page's vote row). */
	variant?: VoteVariant;
	onChange?: (next: { score: number; collapsed: boolean; userVote: VoteDirection | null }) => void;
}) {
	const { isAuthenticated } = useAuth();
	const permissionMissing = useInteractionPermissionMissing(isAuthenticated);
	const given = score !== undefined;
	const [mine, setMine] = useState<VoteDirection | null>(userVote ?? null);
	const [shown, setShown] = useState(score ?? 0);
	const [detail, setDetail] = useState<{ up: number; down: number } | null>(
		up === undefined || down === undefined ? null : { up, down },
	);
	const [busy, setBusy] = useState(false);
	// Starts hidden when it has to ask, so a control does not flash "0" and then correct
	// itself — a score that changes on its own reads as somebody else having just voted.
	const [ready, setReady] = useState(given);
	// Whether this control's counts came from its caller (a thread payload — which serves
	// them to the row's author alone) rather than a fetch. The subtle variant keeps its
	// breakdown bounded by that source; the boxed one is public by design.
	const detailRef = useRef(detail);
	detailRef.current = detail;

	useEffect(() => {
		if (given) return;
		let live = true;
		client.api.content.votes
			.$get({ query: { subjectType, subjectId: String(subjectId) } })
			.then(async (res) => {
				if (!res.ok || !live) return;
				const data = (await res.json()) as {
					score: number;
					userVote: VoteDirection | null;
					up?: number;
					down?: number;
				};
				setShown(data.score);
				setMine(data.userVote);
				// The counts are public on this read now, and the boxed buttons draw them.
				// Subtle takes a breakdown only when the caller carried one — a thread rides
				// its payload, so this GET's counts would start a display a comment's row
				// never drew.
				if (data.up !== undefined && data.down !== undefined) {
					if (variant === "boxed" || detailRef.current !== null) {
						setDetail({ up: data.up, down: data.down });
					}
				}
				setReady(true);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
		// ⚠️ `detail`'s value is deliberately omitted: re-running the fetch because the
		// detail state moved would re-read what it just read. `variant` never changes for
		// a mounted control, but the rule wants the closure's inputs listed.
	}, [given, subjectType, subjectId, variant]);

	async function vote(direction: VoteDirection) {
		if (!isAuthenticated || busy) return;
		setBusy(true);
		// Pressing the button you already pressed takes the vote back, which is the only
		// way to return to having said nothing — distinct from saying the opposite.
		const next = mine === direction ? null : direction;
		const before = { mine, shown, detail: detailRef.current };
		setMine(next);
		// Floored locally too, so the optimistic number can never be one the server would
		// not publish.
		setShown((s) => Math.max(0, s - weight(mine) + weight(next)));
		// The counts move with the same arithmetic, so the buttons read as pressed the
		// moment the vote does — a click that moved only the net would leave a number
		// sitting still beside an icon that had just changed state.
		if (before.detail !== null) {
			const d = before.detail;
			const moved = (side: VoteDirection) =>
				1 * (mine === side ? -1 : 0) + 1 * (next === side ? 1 : 0);
			setDetail({
				up: Math.max(0, d.up + moved("up")),
				down: Math.max(0, d.down + moved("down")),
			});
		}
		try {
			const res =
				next === null
					? await client.api.content.votes.$delete({ json: { subjectType, subjectId } })
					: await client.api.content.votes.$put({
							json: { subjectType, subjectId, direction: next },
						});
			if (!res.ok) throw new Error(String(res.status));
			const data = (await res.json()) as {
				score: number;
				collapsed: boolean;
				userVote: VoteDirection | null;
				up?: number;
				down?: number;
			};
			setShown(data.score);
			// The counts are public now, so every write answers with them. A boxed control
			// always takes them; a subtle one takes them only when a breakdown had already
			// been drawn from its caller's payload, so a stranger's vote never invents the
			// author's display on somebody else's words.
			if (data.up !== undefined && data.down !== undefined) {
				if (variant === "boxed" || before.detail !== null) {
					setDetail({ up: data.up, down: data.down });
				}
			}
			setMine(next);
			onChange?.({ ...data, userVote: next });
		} catch {
			// Put it back. A control that silently keeps an optimistic value it failed to
			// save is telling the user their vote counted when it did not.
			setMine(before.mine);
			setShown(before.shown);
			if (before.detail !== null) setDetail(before.detail);
		} finally {
			setBusy(false);
		}
	}

	if (!ready) return null;

	const Up = mine === "up" ? HandThumbUpSolid : HandThumbUpIcon;
	const Down = mine === "down" ? HandThumbDownSolid : HandThumbDownIcon;
	const disabled = !isAuthenticated || busy;
	const hint = isAuthenticated ? undefined : "Log in to react";
	// ⚠️ **Only the press that writes is blocked.** Pressing the direction already chosen takes the
	// vote back, which removes a record rather than creating one and is never refused.
	const blocked = (direction: VoteDirection) => permissionMissing === true && mine !== direction;
	const boxed = variant === "boxed";
	const shellClass = boxed
		? "inline-flex items-center gap-2"
		: "inline-flex items-center gap-1 text-base-content/50";
	// The boxed pair takes its shape from the Recommend / Don't Recommend buttons
	// (WorkReviews): outlined until it is the one chosen, and then it wears its
	// answer's color — up in primary, down in error. Icon-only, so each direction
	// gets its own color choice here rather than a shared one.
	const upClass = boxed
		? `btn btn-sm ${mine === "up" ? "btn-primary" : "btn-outline"}`
		: "hover:text-primary disabled:opacity-40 disabled:hover:text-base-content/50";
	const downClass = boxed
		? `btn btn-sm ${mine === "down" ? "btn-error" : "btn-outline"}`
		: "hover:text-primary disabled:opacity-40 disabled:hover:text-base-content/50";

	return (
		<span className={shellClass}>
			<button
				type="button"
				className={upClass}
				disabled={disabled || blocked("up")}
				title={hint ?? (blocked("up") ? INTERACTION_PERMISSION_HINT : "Upvote")}
				aria-pressed={mine === "up"}
				aria-label={`Upvote ${label}`}
				onClick={() => vote("up")}
			>
				<Up className={boxed ? "h-5 w-5" : "h-4 w-4"} />
				{/* The count rides the button in the boxed variant — the number the display
				    was asked for, YouTube's shape with the down side filled in too. */}
				{boxed && detail !== null && (
					<span className="min-w-6 text-center text-sm tabular-nums">{detail.up}</span>
				)}
			</button>
			{/* The net between the buttons is the subtle variant's whole display: it is
			    what ordered the thread. The boxed variant shows the pair on the buttons
			    instead, and only keeps this when the counts have not arrived — the score
			    never disappears while the figures it is made of are unknown. */}
			{(!boxed || detail === null) && (
				<span className="min-w-4 text-center text-xs tabular-nums" aria-hidden="true">
					{shown}
				</span>
			)}
			<span className="sr-only">{`${label}: score ${shown}`}</span>
			{/* ⭐ Only an author ever sees this line, and only in the subtle variant — a
			    thread payload serves the raw counts to the row's author alone. The public
			    number is one figure so a pile-on has no counter to run up; the person whose
			    words they are gets the figures, because withholding them from them protects
			    nobody. */}
			{!boxed && detail && (
				<span className="ml-1 text-xs text-base-content/40">
					{detail.up} up, {detail.down} down
				</span>
			)}
			<button
				type="button"
				className={downClass}
				disabled={disabled || blocked("down")}
				title={hint ?? (blocked("down") ? INTERACTION_PERMISSION_HINT : "Downvote")}
				aria-pressed={mine === "down"}
				aria-label={`Downvote ${label}`}
				onClick={() => vote("down")}
			>
				<Down className={boxed ? "h-5 w-5" : "h-4 w-4"} />
				{boxed && detail !== null && (
					<span className="min-w-6 text-center text-sm tabular-nums">{detail.down}</span>
				)}
			</button>
		</span>
	);
}
