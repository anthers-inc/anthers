// SPDX-License-Identifier: Apache-2.0
/**
 * The create tile that leads every content grid on a creator's own profile — the first
 * slot of the grid, the same size and shape as the tiles around it (Parker, 2026-11-06).
 * Creation lives where the creator is already looking at what they have made.
 *
 * ⭐ **The All Content tab asks which thing to make.** Its tile opens a small menu rather
 * than guessing between a post and a Work; each typed tab links straight to the New Work
 * page, and Posts links to the New Post page. The tile is the owner's alone — a visitor's
 * grid never carries it.
 */
import { Link } from "@anthers/web-shared/router";
import { studioNewPostUrl, studioNewWorkUrl } from "@anthers/web-shared/studio";
import { PlusIcon } from "@heroicons/react/24/outline";
import { useState } from "react";

/**
 * The tile's shape. `rounded-2xl` and the inset padding are the FeedTile's own, so the
 * create tile sits in a row of cards as one of them rather than as a banner beside them.
 */
const TILE_CLASS =
	"group flex h-full min-h-[248px] w-full flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-base-content/20 bg-base-200/40 p-6 text-center text-sm font-semibold transition-colors";

function TileFace({ label, active }: { label: string; active?: boolean }) {
	return (
		<>
			<span
				className={`flex size-12 items-center justify-center rounded-full text-primary transition-colors ${
					active ? "bg-primary/15" : "bg-primary/10 group-hover:bg-primary/15"
				}`}
			>
				<PlusIcon className="size-6" aria-hidden="true" />
			</span>
			<span>{label}</span>
		</>
	);
}

/** A typed create tile: one destination, named for the tab it leads. */
export function CreateTile({ href, label }: { href: string; label: string }) {
	return (
		<Link
			to={href}
			data-testid="profile-create-tile"
			className={`${TILE_CLASS} hover:border-primary/40 hover:bg-primary/5`}
		>
			<TileFace label={label} />
		</Link>
	);
}

/** The All Content tile: a small menu asking for a post or a Work. */
export function CreateMenuTile() {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative h-full">
			<button
				type="button"
				aria-expanded={open}
				aria-haspopup="menu"
				data-testid="profile-create-tile"
				onClick={() => setOpen((value) => !value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") setOpen(false);
				}}
				className={`${TILE_CLASS} ${
					open ? "border-primary/60 bg-primary/5" : "hover:border-primary/40 hover:bg-primary/5"
				}`}
			>
				<TileFace label="New Content" active={open} />
			</button>
			{open && (
				<>
					<button
						type="button"
						aria-label="Close the new content menu"
						className="fixed inset-0 z-10 cursor-default"
						onClick={() => setOpen(false)}
					/>
					<div
						role="menu"
						aria-label="New content"
						className="absolute inset-x-2 top-full z-20 mt-2 flex flex-col rounded-xl border border-base-300 bg-base-100 p-1 shadow-xl"
					>
						<Link
							role="menuitem"
							to={studioNewPostUrl()}
							className="rounded-lg px-3 py-2 text-sm hover:bg-base-200"
							onClick={() => setOpen(false)}
						>
							New Post
						</Link>
						<Link
							role="menuitem"
							to={studioNewWorkUrl()}
							className="rounded-lg px-3 py-2 text-sm hover:bg-base-200"
							onClick={() => setOpen(false)}
						>
							New Work
						</Link>
					</div>
				</>
			)}
		</div>
	);
}
