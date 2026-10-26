// SPDX-License-Identifier: Apache-2.0
/**
 * The one edit control a display image has: a menu offering a new upload and a reposition of
 * the image already stored.
 *
 * ⭐ **Reposition is disabled, not hidden, while no image exists.** A creator should see that
 * framing is a thing they will be able to do once there is something to frame; an option that
 * silently appears later is a menu that behaves differently for no visible reason.
 *
 * The dropdown is the CSS-only focus pattern the theme picker and the account menu use — the
 * same shape, so it closes on a pick and on an outside click without its own listener. Its
 * disabled item carries the reason in `title` rather than the words beside it.
 */

import { PencilSquareIcon } from "@heroicons/react/24/outline";

export default function ImageEditMenu({
	label,
	triggerLabel,
	hasImage,
	busy = false,
	buttonClassName = "btn btn-outline btn-sm gap-1.5",
	rootClassName = "",
	onUpload,
	onReposition,
	extra,
	repositionDisabledReason,
}: {
	/** What is being edited, for the trigger's accessible name — "thumbnail", "banner", "avatar". */
	label: string;
	/** Visible text on the trigger, when the surface has room for it. Omit for an icon button. */
	triggerLabel?: string;
	hasImage: boolean;
	busy?: boolean;
	buttonClassName?: string;
	/** Positioning for the menu's root, for a trigger pinned over an image. */
	rootClassName?: string;
	onUpload: () => void;
	onReposition: () => void;
	/** A surface's third act, e.g. a Work thumbnail's frame picker or a Project's thumbnail Work. */
	extra?: { label: string; onSelect: () => void };
	/** Why Reposition is unavailable when an image exists but is not this surface's own. */
	repositionDisabledReason?: string;
}) {
	const close = (event: { currentTarget: HTMLButtonElement }) => event.currentTarget.blur();
	return (
		<div className={`dropdown dropdown-end ${rootClassName}`}>
			<button
				type="button"
				tabIndex={0}
				disabled={busy}
				aria-label={triggerLabel ? undefined : `Edit ${label}`}
				title={triggerLabel ? undefined : `Edit ${label}`}
				className={`${buttonClassName} ${busy ? "btn-disabled" : ""}`}
			>
				<PencilSquareIcon className={triggerLabel ? "h-4 w-4" : "h-3.5 w-3.5"} />
				{triggerLabel}
				{!triggerLabel && <span className="sr-only">Edit {label}</span>}
			</button>
			<ul className="menu menu-sm dropdown-content z-50 mt-1 w-48 rounded-box border border-base-content/10 bg-base-200 p-2 shadow">
				<li>
					<button
						type="button"
						onClick={(event) => {
							close(event);
							onUpload();
						}}
					>
						Upload New Image
					</button>
				</li>
				<li>
					<button
						type="button"
						disabled={!hasImage || busy}
						title={hasImage ? repositionDisabledReason : "Upload an image first."}
						onClick={(event) => {
							close(event);
							onReposition();
						}}
					>
						Reposition Image
					</button>
				</li>
				{extra && (
					<li>
						<button
							type="button"
							disabled={busy}
							onClick={(event) => {
								close(event);
								extra.onSelect();
							}}
						>
							{extra.label}
						</button>
					</li>
				)}
			</ul>
		</div>
	);
}
