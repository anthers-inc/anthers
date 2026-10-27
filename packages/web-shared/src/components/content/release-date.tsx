// SPDX-License-Identifier: Apache-2.0
/**
 * The **release date** as an editable field — the vocabulary and the schedule input the
 * Works table's Release Date column renders, kept here so its words cannot drift from the
 * Work page's own Release field (which carries the same acts, with a Now button, and whose
 * explainer lives beside this).
 *
 * The acts are the server's own: release now (`visibility: "released"`, which supersedes any
 * schedule), schedule (`visibility: "private"` plus a future `scheduledReleaseAt`), clear a
 * schedule, and unrelease. The table's cell commits each act as it is taken; a Work's page
 * keeps its InlineField model around the same acts.
 */

import { PencilSquareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { isoToLocalInput, localInputToIso } from "../../lib/local-datetime";
import type { Work } from "../../lib/types";

/** The fields of one release act, as `PATCH /works/:id` takes them. */
export interface WorkReleaseFields {
	visibility?: "private" | "released";
	scheduledReleaseAt?: string | null;
}

/**
 * The hint under the schedule input — the sentences the Work page's Release field has
 * carried since the schedule existed, moved here so the table's cell says the same
 * things. The passed-time case reads the SAVED instant, not the draft: an unchanged
 * schedule whose time has gone by is the state "it releases as soon as it's ready".
 */
export function releaseScheduleHint(draft: string, savedIso: string | null | undefined): string {
	const draftIso = localInputToIso(draft);
	if (!draftIso) return "Pick a time and save, and it releases then on its own.";
	if (draft === isoToLocalInput(savedIso) && Date.parse(savedIso ?? "") <= Date.now()) {
		return "Its release time has passed. It goes out as soon as its file has finished uploading, processing and being checked.";
	}
	return "It releases at this time once it's ready, and if its file is still uploading or processing then, as soon as that finishes. If something only you can fix stops it, the schedule is cleared and we'll email you.";
}

/**
 * The Work page's Release field explainer, on the (i) beside the field's label (Parker,
 * 2026-10-23). It carries what the field no longer prints under itself: what "released"
 * means, what an empty field and a future time each do, and what a passed time does.
 */
export const RELEASE_FIELD_HINT =
	"Released means listed publicly, and it does not mean free — the Access tab decides that. " +
	"Leave it empty and the Work stays private. A future time schedules it, and it goes out then once " +
	"it's ready; if its file is still uploading or processing, as soon as that finishes. A time that " +
	"has already passed releases it straight away. If something only you can fix stops a scheduled " +
	"release, the schedule is cleared and we'll email you.";

/**
 * The "Or release it later" row: the local-time input and its Clear. The commit is the
 * caller's — the table's cell commits with its Schedule button — so this is the input and
 * its hint, not a save.
 */
export function ReleaseScheduleInput({
	value,
	savedIso,
	onChange,
}: {
	/** The draft as the input holds it (local time, no zone). */
	value: string;
	/** The stored schedule instant, for the hint's passed-time case. */
	savedIso?: string | null;
	onChange: (next: string) => void;
}) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-sm">Or release it later</span>
			<div className="flex flex-wrap items-center gap-2">
				<input
					type="datetime-local"
					className="input input-bordered input-sm"
					aria-label="Release time"
					value={value}
					onChange={(e) => onChange(e.target.value)}
				/>
				{value && (
					<button type="button" className="btn btn-ghost btn-xs" onClick={() => onChange("")}>
						Clear
					</button>
				)}
			</div>
			<p className="text-xs text-base-content/50">{releaseScheduleHint(value, savedIso)}</p>
		</div>
	);
}

/** The date a Release Date cell shows, formatted the table's quiet way. */
export function releaseDateText(work: Work): string {
	if (work.visibility === "released" && work.releasedAt) {
		return new Date(work.releasedAt).toLocaleString(undefined, { dateStyle: "medium" });
	}
	if (work.scheduledReleaseAt) {
		return `Scheduled for ${new Date(work.scheduledReleaseAt).toLocaleString(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		})}`;
	}
	return "—";
}

const PENCIL = "btn btn-ghost btn-xs text-base-content/40 hover:text-base-content/80";

/**
 * The Works table's Release Date cell: the release date as a read line, opened for
 * editing by the pencil the Work page's fields use, carrying the page's acts — publish
 * now, schedule, clear a schedule, unrelease — each committing itself.
 *
 * ⭐ **The blocked reasons ride the publish-now button**, not a tooltip on the cell: the
 * server refuses a release whose media is still processing, whose rating has an
 * unanswered row, whose file never arrived, whose thumbnail is unchosen or whose
 * delivery switches are all off — and the row's own links are how a creator acts on
 * those. `blocked` says the click would be refused; `blockedWhy` is the reason, on the
 * button's title where the click it disables would have been.
 */
export function WorkReleaseCell({
	item,
	blocked,
	blockedWhy,
	onRelease,
	busy,
}: {
	item: Work;
	/** Whether publishing now would be refused (a private Work only). */
	blocked?: boolean;
	/** The refusal's reason, in the row's own words. */
	blockedWhy?: string;
	/** One release act, resolved true when it saved; a refusal keeps the cell open. */
	onRelease: (item: Work, fields: WorkReleaseFields) => Promise<boolean>;
	/** True while this row's own release act is in flight. */
	busy?: boolean;
}) {
	const released = item.visibility === "released";
	const [editing, setEditing] = useState(false);
	// The draft follows the stored schedule — adopting the saved value is what closes
	// the loop a commit opens, and a poll that re-reads an unchanged schedule leaves it.
	const [prevScheduled, setPrevScheduled] = useState(item.scheduledReleaseAt ?? null);
	const [draft, setDraft] = useState(() => isoToLocalInput(item.scheduledReleaseAt));
	if ((item.scheduledReleaseAt ?? null) !== prevScheduled) {
		setPrevScheduled(item.scheduledReleaseAt ?? null);
		setDraft(isoToLocalInput(item.scheduledReleaseAt));
	}

	const act = async (fields: WorkReleaseFields) => {
		if (await onRelease(item, fields)) setEditing(false);
	};

	if (!editing) {
		return (
			<div className="flex items-center gap-1 whitespace-nowrap text-sm text-base-content/70">
				<span className="min-w-0">{releaseDateText(item)}</span>
				<button
					type="button"
					aria-label="Edit Release Date"
					title="Edit Release Date"
					className={`${PENCIL} shrink-0`}
					onClick={() => setEditing(true)}
				>
					<PencilSquareIcon className="size-4" />
				</button>
			</div>
		);
	}

	const draftIso = localInputToIso(draft);
	// The schedule button commits whatever the input holds, so it is labeled by what it
	// does: a time schedules it, an emptied input clears the stored schedule.
	const scheduleLabel = draft
		? "Schedule"
		: item.scheduledReleaseAt
			? "Clear schedule"
			: "Schedule";

	return (
		<div className="flex flex-col gap-2 text-sm">
			{released ? (
				<>
					{item.releasedAt && (
						<p className="text-base-content/70">
							Released{" "}
							{new Date(item.releasedAt).toLocaleString(undefined, { dateStyle: "medium" })}
						</p>
					)}
					<button
						type="button"
						className="btn btn-ghost btn-xs w-fit"
						disabled={busy}
						onClick={() => void act({ visibility: "private" })}
					>
						{busy ? "Unreleasing…" : "Unrelease"}
					</button>
				</>
			) : (
				<>
					<button
						type="button"
						className="btn btn-primary btn-xs w-fit"
						disabled={busy || blocked}
						title={blocked ? blockedWhy : "Put this in your public Catalog now"}
						onClick={() => void act({ visibility: "released" })}
					>
						Release now
					</button>
					<ReleaseScheduleInput
						value={draft}
						savedIso={item.scheduledReleaseAt}
						onChange={setDraft}
					/>
					<div className="flex flex-wrap items-center gap-1">
						<button
							type="button"
							className="btn btn-xs"
							// An emptied input with nothing stored schedules nothing; the
							// server would refuse the null-with-no-change nothing anyway.
							disabled={busy || (!draft && !item.scheduledReleaseAt)}
							onClick={() =>
								void act({
									visibility: "private",
									scheduledReleaseAt: draftIso,
								})
							}
						>
							{scheduleLabel}
						</button>
					</div>
				</>
			)}
			<button
				type="button"
				aria-label="Cancel editing the release date"
				title="Close"
				className="btn btn-ghost btn-xs w-fit"
				onClick={() => {
					setDraft(isoToLocalInput(item.scheduledReleaseAt));
					setEditing(false);
				}}
			>
				<XMarkIcon className="size-4" />
			</button>
		</div>
	);
}
