// SPDX-License-Identifier: Apache-2.0
/**
 * A creator's Badge — a patch in the shape and color they chose, with their art on it.
 *
 * ⭐ **Two layers, and the shape is the badge** (Parker, 2026-08-29). This is the thin
 * creator-side wrapper over `BadgeMark`, which Anthers' own Badges render through too —
 * the strongest way to keep two ladders looking like one kind of object is for them to be
 * one component. All this adds is the fallback emblem and the access-checked URL for a
 * creator's own art.
 *
 * ⚠️ **The library is `@anthers/shared/badge-art` and this component only renders it.** The
 * API validates a creator's choices against the same lists, so a shape the server would
 * refuse cannot be offered here and an id the browser cannot draw cannot be stored.
 *
 * ⚠️ **The default is drawn rather than served.** A default served as bytes would be a
 * raster of something the brand package renders as recolor-ready SVG, and it would go stale
 * the moment the palette moved. The art route 404s for a rung with no upload, and this
 * falls back — so a creator who has uploaded nothing still gets a mark that belongs beside
 * Anthers' own rather than an empty circle.
 *
 * 🚨 **The fallback for a rung with no art of its own is Anthers' OWN Badge design,
 * standing in by ladder position** (Parker, 2026-09-13) — `badge-root`, `badge-sprout`,
 * `badge-petal`, `badge-blossom`, each on its own field, wrapping `index % 4` for longer
 * ladders. It replaced `defaultBadgeEmblem`/`defaultBadgeColor` over the retired
 * mix-and-match library, which the Badge Maker took away from creators. The fallback is
 * deliberately a stopgap the Badge Maker's own encourage-line calls out.
 */

import { useState } from "react";
import { apiBaseUrl } from "../../lib/rpc";
import { BadgeMark } from "./BadgeMark";

/**
 * Anthers' own four Badge designs, as the fallback wears them — the emblem names and
 * field colors of `BADGE_ART` in `economics.tsx`, restated here so the fallback does not
 * reach across into the marketing-side component tree. A design change there is a change
 * here in the same commit; a test asserts the two agree. Plain strings — `BadgeMark`
 * resolves the emblem against `@anthers/brand` and warns rather than crashes on an
 * unknown one, and the agreement test is what actually holds this to the designs.
 */
const FALLBACK_ART: { emblem: string; color: string }[] = [
	{ emblem: "badge-root", color: "cream" },
	{ emblem: "badge-sprout", color: "meadow" },
	{ emblem: "badge-petal", color: "amber" },
	{ emblem: "badge-blossom", color: "sun" },
];

/** One ladder position's fallback design, wrapping past the four. */
export function fallbackBadgeDesign(index: number): { emblem: string; color: string } {
	const n = FALLBACK_ART.length;
	return FALLBACK_ART[((index % n) + n) % n];
}

export interface BadgeArtChoice {
	/** A shape id from the library; null draws the default. */
	artShape?: string | null;
	/** A color id from the library; null draws the default. */
	artColor?: string | null;
	/** A library emblem for the foreground; ignored when the creator uploaded art. */
	artEmblem?: string | null;
	/** Whether the creator has their own art. False draws the emblem without a request. */
	hasArt?: boolean;
}

export function CreatorBadgeMark({
	badgeId,
	index,
	label,
	art,
	dim = false,
	size = "h-12 w-12",
}: {
	badgeId: number;
	/** The rung's position on this creator's ladder, for the fallback design. */
	index: number;
	label: string;
	art: BadgeArtChoice;
	dim?: boolean;
	size?: string;
}) {
	// A row can name art that storage no longer has, and the route 404s for it. Falling
	// back on error rather than trusting the flag means a badge is never a broken image.
	const [failed, setFailed] = useState(false);
	const showUpload = Boolean(art.hasArt) && !failed;
	const fallback = fallbackBadgeDesign(index);

	return (
		<BadgeMark
			shape={art.artShape}
			color={art.artColor ?? fallback.color}
			label={label}
			emblem={art.artEmblem ?? fallback.emblem}
			// 🚨 Rooted on `apiBaseUrl()` rather than written as `/api/...`. The web app and
			// the API are not always the same origin — the Studio subdomain, the desktop
			// shell, and the e2e preview all separate them — and a root-relative src asks the
			// page's own host, gets HTML or a 404, and silently falls back to the emblem.
			// Found in the browser; nothing else could have.
			imageSrc={showUpload ? `${apiBaseUrl()}/api/subscriptions/badges/${badgeId}/art` : null}
			onImageError={() => setFailed(true)}
			clipId={`badge-mark-${badgeId}`}
			dim={dim}
			size={size}
		/>
	);
}
