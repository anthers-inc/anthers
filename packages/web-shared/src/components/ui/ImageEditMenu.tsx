// SPDX-License-Identifier: Apache-2.0
/**
 * The one edit control a display image has: a menu offering a new upload and a reposition of
 * the image already stored.
 *
 * ⭐ **Reposition is disabled, not hidden, while no image exists.** A creator should see that
 * framing is a thing they will be able to do once there is something to frame; an option that
 * silently appears later is a menu that behaves differently for no visible reason.
 *
 * 🚨 **The menu is portalled to the body as a manual popover, not left in the trigger's
 * stacking context.** The creator profile's root is `relative z-30` — it lifts the page over
 * the logged-out shell's decorative layer — and the signed-in shell's sidebar sits at `z-40`,
 * so a `z-50` dropdown inside that page can never paint in front of the sidebar. A portal with
 * fixed coordinates escapes the context; the popover is what keeps it above a modal dialog's
 * top layer, the same rule `InfoTip`'s `unclipped` mode follows.
 *
 * Its disabled item carries the reason in `title` rather than the words beside it.
 */

import { PencilSquareIcon } from "@heroicons/react/24/outline";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** `w-48` below, kept in sync for the right-edge clamp. */
const MENU_WIDTH = 192;
/** Enough for three menu rows plus padding; the flip only needs to be roughly right. */
const MENU_HEIGHT = 132;
const VIEWPORT_EDGE = 8;

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
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number; above: boolean } | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLUListElement>(null);
	const menuId = useId();

	const toggle = () => {
		if (open) {
			setOpen(false);
			return;
		}
		const trigger = triggerRef.current;
		if (!trigger) return;
		const r = trigger.getBoundingClientRect();
		// A trigger in the window's lower half opens upward, so the menu stays on screen.
		const above = r.bottom + MENU_HEIGHT > window.innerHeight - VIEWPORT_EDGE;
		setPos({
			top: above ? r.top - 4 : r.bottom + 4,
			left: Math.max(
				VIEWPORT_EDGE,
				Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - VIEWPORT_EDGE),
			),
			above,
		});
		setOpen(true);
	};

	const pick = (action: () => void) => {
		setOpen(false);
		action();
	};

	useEffect(() => {
		const menu = menuRef.current;
		if (!open || !menu) return;
		// The manual popover joins the top layer a modal dialog already occupies. A browser
		// without the popover API still gets the portal's fixed positioning.
		try {
			menu.showPopover();
		} catch {
			/* Already closed, or the API is absent. */
		}
		menu.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();

		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (menu.contains(target) || triggerRef.current?.contains(target)) return;
			setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			setOpen(false);
			triggerRef.current?.focus();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
			try {
				menu.hidePopover();
			} catch {
				/* Unmounted or already hidden. */
			}
		};
	}, [open]);

	const menu = (
		<ul
			ref={menuRef}
			id={menuId}
			data-testid="image-edit-menu"
			popover="manual"
			className="menu menu-sm z-50 w-48 rounded-box border border-base-content/10 bg-base-200 p-2 shadow"
			style={{
				position: "fixed",
				margin: 0,
				top: pos?.top,
				left: pos?.left,
				right: "auto",
				bottom: "auto",
				transform: pos?.above ? "translateY(-100%)" : undefined,
			}}
		>
			<li>
				<button type="button" onClick={() => pick(onUpload)}>
					Upload New Image
				</button>
			</li>
			<li>
				<button
					type="button"
					disabled={!hasImage || busy}
					title={hasImage ? repositionDisabledReason : "Upload an image first."}
					onClick={() => pick(onReposition)}
				>
					Reposition Image
				</button>
			</li>
			{extra && (
				<li>
					<button type="button" disabled={busy} onClick={() => pick(extra.onSelect)}>
						{extra.label}
					</button>
				</li>
			)}
		</ul>
	);

	return (
		<div className={`dropdown dropdown-end ${rootClassName}`}>
			<button
				ref={triggerRef}
				type="button"
				disabled={busy}
				aria-label={triggerLabel ? undefined : `Edit ${label}`}
				aria-haspopup="true"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				title={triggerLabel ? undefined : `Edit ${label}`}
				className={`${buttonClassName} ${busy ? "btn-disabled" : ""}`}
				onClick={toggle}
			>
				<PencilSquareIcon className={triggerLabel ? "h-4 w-4" : "h-3.5 w-3.5"} />
				{triggerLabel}
				{!triggerLabel && <span className="sr-only">Edit {label}</span>}
			</button>
			{open && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
		</div>
	);
}
