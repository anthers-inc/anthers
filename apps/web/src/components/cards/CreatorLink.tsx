// SPDX-License-Identifier: Apache-2.0

import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";

/**
 * A creator's name inside a card, linking to the creator's profile page
 * (`/@handle`) rather than to what the card represents.
 *
 * Every card this rides in keeps its whole surface open to a target of its own —
 * the work or post — by a stretched overlay link painted over the card, so a
 * plain click on the name must reach a link above that overlay. This is that
 * link: the profile anchor, raised past every overlay with `relative z-10`. A
 * modified click (middle-click, ⌘/Ctrl-click) keeps the browser's native
 * behavior and opens the profile in a new tab. When the entry carries no
 * handle — a tombstone or a creator whose row went away — the name renders as
 * the plain text it was before, still raised, so the row's baseline holds.
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
	const raised = `relative z-10${className ? ` ${className}` : ""}`;
	if (!handle) return <span className={raised}>{label}</span>;
	return (
		<Link to={profileUrl(handle)} className={raised}>
			{label}
		</Link>
	);
}
