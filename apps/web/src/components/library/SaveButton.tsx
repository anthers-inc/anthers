// SPDX-License-Identifier: Apache-2.0
/**
 * **Save** — the one verb for putting something in your Library.
 *
 * ⭐ **One keep action, for everything** (Parker, 2026-10-11): a Work, a Project and now a
 * post are all **saved**, and a creator is **followed**. "Bookmarked" retired as a second
 * verb and a second store — a post kept on its own list while Works and albums sat in the
 * Library made both feel like half a feature.
 *
 * 🚨 **Saving is not buying and not unlocking.** This appears on gated Works too, where it
 * means "keep this" and grants nothing — the Library shows it locked with the route to
 * unlock. The label must never drift toward ownership language ("Get", "Add to collection",
 * "Own it"), because a free save and a purchase would then be indistinguishable at the one
 * moment the difference costs money.
 */

import { useAuth } from "@anthers/web-shared/auth";
import { BookmarkIcon as BookmarkOutline } from "@heroicons/react/24/outline";
import { BookmarkIcon as BookmarkSolid } from "@heroicons/react/24/solid";
import { useState } from "react";
import {
	removeItem,
	savePost,
	saveProject,
	saveWork,
	setHidden,
	useLibrary,
} from "../../lib/library";

export default function SaveButton({
	workId,
	projectId,
	postId,
	size = "sm",
	className = "",
}: {
	workId?: number;
	projectId?: number;
	postId?: number;
	size?: "xs" | "sm";
	className?: string;
}) {
	const { isAuthenticated } = useAuth();
	const library = useLibrary();
	const [busy, setBusy] = useState(false);
	/** Set when the server refuses removal because it was purchased. */
	const [purchased, setPurchased] = useState(false);

	// Signed out there is no Library to put anything in, and a control that prompts a
	// sign-in from every card is noise. The Library is reachable from the nav.
	if (!isAuthenticated) return null;

	const itemId =
		workId != null
			? library.works.get(workId)
			: projectId != null
				? library.projects.get(projectId)
				: postId != null
					? library.posts.get(postId)
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
			} else if (postId != null) {
				await savePost(postId);
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
