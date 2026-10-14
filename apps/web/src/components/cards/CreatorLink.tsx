// SPDX-License-Identifier: Apache-2.0

import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";

/**
 * A creator's name inside a card, linking to the creator's profile page
 * (`/@handle`) rather than to what the card represents.
 *
 * Every card this rides in is a single whole-card `<Link>` to its work or post,
 * so this link nests inside it and stops the click from bubbling: a plain click
 * on the name navigates to the profile and the card's own link does nothing;
 * a modified click (middle-click, ⌘/Ctrl-click) keeps its native browser
 * behavior and opens the profile in a new tab. Keyboard focus reaches it like
 * any other link. When the entry carries no handle — a tombstone or a creator
 * whose row went away — the name renders as the plain text it was before.
 */
export default function CreatorLink({
	handle,
	name,
	className,
}: {
	handle: string | null | undefined;
	name: string;
	/** The classes the card's plain name span carried; styling stays put. */
	className?: string;
}) {
	const label = name || handle || "?";
	if (!handle) return <span className={className}>{label}</span>;
	return (
		<Link
			to={profileUrl(handle)}
			className={className}
			// The card is its own Link; without this the click bubbles into the card's
			// navigation and both targets race. The router's transition wrapper already
			// bails a bubbled click on `defaultPrevented`, so the profile wins either
			// way — the stop makes that invariant a stated one rather than a remote one.
			onClick={(e) => e.stopPropagation()}
		>
			{label}
		</Link>
	);
}
