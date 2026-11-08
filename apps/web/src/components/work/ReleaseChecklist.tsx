// SPDX-License-Identifier: Apache-2.0
/**
 * The Work's **release checklist** — what is still standing between this Work and its
 * release, floating in the page's bottom-right corner where a creator can see it while
 * they work.
 *
 * ⭐ **It starts open and collapses to a button that keeps the progress.** The open state
 * is this page's own and is never stored: a creator who closes it while working should
 * meet it open again on their next visit, because the point of the card is to be found
 * without remembering to look.
 *
 * 🚨 **The items are the release refusal's conditions, not a second definition of ready.**
 * The caller derives them from the same predicates `releaseRefusal` in
 * `services/work-release.ts` and the Release field read, in the server's order, so the
 * card cannot say a Work is ready while the server refuses it. The card only says how far
 * along the Work is; the release gate decides.
 *
 * The states are the server's own split: a **done** item is satisfied, a **todo** item is
 * the creator's to fix and opens the place it is fixed, and a **waiting** item resolves
 * without them — a file in flight, media still processing, a rung Anthers has closed —
 * so it is muted rather than offered as an act.
 */

import { Link } from "@anthers/web-shared/router";
import {
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClipboardDocumentCheckIcon,
	ClockIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";
import { useMediaPlayer } from "../../lib/media-player";

/** One condition standing between a Work and its release, as the card draws it. */
export interface ReleaseChecklistItem {
	key: string;
	label: string;
	state: "done" | "todo" | "waiting";
	/**
	 * What the Release field says when this is the first condition still standing, in the
	 * server's own words where it has them. The card does not print it; it exists so the
	 * card's first unfinished item and the release control cannot disagree.
	 */
	refusal?: string;
	/** Where the fix lives, when it is a Studio page rather than this page. */
	href?: string;
	/** The act on this page that takes the creator to the fix: a tab, the media manager. */
	onOpen?: () => void;
}

/** The circle a todo item draws in place of the done check. */
function TodoMark() {
	return (
		<span
			aria-hidden="true"
			className="inline-block size-4 shrink-0 rounded-full border-2 border-base-content/25"
		/>
	);
}

export default function ReleaseChecklist({ items }: { items: ReleaseChecklistItem[] }) {
	const [open, setOpen] = useState(true);
	const player = useMediaPlayer();
	const done = items.filter((item) => item.state === "done").length;
	const total = items.length;
	const allSet = done === total;

	/**
	 * The card stands above the shell's fixed bars rather than under them: the persistent
	 * player is `z-50` and the phone tab bar owns the bottom edge, so the offset rises
	 * when a track is playing and stays clear of the tab bar on a phone either way.
	 */
	const offset = player.currentTrack ? "bottom-40 sm:bottom-24" : "bottom-28 sm:bottom-6";

	if (!open) {
		return (
			<button
				type="button"
				className={`btn btn-circle btn-primary fixed right-4 z-40 size-14 shadow-lg sm:right-6 ${offset}`}
				aria-label={`Open the Release Checklist: ${done} of ${total} done`}
				title="Release Checklist"
				onClick={() => setOpen(true)}
			>
				<ClipboardDocumentCheckIcon aria-hidden="true" className="size-6" />
				<span
					aria-hidden="true"
					className="absolute -right-1 -top-1 rounded-full bg-base-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-base-content shadow"
				>
					{done}/{total}
				</span>
			</button>
		);
	}

	return (
		<aside
			aria-label="Release Checklist"
			className={`fixed right-4 z-40 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-base-300 bg-base-100/95 shadow-xl backdrop-blur sm:right-6 ${offset}`}
		>
			<div className="flex items-start gap-2 px-3 pb-2 pt-3">
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-semibold">Release Checklist</h2>
					<p className="text-xs text-base-content/60">
						{allSet ? "Everything on this list is set." : `${done} of ${total} done`}
					</p>
				</div>
				<button
					type="button"
					className="btn btn-ghost btn-xs btn-circle -mt-1 -mr-1"
					aria-label="Close the Release Checklist"
					onClick={() => setOpen(false)}
				>
					<ChevronDownIcon aria-hidden="true" className="size-4" />
				</button>
			</div>

			<div id="release-checklist-panel">
				<div className="px-3 pb-2">
					<progress
						className="progress progress-primary h-1.5 w-full"
						value={done}
						max={total}
						aria-label={`${done} of ${total} done`}
					/>
				</div>
				<ul className="flex flex-col gap-2 px-3 pb-3">
					{items.map((item) => {
						const mark =
							item.state === "done" ? (
								<CheckCircleIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
							) : item.state === "waiting" ? (
								<ClockIcon aria-hidden="true" className="size-4 shrink-0 text-base-content/30" />
							) : (
								<TodoMark />
							);
						const row = (
							<>
								{mark}
								<span className={`text-sm ${item.state === "todo" ? "" : "text-base-content/50"}`}>
									{item.label}
								</span>
							</>
						);
						const state =
							item.state === "done" ? "Done: " : item.state === "waiting" ? "Waiting: " : "";

						if (item.state !== "todo" || (!item.href && !item.onOpen)) {
							return (
								<li key={item.key} className="flex items-center gap-2">
									{state && <span className="sr-only">{state}</span>}
									{row}
								</li>
							);
						}

						const rowClass =
							"flex w-full items-center gap-2 rounded-md text-left hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
						const go = (
							<ChevronRightIcon
								aria-hidden="true"
								className="ml-auto size-3.5 shrink-0 text-base-content/30"
							/>
						);
						return (
							<li key={item.key}>
								{item.href ? (
									<Link to={item.href} className={rowClass} onClick={() => setOpen(false)}>
										{row}
										{go}
									</Link>
								) : (
									<button
										type="button"
										className={rowClass}
										onClick={() => {
											item.onOpen?.();
											setOpen(false);
										}}
									>
										{row}
										{go}
									</button>
								)}
							</li>
						);
					})}
				</ul>
			</div>
		</aside>
	);
}
