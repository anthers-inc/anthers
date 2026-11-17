// SPDX-License-Identifier: Apache-2.0
/**
 * A **setup checklist** — the conditions standing between somebody and an act, drawn as a
 * progress bar and a short list in a card pinned to the page's lower-right corner.
 *
 * ⭐ **One component behind every checklist in the app.** The Work's own release gate, the
 * creator's account setup, the creator's first steps and the user's orientation are the
 * same object in the same corner, so a person meets one vocabulary rather than four
 * designs. The card starts open and collapses to a round button that keeps the completed
 * count.
 *
 * 🚨 **The items are the rule's own conditions, never a second definition of ready.** The
 * caller derives them from the same predicates the server reads, so the card cannot say a
 * thing is done while the act refuses it. A **done** row is satisfied; a **todo** row is the
 * person's to fix and opens the place it is fixed; a **waiting** row resolves without them
 * and is muted rather than offered as an act.
 *
 * ⚠️ **Where it is pinned is the caller's**, because clearing the shell's fixed bars (the
 * player, the phone tabs) depends on where the card is mounted rather than on the card.
 * `checklistCornerClass` is that decision, in one place, for every surface.
 */

import {
	ArrowTopRightOnSquareIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ClipboardDocumentCheckIcon,
	ClockIcon,
} from "@heroicons/react/24/outline";
import { type ReactNode, useState } from "react";
import { Link } from "../../lib/router";

/** One condition on a setup checklist, as the card draws it. */
export interface SetupChecklistItem {
	key: string;
	label: ReactNode;
	state: "done" | "todo" | "waiting";
	/** Where the fix lives, when it is another page rather than this one. */
	href?: string;
	/** The act on this page that takes the person to the fix: a tab, the media manager. */
	onOpen?: () => void;
}

/**
 * Where a floating checklist sits.
 *
 * ⭐ **The player bar owns the bottom of the shell when something is playing**, so the card
 * lifts above it; on a phone the tab bar already holds the bottom edge, which is why the
 * base offset is taller than the desktop one. Every surface that pins a checklist uses
 * this, so the four cards never sit at three different heights.
 */
export function checklistCornerClass(playerUp: boolean): string {
	return `fixed right-4 z-40 sm:right-6 ${playerUp ? "bottom-40 sm:bottom-24" : "bottom-28 sm:bottom-6"}`;
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

export default function SetupChecklist({
	title,
	intro,
	items,
	guide,
	onDismiss,
	dismissLabel = "Dismiss",
}: {
	/** The checklist's name, in title case — "Work Setup Checklist", "Creator Setup Checklist". */
	title: string;
	/** What the list is for, in one sentence — the caller's copy. */
	intro: string;
	items: SetupChecklistItem[];
	/**
	 * The walkthrough that covers the whole list, for a caller whose checklist has one. The
	 * wiki's tutorial pages are the long form of the same sequence; the card stays the short
	 * form, and this is the door between them.
	 */
	guide?: { label: string; href: string };
	/**
	 * Put the card away for good, when the caller has somewhere to record that. ⚠️ **Only
	 * guidance lists take one.** A checklist standing between somebody and an act is the
	 * rule's own conditions, so it leaves when they are met rather than when it is closed;
	 * the caller decides which kind it has and passes this only for the other.
	 */
	onDismiss?: () => void;
	/** What the dismiss control says, when the caller has a better word for the act. */
	dismissLabel?: string;
}) {
	const [open, setOpen] = useState(true);
	const done = items.filter((item) => item.state === "done").length;
	const total = items.length;
	const allSet = done === total;

	const rows = (
		<ul className="flex flex-col gap-2">
			{items.map((item) => {
				const mark =
					item.state === "done" ? (
						<CheckCircleIcon aria-hidden="true" className="size-4 shrink-0 text-success" />
					) : item.state === "waiting" ? (
						<ClockIcon aria-hidden="true" className="size-4 shrink-0 text-base-content/30" />
					) : (
						<TodoMark />
					);
				const label = (
					<span className={`text-sm ${item.state === "todo" ? "" : "text-base-content/50"}`}>
						{item.label}
					</span>
				);
				const state =
					item.state === "done" ? "Done: " : item.state === "waiting" ? "Waiting: " : "";

				if (item.state !== "todo" || (!item.href && !item.onOpen)) {
					return (
						<li key={item.key} className="flex items-center gap-2">
							{state && <span className="sr-only">{state}</span>}
							{mark}
							{label}
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
								{mark}
								{label}
								{go}
							</Link>
						) : (
							<button
								type="button"
								className={rowClass}
								onClick={() => {
									item.onOpen?.();
									// The card gets out of the way of the control it just opened.
									setOpen(false);
								}}
							>
								{mark}
								{label}
								{go}
							</button>
						)}
					</li>
				);
			})}
		</ul>
	);

	const progress = (
		<progress
			className="progress progress-primary h-1.5 w-full"
			value={done}
			max={total}
			aria-label={`${done} of ${total} done`}
		/>
	);

	/**
	 * The way off a guidance list, and never off a gate: the caller only passes `onDismiss`
	 * for the first kind (see the prop's note). Quiet rather than a second button, because
	 * it is the smallest act the card offers and the one a person is least likely to want
	 * to do by accident.
	 */
	const dismiss = onDismiss ? (
		<button
			type="button"
			className="mt-3 text-xs text-base-content/50 underline-offset-2 hover:text-base-content hover:underline"
			onClick={onDismiss}
		>
			{dismissLabel}
		</button>
	) : null;

	if (!open) {
		return (
			<button
				type="button"
				className="btn btn-circle btn-primary relative size-14 shadow-lg"
				aria-label={`Open the ${title}: ${done} of ${total} done`}
				title={title}
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
		<section
			aria-label={title}
			className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-base-300 bg-base-100/95 shadow-xl backdrop-blur"
		>
			<div className="flex items-start gap-2 px-3 pb-2 pt-3">
				<div className="min-w-0 flex-1">
					<h2 className="text-sm font-semibold">{title}</h2>
					<p className="mt-0.5 text-xs text-base-content/60">{intro}</p>
				</div>
				<button
					type="button"
					className="btn btn-ghost btn-xs btn-circle -mt-1 -mr-1"
					aria-label={`Collapse the ${title}`}
					onClick={() => setOpen(false)}
				>
					<ChevronDownIcon aria-hidden="true" className="size-4" />
				</button>
			</div>

			<div className="px-3">
				{progress}
				<p className="mt-1 text-xs text-base-content/50">
					{allSet ? "Everything on this list is set." : `${done} of ${total} done`}
				</p>
				{guide && (
					<a
						href={guide.href}
						target="_blank"
						rel="noreferrer"
						className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
					>
						{guide.label}
						<ArrowTopRightOnSquareIcon aria-hidden="true" className="size-3" />
					</a>
				)}
			</div>
			<div className="p-3">
				{rows}
				{dismiss}
			</div>
		</section>
	);
}
