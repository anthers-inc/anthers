// SPDX-License-Identifier: Apache-2.0
/**
 * The creator's **editing primitives** — the one set of parts that put a pencil beside
 * what a user reads, and the banner that says the page is being edited.
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

import { usePayoutsReady } from "@anthers/web-shared/payouts";
import { Link, useNavigate } from "@anthers/web-shared/router";
import { studioUrl } from "@anthers/web-shared/studio";
import { CheckIcon, EyeIcon, PencilSquareIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useRef, useState } from "react";
import { keepScroll } from "./scrollKeeper";

const PENCIL =
	"btn btn-ghost btn-xs text-base-content/40 hover:text-base-content/80 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100";

/**
 * One editable field: what a user reads, with a pencil that opens it, an X that cancels
 * and a checkmark that saves the field alone.
 *
 * The field is generic over its value; the call site narrows the draft to its own shape
 * when it passes `renderEdit` and `save` — the primitive only owns the opening, the
 * closing and the waiting.
 */
export function InlineField<V>({
	label,
	saved,
	renderRead,
	renderEdit,
	save,
	disabledReason,
	className = "",
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
		<div ref={rootRef} className={`group relative ${className}`}>
			{mode === "read" ? (
				<>
					{renderRead()}
					{!disabledReason ? (
						<button
							type="button"
							aria-label={`Edit ${label}`}
							title={`Edit ${label}`}
							className={mode === "read" ? `${PENCIL} absolute -top-1 right-0` : PENCIL}
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
						<span className="text-xs text-base-content/40" title={disabledReason}>
							{disabledReason}
						</span>
					)}
				</>
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

/**
 * The banner a creator's own Work page wears while they can edit it — the explicit mode
 * marker the move onto the Work's page was made conditional on: a creator never wonders
 * which mode they are in. It carries the way back to the Studio's Works list and the way
 * into a user's preview, and says in one line what the page is.
 */
export function EditingBanner({ title }: { title: string | null }) {
	const payouts = usePayoutsReady();
	const navigate = useNavigate();
	return (
		// `status`, not `alert`: a persistent mode indicator rather than an interruption.
		<aside role="status" className="rounded-box border border-warning/40 bg-warning/10 px-4 py-2.5">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
				<span className="text-sm font-semibold">
					Editing your Work — <span className="font-normal">{title ?? "this Work"}</span>
				</span>
				<span className="text-xs text-base-content/60">
					Everything you see is what a user sees; the pencil opens the change.
				</span>
				<div className="ml-auto flex items-center gap-2">
					<button
						type="button"
						className="btn btn-outline btn-xs gap-1.5"
						onClick={() => {
							const p = new URLSearchParams(window.location.search);
							p.set("previewAs", "out");
							navigate(`${window.location.pathname}?${p.toString()}`, { replace: true });
						}}
					>
						<EyeIcon className="size-3.5" />
						Preview as a user
					</button>
					<Link to={studioUrl("/works")} className="btn btn-ghost btn-xs">
						Studio Works
					</Link>
				</div>
			</div>
			{payouts === false && (
				<p className="mt-1 text-xs text-base-content/60">
					Payout setup is pending — releasing waits on it, in Details.
				</p>
			)}
		</aside>
	);
}
