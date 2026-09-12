// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A like, a dislike, and the one number they add up to.
 *
 * ⭐ **One number is shown, never two** (Parker, 2026-09-04). A dislike does visible work by
 * pulling the score down, and a pile-on gets no dislike counter to run up. The alternative
 * Parker rejected outright is hiding the dislike: *"Having a dislike that has no visible
 * impact on a value the user can see is the worst case scenario."*
 *
 * ⭐ **What this shows is what ordered the thread.** The score is the ranking key, so a
 * reader can always account for the order from what is in front of them. `@anthers/shared/votes`
 * carries why the published number and the sort key have to be the same one.
 *
 * ⚠️ **Optimistic, and it reconciles with the server rather than trusting itself.** The
 * server returns the recomputed score, because the local guess is wrong the moment anybody
 * else has reacted since the page loaded — and a score that drifts from its rows looks
 * exactly like a score.
 */

import type { VoteDirection } from "@anthers/shared/votes";
import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import { HandThumbDownIcon, HandThumbUpIcon } from "@heroicons/react/24/outline";
import {
	HandThumbDownIcon as HandThumbDownSolid,
	HandThumbUpIcon as HandThumbUpSolid,
} from "@heroicons/react/24/solid";
import { useEffect, useState } from "react";

export type VoteSubject = "work" | "post" | "comment";

/** A direction as the number it contributes to a net score. Null contributes nothing. */
function weight(d: VoteDirection | null): number {
	return d === "up" ? 1 : d === "down" ? -1 : 0;
}

export default function VoteControl({
	subjectType,
	subjectId,
	score,
	viewerVote,
	up,
	down,
	label,
	onChange,
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
	viewerVote?: VoteDirection | null;
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
	onChange?: (next: {
		score: number;
		collapsed: boolean;
		viewerVote: VoteDirection | null;
	}) => void;
}) {
	const { isAuthenticated } = useAuth();
	const given = score !== undefined;
	const [mine, setMine] = useState<VoteDirection | null>(viewerVote ?? null);
	const [shown, setShown] = useState(score ?? 0);
	const [detail, setDetail] = useState<{ up: number; down: number } | null>(
		up === undefined || down === undefined ? null : { up, down },
	);
	const [busy, setBusy] = useState(false);
	// Starts hidden when it has to ask, so a control does not flash "0" and then correct
	// itself — a score that changes on its own reads as somebody else having just voted.
	const [ready, setReady] = useState(given);

	useEffect(() => {
		if (given) return;
		let live = true;
		client.api.content.votes
			.$get({ query: { subjectType, subjectId: String(subjectId) } })
			.then(async (res) => {
				if (!res.ok || !live) return;
				const data = (await res.json()) as {
					score: number;
					viewerVote: VoteDirection | null;
					up?: number;
					down?: number;
				};
				setShown(data.score);
				setMine(data.viewerVote);
				if (data.up !== undefined && data.down !== undefined) {
					setDetail({ up: data.up, down: data.down });
				}
				setReady(true);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [given, subjectType, subjectId]);

	async function vote(direction: VoteDirection) {
		if (!isAuthenticated || busy) return;
		setBusy(true);
		// Pressing the button you already pressed takes the vote back, which is the only
		// way to return to having said nothing — distinct from saying the opposite.
		const next = mine === direction ? null : direction;
		const before = { mine, shown };
		setMine(next);
		// Floored locally too, so the optimistic number can never be one the server would
		// not publish.
		setShown((s) => Math.max(0, s - weight(mine) + weight(next)));
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
				viewerVote: VoteDirection | null;
				up?: number;
				down?: number;
			};
			setShown(data.score);
			// An author reacting to their own thing has to see their own vote land in the
			// breakdown too, or the two numbers on screen disagree until a reload.
			if (data.up !== undefined && data.down !== undefined) {
				setDetail({ up: data.up, down: data.down });
			}
			setMine(next);
			onChange?.({ ...data, viewerVote: next });
		} catch {
			// Put it back. A control that silently keeps an optimistic value it failed to
			// save is telling the reader their vote counted when it did not.
			setMine(before.mine);
			setShown(before.shown);
		} finally {
			setBusy(false);
		}
	}

	if (!ready) return null;

	const Up = mine === "up" ? HandThumbUpSolid : HandThumbUpIcon;
	const Down = mine === "down" ? HandThumbDownSolid : HandThumbDownIcon;
	const disabled = !isAuthenticated || busy;
	const hint = isAuthenticated ? undefined : "Log in to react";

	return (
		<span className="inline-flex items-center gap-1 text-base-content/50">
			<button
				type="button"
				className="hover:text-primary disabled:opacity-40 disabled:hover:text-base-content/50"
				disabled={disabled}
				title={hint ?? "Upvote"}
				aria-pressed={mine === "up"}
				aria-label={`Upvote ${label}`}
				onClick={() => vote("up")}
			>
				<Up className="h-4 w-4" />
			</button>
			{/* The number twice, on purpose: sighted readers get the digit between the two
			    buttons, and a screen reader gets a sentence. A lone integer announced as "5"
			    says nothing about what it counts, and this number is the entire published
			    state of the feature. */}
			<span className="min-w-4 text-center text-xs tabular-nums" aria-hidden="true">
				{shown}
			</span>
			<span className="sr-only">{`${label}: score ${shown}`}</span>
			{/* ⭐ Only an author ever gets here. The public number is deliberately one figure
			    so a pile-on has no counter to run up; the person whose work it is gets the
			    figures, because withholding them from them protects nobody. */}
			{detail && (
				<span className="ml-1 text-xs text-base-content/40">
					{detail.up} up, {detail.down} down
				</span>
			)}
			<button
				type="button"
				className="hover:text-primary disabled:opacity-40 disabled:hover:text-base-content/50"
				disabled={disabled}
				title={hint ?? "Downvote"}
				aria-pressed={mine === "down"}
				aria-label={`Downvote ${label}`}
				onClick={() => vote("down")}
			>
				<Down className="h-4 w-4" />
			</button>
		</span>
	);
}
