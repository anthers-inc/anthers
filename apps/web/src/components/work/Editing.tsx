// SPDX-License-Identifier: Apache-2.0
/**
 * The creator's **editing primitives** — the one set of parts that put a pencil beside
 * what a user reads.
 *
 * ⭐ **A Work is edited by section** (Parker, 2026-11-07): one pencil opens a section's
 * fields together, and the cancel/save pair that replaces it saves only the fields whose
 * values actually changed. `useSectionEdit` carries that shape, and `WorkInfoTabs` pins
 * its action to the panel's top-right; the byline puts the Title section's action in the
 * library Save button's old slot. A section that is really one control — a post's title,
 * the Manage tab's body — uses `InlineField` below, and both share the same pencil and
 * the same pair.
 *
 * ⭐ **The model began as per-field save** (Parker, 2026-10-13): every editable thing shows
 * a pencil; clicking it replaces the pencil with an X (cancel) and a checkmark (save); no
 * page-wide Save exists, so what the user sees and what is stored never stand further
 * apart than one control. The section is the unit now, but the rule is the same.
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
	// so the pencil sits in the open as the edit affordance it is. A bordered, filled
	// button at the pair's size (Parker, 2026-11-07): the pencil is the anchor the save
	// pair replaces, so it has to be the same object as the pair's save half.
	"btn btn-sm border border-base-content/45 bg-base-content/10 text-base-content shadow-sm hover:bg-base-content/20";

/**
 * The bordered, filled wrapper a field's cancel-and-save pair rides in — shared by the
 * inline fields and the Rating table's one-act save, so the two never look like they
 * belong to different applications. A bare ghost X on the page's background is invisible
 * beside a green checkmark; one edge and one fill make both acts read as buttons.
 */
export function FieldActionJoin({ children }: { children: ReactNode }) {
	return (
		<div className="join shrink-0 rounded-lg border border-base-content/25 bg-base-200/80 shadow-sm">
			{children}
		</div>
	);
}

/** The pencil a section or a single field opens its edit state with. */
export function SectionPencil({
	label,
	onClick,
	disabledReason,
}: {
	label: string;
	onClick: () => void;
	disabledReason?: string;
}) {
	if (disabledReason) {
		return (
			<span className="text-xs text-base-content/40" title={disabledReason}>
				{disabledReason}
			</span>
		);
	}
	return (
		<button
			type="button"
			aria-label={`Edit ${label}`}
			title={`Edit ${label}`}
			className={PENCIL}
			onClick={onClick}
		>
			<PencilSquareIcon className="size-4" />
		</button>
	);
}

export interface SectionEdit<V> {
	/** True in both the edit and busy states; the content stays as the creator left it. */
	editing: boolean;
	busy: boolean;
	draft: V;
	setDraft: (next: V) => void;
	/** Why the save was refused, shown under the section by the caller. */
	error: string | null;
	/** The pencil in the read state, the pair in the edit state, "Saving…" while busy. */
	actions: ReactNode;
	cancel: () => void;
	save: () => void;
}

/**
 * One section's edit state and its action node, for a section that owns several fields
 * and commits them in one act (Parker, 2026-11-07). The caller places `actions` wherever
 * the section's pencil belongs — a tab's top-right corner, the byline's action slot — and
 * renders the read or edit body itself. On save the caller diffs the draft against what
 * the row holds and sends only the changed fields.
 */
export function useSectionEdit<V>({
	label,
	saved,
	save,
	disabledSave,
	disabledReason,
}: {
	label: string;
	saved: V;
	save: (draft: V) => Promise<void> | void;
	disabledSave?: (draft: V) => string | undefined;
	disabledReason?: string;
}): SectionEdit<V> {
	const [mode, setMode] = useState<"read" | "edit" | "busy">("read");
	const [draft, setDraft] = useState<V>(saved);
	const [error, setError] = useState<string | null>(null);
	/** The action's own wrapper, the anchor `keepScroll` measures the page's scroller from. */
	const anchorRef = useRef<HTMLDivElement | null>(null);
	// The latest saved value and saver, so opening or committing after a re-render uses
	// the row as it stands rather than the row as it stood at the first render.
	const savedRef = useRef(saved);
	savedRef.current = saved;
	const saveRef = useRef(save);
	saveRef.current = save;
	const saveRefusal = mode === "busy" ? undefined : disabledSave?.(draft);

	const open = () =>
		keepScroll(anchorRef.current, () => {
			setDraft(savedRef.current);
			setError(null);
			setMode("edit");
		});
	const cancel = () =>
		keepScroll(anchorRef.current, () => {
			setDraft(savedRef.current);
			setError(null);
			setMode("read");
		});
	const commit = async () => {
		if (mode === "busy" || saveRefusal) return;
		setMode("busy");
		setError(null);
		try {
			await saveRef.current(draft);
			keepScroll(anchorRef.current, () => setMode("read"));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save this just now.");
			setMode("edit");
		}
	};

	const actions = (
		<div ref={anchorRef} className="inline-flex">
			{mode === "read" ? (
				<SectionPencil label={label} onClick={open} disabledReason={disabledReason} />
			) : mode === "busy" ? (
				<span className="px-1 text-xs text-base-content/60">Saving…</span>
			) : (
				<FieldActionJoin>
					<button
						type="button"
						aria-label={`Cancel editing ${label}`}
						title="Discard"
						className="btn btn-ghost btn-sm join-item text-error hover:bg-error/10 hover:text-error"
						onClick={cancel}
					>
						<XMarkIcon className="size-4" />
					</button>
					<button
						type="button"
						aria-label={`Save ${label}`}
						title={saveRefusal ?? "Save"}
						disabled={saveRefusal !== undefined}
						className="btn btn-success btn-sm join-item"
						onClick={() => void commit()}
					>
						<CheckIcon className="size-4" />
					</button>
				</FieldActionJoin>
			)}
		</div>
	);

	return {
		editing: mode !== "read",
		busy: mode === "busy",
		draft,
		setDraft,
		error,
		actions,
		cancel,
		save: () => void commit(),
	};
}

/**
 * One editable field: what a user reads, with a pencil that opens it, an X that cancels
 * and a checkmark that saves the field alone.
 *
 * The field is generic over its value; the call site narrows the draft to its own shape
 * when it passes `renderEdit` and `save` — the primitive only owns the opening, the
 * closing and the waiting.
 *
 * ⭐ **The pencil is a static corner, and the save pair takes its place** (Parker,
 * 2026-11-07). The pencil used to ride the read content, so a short read view put it a
 * few words from the left while the edit control filled the field and the pair landed at
 * the far right — the eye clicked one place and had to travel to another. Now every
 * field's read row reserves a right-hand action column, the pencil sits at the top of
 * it, and the edit row puts the cancel/save join in the very same column. The content
 * changes shape; the place the eye went does not.
 *
 * ⭐ **The pair is a join with its own fill and edge**, because a bare ghost X on the
 * page's background is invisible next to a green checkmark. The cancel X and the save
 * check share one bordered, filled control, so both acts read as buttons at a glance.
 *
 * ⭐ **A centered title is the one exception: the text alone is centered, and the pencil
 * hangs off its top-right corner** (Parker, 2026-10-19). Centering the read view and the
 * pencil as one group pulls the title off the page's center, so `pencilPlacement="corner"`
 * makes the read view a content-sized block centered by its own margins, with an equal
 * gutter on both sides that keeps the text centered while the pencil hangs in the right
 * one. Capping the block at the column's width means a long title truncates rather than
 * pushing the pencil past the page's edge.
 */
export function InlineField<V>({
	label,
	saved,
	renderRead,
	renderEdit,
	save,
	disabledReason,
	disabledSave,
	className = "",
	pencilPlacement = "beside",
	fill = false,
	initiallyEditing = false,
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
	/**
	 * Set when the draft as it stands cannot be committed — the checkmark is disabled and
	 * carries the reason as its tooltip. For a field whose value means different acts: a
	 * release date already in the past is a release-now, which the readiness notices beside
	 * it may refuse, while the same field holding a future time is only a schedule.
	 */
	disabledSave?: (draft: V) => string | undefined;
	className?: string;
	/**
	 * The stage's fill (the listened Work's aside column — see `ListenStage`): the
	 * field's root and its read row take the column's whole box, so the words the
	 * user reads and the creator edits fill the media area beside the waveform.
	 * Default is the page-row field everywhere else, sized by its content.
	 */
	fill?: boolean;
	/**
	 * Whether the pencil hangs off the read view's top-right corner rather than sitting
	 * in the field's action column — for a centered title, where the text alone is the
	 * centered thing.
	 */
	pencilPlacement?: "beside" | "corner";
	/**
	 * Open the field in its edit state on mount. For a field whose only home is a card
	 * that was opened to edit it — the media management card's Body and Details — the
	 * pencil that opened the card promised an editor, and a second pencil inside asks
	 * for the same click again.
	 */
	initiallyEditing?: boolean;
}) {
	const [mode, setMode] = useState<"read" | "edit" | "busy">(initiallyEditing ? "edit" : "read");
	const [draft, setDraft] = useState<V>(saved);
	const [error, setError] = useState<string | null>(null);
	/** The field's own root, the anchor `keepScroll` measures the page's scroller from. */
	const rootRef = useRef<HTMLDivElement | null>(null);
	/** Why the draft as it stands cannot be committed, when its own rules say so. */
	const saveRefusal = mode === "busy" ? undefined : disabledSave?.(draft);

	const commit = async () => {
		if (mode === "busy" || saveRefusal) return;
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

	const cancel = () =>
		keepScroll(rootRef.current, () => {
			setDraft(saved);
			setError(null);
			setMode("read");
		});

	const pencil = !disabledReason ? (
		<button
			type="button"
			aria-label={`Edit ${label}`}
			title={`Edit ${label}`}
			className={`${PENCIL} shrink-0 ${
				pencilPlacement === "corner" ? "absolute -top-1 right-0" : "self-start justify-self-end"
			}`}
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
			className="shrink-0 self-start justify-self-end text-xs text-base-content/40"
			title={disabledReason}
		>
			{disabledReason}
		</span>
	);

	const fieldActions =
		mode === "busy" ? (
			<span className="px-1 text-xs text-base-content/60">Saving…</span>
		) : (
			<FieldActionJoin>
				<button
					type="button"
					aria-label={`Cancel editing ${label}`}
					title="Discard"
					className="btn btn-ghost btn-sm join-item text-error hover:bg-error/10 hover:text-error"
					onClick={cancel}
				>
					<XMarkIcon className="size-4" />
				</button>
				<button
					type="button"
					aria-label={`Save ${label}`}
					title={saveRefusal ?? "Save"}
					disabled={saveRefusal !== undefined}
					className="btn btn-success btn-sm join-item"
					onClick={() => void commit()}
				>
					<CheckIcon className="size-4" />
				</button>
			</FieldActionJoin>
		);

	return (
		<div
			ref={rootRef}
			className={`group relative ${fill ? "h-full w-full" : ""} ${className}`}
			data-editing={mode === "read" ? undefined : "true"}
		>
			{mode === "read" ? (
				pencilPlacement === "corner" && !fill && !disabledReason ? (
					// The gutter on both sides is what keeps the text centered while the
					// pencil hangs in the right one; it is sized for the pencil itself (a
					// btn-xs with padding is 34px) plus a gap. Capping the box at the
					// column's width means a long title truncates instead of pushing the
					// pencil outward.
					<div className="relative mx-auto w-fit max-w-full px-10">
						<div className="min-w-0">{renderRead()}</div>
						{pencil}
					</div>
				) : (
					<div
						className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 ${
							fill ? "h-full items-stretch" : "items-start"
						}`}
					>
						<div className={`min-w-0 ${fill ? "flex min-h-0" : ""}`}>{renderRead()}</div>
						{pencil}
					</div>
				)
			) : (
				<div
					className={`grid grid-cols-[minmax(0,1fr)_auto] gap-2 ${fill ? "h-full" : "items-start"}`}
				>
					<div className={`min-w-0 space-y-2 ${fill ? "flex h-full flex-col" : ""}`}>
						{renderEdit(draft, setDraft, cancel)}
						{error && <p className="text-xs text-error">{error}</p>}
					</div>
					{fieldActions}
				</div>
			)}
		</div>
	);
}
