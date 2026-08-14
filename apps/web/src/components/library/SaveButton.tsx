// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * **Save** — the one verb for putting a Work or a Project in your Library.
 *
 * One verb per object, settled 2026-08-13: a Work or a Project is **saved**, a creator is
 * **followed**, a post is **bookmarked**. Two controls on one object that sound like the
 * same thing is what made Bookmarks and the Library each feel like half a feature.
 *
 * 🚨 **Saving is not buying and not unlocking.** This appears on gated Works too, where it
 * means "keep this" and grants nothing — the shelf shows it locked with the route to
 * unlock. The label must never drift toward ownership language ("Get", "Add to collection",
 * "Own it"), because a free save and a purchase would then be indistinguishable at the one
 * moment the difference costs money.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { BookmarkIcon as BookmarkOutline } from "@heroicons/react/24/outline";
import { BookmarkIcon as BookmarkSolid } from "@heroicons/react/24/solid";
import { useState } from "react";
import { removeItem, saveProject, saveWork, setHidden, useShelf } from "../../lib/library";

export default function SaveButton({
	workId,
	projectId,
	size = "sm",
	className = "",
}: {
	workId?: number;
	projectId?: number;
	size?: "xs" | "sm";
	className?: string;
}) {
	const { isAuthenticated } = useAuth();
	const shelf = useShelf();
	const [busy, setBusy] = useState(false);
	/** Set when the server refuses removal because it was purchased. */
	const [purchased, setPurchased] = useState(false);

	// Signed out there is no shelf to put anything on, and a control that prompts a
	// sign-in from every card is noise. The Library is reachable from the nav.
	if (!isAuthenticated) return null;

	const itemId =
		workId != null
			? shelf.works.get(workId)
			: projectId != null
				? shelf.projects.get(projectId)
				: undefined;
	const saved = itemId != null;

	const toggle = async () => {
		setBusy(true);
		setPurchased(false);
		try {
			if (saved) {
				const result = await removeItem(itemId);
				// A purchase cannot be un-saved. Offer the thing that *is* allowed rather
				// than failing silently: hide it, which is reversible from the Library.
				if (result === "purchased") {
					setPurchased(true);
					await setHidden(itemId, true);
				}
			} else if (workId != null) {
				await saveWork(workId);
			} else if (projectId != null) {
				await saveProject(projectId);
			}
		} finally {
			setBusy(false);
		}
	};

	return (
		<span className="inline-flex items-center gap-2">
			<button
				type="button"
				onClick={toggle}
				disabled={busy}
				aria-pressed={saved}
				title={saved ? "Remove from your Library" : "Save to your Library"}
				className={`btn btn-${size} ${saved ? "btn-primary" : "btn-outline"} gap-1.5 ${className}`}
			>
				{saved ? <BookmarkSolid className="size-4" /> : <BookmarkOutline className="size-4" />}
				{saved ? "Saved" : "Save"}
			</button>
			{/* Only ever appears on the path where removal was refused, and says what
			    happened instead of leaving the button looking broken. */}
			{purchased && (
				<span className="text-xs text-base-content/60">
					You bought this — hidden in your Library instead.
				</span>
			)}
		</span>
	);
}
