// SPDX-License-Identifier: Apache-2.0
/**
 * The creator's **editing primitives** — the one set of parts that put a pencil beside
 * what a user reads.
 *
 * ⭐ **The model is per-field save** (Parker, 2026-10-13): if you are the creator, every
 * editable field shows a little pencil; clicking it opens that field for edit, at which
 * point the pencil is replaced by an X (cancel) and a checkmark (save). A field saves
 * itself — there is no page-wide Save button — so what "the user sees" and what is
 * stored never stand further apart than one control.
 *
 * The read state is the user's version rendered by the very same parts the page draws
 * (`WorkLayout.tsx`'s rule); only what opens when the pencil is clicked is a working
 * control. That is why `renderRead` is this primitive's first half and `renderEdit` its
 * second: the two are siblings describing one field, and what the check commits shows up
 * in the read the user meets.
 *
 * 🚨 **A field's UI carries its own unsettled work.** While an upload inside a field's
 * edit state is still on the wire, the check stays disabled — the settled value is the
 * only one worth storing (this is the rule the batch-save version raced into work 23's
 * lost thumbnail); and an open edit does not survive navigating away, because saving is
 * the exit, not a background act.
 */

import { CheckIcon, PencilSquareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useRef, useState } from "react";
import { keepScroll } from "./scrollKeeper";

const PENCIL =
	// Always visible (Parker, 2026-10-16) — hover-reveal was the rule while an unfilled field
	// could leave nothing to hover; every field now renders its structure at every value,
	// so the pencil sits in the open as the edit affordance it is.
	"btn btn-ghost btn-xs text-base-content/40 hover:text-base-content/80";

/**
 * One editable field: what a user reads, with a pencil that opens it, an X that cancels
 * and a checkmark that saves the field alone.
 *
 * The field is generic over its value; the call site narrows the draft to its own shape
 * when it passes `renderEdit` and `save` — the primitive only owns the opening, the
 * closing and the waiting.
 *
 * ⭐ **The pencil rides the content, not the field's edge** (Parker, 2026-10-16): the
 * read view and the pencil sit in one top-aligned flex row whose content hugs what it
 * renders, so the pencil lands beside the thing it edits — a centered title's pencil
 * beside the title, a description's beside its last full line — rather than at the far
 * edge of a full-width edit area. `rowAlign="center"` centers the pair as a group, which
 * a centered title's slot passes; everything else keeps the page's left column. The
 * `-mt-1` lifts the pencil toward the first text line's ascent, the corner it used to sit on.
 */
export function InlineField<V>({
	label,
	saved,
	renderRead,
	renderEdit,
	save,
	disabledReason,
	className = "",
	rowAlign = "start",
	fill = false,
}: {
	/** Names the field for the pencil and the screen reader. */
	label: string;
	/** The value on the row, as loaded or as last saved into. */
	saved: V;
	/** The user's version — the page's own rendering of the field. */
	renderRead: () => ReactNode;
	/**
	 * The working control; the draft value and its setter are the edit's whole state, and
	 * `close` is how an act inside the edit that settled by itself (the server saved it)
	 * returns the field to its read state — the check is for a save, and an act that
	 * already saved is not one.
	 */
	renderEdit: (draft: V, onChange: (next: V) => void, close: () => void) => ReactNode;
	/** Commit the draft; a throw leaves the field open with the error shown. */
	save: (draft: V) => Promise<void>;
	/** Set when the field cannot open — said beside the read view, never as silence. */
	disabledReason?: string;
	className?: string;
	/**
	 * The stage's fill (the listened Work's aside column — see `ListenStage`): the
	 * field's root and its read row take the column's whole box, so the words the
	 * user reads and the creator edits fill the media area beside the waveform.
	 * Default is the page-row field everywhere else, sized by its content.
	 */
	fill?: boolean;
	/** Whether the read row centers its content-and-pencil pair (a centered title). */
	rowAlign?: "start" | "center";
}) {
	const [mode, setMode] = useState<"read" | "edit" | "busy">("read");
	const [draft, setDraft] = useState<V>(saved);
	const [error, setError] = useState<string | null>(null);
	/** The field's own root, the anchor `keepScroll` measures the page's scroller from. */
	const rootRef = useRef<HTMLDivElement | null>(null);

	const commit = async () => {
		if (mode === "busy") return;
		setMode("busy");
		setError(null);
		try {
			await save(draft);
			// Saved — back to the read view. The saved field is shorter than the working
			// one usually, and a shorter page must not cost the reader their place.
			keepScroll(rootRef.current, () => setMode("read"));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save this just now.");
			setMode("edit");
		}
	};

	return (
		<div ref={rootRef} className={`group relative ${fill ? "h-full w-full" : ""} ${className}`}>
			{mode === "read" ? (
				<div
					className={`flex gap-1 ${fill ? "h-full w-full items-stretch" : "items-start"} ${
						rowAlign === "center" && !fill ? "justify-center" : ""
					}`}
				>
					<div className={`min-w-0 ${fill ? "flex w-full min-h-0" : ""}`}>{renderRead()}</div>
					{!disabledReason ? (
						<button
							type="button"
							aria-label={`Edit ${label}`}
							title={`Edit ${label}`}
							className={`${PENCIL} -mt-1 shrink-0 self-start`}
							onClick={() =>
								// Opening for edit usually makes the page taller — and whatever it
								// does to the height, the place stays (scroll-keeper's rule).
								keepScroll(rootRef.current, () => {
									setDraft(saved);
									setError(null);
									setMode("edit");
								})
							}
						>
							<PencilSquareIcon className="size-4" />
						</button>
					) : (
						<span
							className="shrink-0 self-start text-xs text-base-content/40"
							title={disabledReason}
						>
							{disabledReason}
						</span>
					)}
				</div>
			) : (
				<div className="space-y-2">
					{renderEdit(draft, setDraft, () => {
						// Cancel — the field shrinks back to its read view; the place stays.
						keepScroll(rootRef.current, () => {
							setDraft(saved);
							setError(null);
							setMode("read");
						});
					})}
					{error && <p className="text-xs text-error">{error}</p>}
					<div className="flex items-center gap-1">
						{mode === "busy" ? (
							<span className="text-xs text-base-content/60">Saving…</span>
						) : (
							<>
								<button
									type="button"
									aria-label={`Cancel editing ${label}`}
									title="Discard"
									className="btn btn-ghost btn-xs"
									onClick={() =>
										keepScroll(rootRef.current, () => {
											setDraft(saved);
											setError(null);
											setMode("read");
										})
									}
								>
									<XMarkIcon className="size-4" />
								</button>
								<button
									type="button"
									aria-label={`Save ${label}`}
									title="Save"
									className="btn btn-success btn-xs"
									onClick={() => void commit()}
								>
									<CheckIcon className="size-4" />
								</button>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
