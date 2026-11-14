// SPDX-License-Identifier: Apache-2.0
/**
 * The **combo avatar** — two creators, one face.
 *
 * A Collab Badge and a Collab Work are one object with several owners, and the byline has
 * to say so without turning into a list. The compact mark is the overlapping pair a reader
 * already knows from a shared channel, with the full set behind a click. The modal is the
 * same `CreatorCard` the rest of the app uses to introduce a creator, so following and
 * visiting work exactly as they do everywhere else.
 *
 * ⚠️ **The button stops the click.** Every surface that carries this mark is itself a link
 * (a Badge card, a Work card), and opening the collaborators is not following that link.
 */
import { useState } from "react";
import type { BadgeOwner } from "../../lib/types";
import CollaboratorsModal from "./CollaboratorsModal";

export default function ComboAvatar({
	owners,
	size = 24,
	className = "",
}: {
	owners: BadgeOwner[];
	/** Square avatar size in pixels; the overlap and the count bubble scale with it. */
	size?: number;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	const unique = owners.filter(
		(owner, index, all) => all.findIndex((candidate) => candidate.id === owner.id) === index,
	);
	if (unique.length === 0) return null;

	const shown = unique.slice(0, 2);
	const extra = unique.length - shown.length;
	const overlap = Math.round(size * 0.34);

	return (
		<>
			<button
				type="button"
				onClick={(event) => {
					event.preventDefault();
					event.stopPropagation();
					setOpen(true);
				}}
				className={`inline-flex shrink-0 items-center align-middle ${className}`}
				aria-label={
					unique.length === 1
						? `Open ${unique[0]?.displayName || unique[0]?.handle}'s profile`
						: "See the creators who share this"
				}
			>
				{shown.map((owner, index) => {
					const name = owner.displayName || owner.handle;
					return owner.avatar ? (
						<img
							key={owner.id}
							src={owner.avatar}
							alt=""
							title={name}
							className="relative rounded-full object-cover ring-2 ring-base-100"
							style={{
								width: size,
								height: size,
								marginLeft: index === 0 ? 0 : -overlap,
								zIndex: shown.length - index,
							}}
						/>
					) : (
						<span
							key={owner.id}
							title={name}
							className="relative flex items-center justify-center rounded-full bg-base-300 font-bold text-base-content/50 ring-2 ring-base-100"
							style={{
								width: size,
								height: size,
								fontSize: Math.max(10, Math.round(size * 0.42)),
								marginLeft: index === 0 ? 0 : -overlap,
								zIndex: shown.length - index,
							}}
						>
							{name.charAt(0).toUpperCase()}
						</span>
					);
				})}
				{extra > 0 && (
					<span
						className="relative flex items-center justify-center rounded-full bg-base-300 font-bold text-base-content/60 ring-2 ring-base-100"
						style={{
							width: size,
							height: size,
							fontSize: Math.max(9, Math.round(size * 0.36)),
							marginLeft: -overlap,
							zIndex: 0,
						}}
					>
						+{extra}
					</span>
				)}
			</button>
			<CollaboratorsModal owners={unique} open={open} onClose={() => setOpen(false)} />
		</>
	);
}
