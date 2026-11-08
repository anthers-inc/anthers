// SPDX-License-Identifier: Apache-2.0
/**
 * A **setup checklist** — the conditions standing between somebody and an act, drawn as a
 * progress bar and a short list. One component behind two surfaces: the floating guide on a
 * Work's page and the creator-onboarding card at the top of the Studio's Works page.
 *
 * ⭐ **The two placements are the same object in different containers.** `floating` starts
 * open and collapses to a round button that keeps the completed count; `inline` is a card in
 * the page's flow, rendered while there is still something to do. The caller owns where the
 * floating card is pinned, because that depends on the shell's fixed bars rather than on the
 * card itself.
 *
 * 🚨 **The items are the rule's own conditions, never a second definition of ready.** The
 * caller derives them from the same predicates the server reads, so the card cannot say a
 * thing is done while the act refuses it. A **done** row is satisfied; a **todo** row is the
 * person's to fix and opens the place it is fixed; a **waiting** row resolves without them
 * and is muted rather than offered as an act.
 */

import {
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
	variant = "inline",
}: {
	/** The checklist's name, in title case — "Work Setup Checklist", "Creator Setup Checklist". */
	title: string;
	/** What the list is for, in one sentence — the caller's copy. */
	intro: string;
	items: SetupChecklistItem[];
	/**
	 * `floating` is the Work page's corner card, collapsible to a button; `inline` is the
	 * Studio's onboarding card, which lives in the page's flow and is rendered only while
	 * something is left to do.
	 */
	variant?: "floating" | "inline";
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
							<Link
								to={item.href}
								className={rowClass}
								onClick={variant === "floating" ? () => setOpen(false) : undefined}
							>
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
									// The floating card gets out of the way of the control it just
									// opened; the inline card stays for its other rows.
									if (variant === "floating") setOpen(false);
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

	if (variant === "inline") {
		return (
			<section
				aria-label={title}
				className="rounded-xl border border-base-300 bg-base-100 shadow-sm"
			>
				<div className="flex flex-col gap-4 p-4 md:flex-row md:items-start">
					<div className="md:w-72 md:shrink-0">
						<h2 className="text-sm font-semibold">{title}</h2>
						<p className="mt-1 text-sm text-base-content/60">{intro}</p>
						<div className="mt-3 flex flex-col gap-1">
							{progress}
							<p className="text-xs text-base-content/50">
								{allSet ? "Everything on this list is set." : `${done} of ${total} done`}
							</p>
						</div>
					</div>
					<div className="min-w-0 flex-1">{rows}</div>
				</div>
			</section>
		);
	}

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
		<aside
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
			</div>
			<div className="p-3">{rows}</div>
		</aside>
	);
}
