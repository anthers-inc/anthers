// SPDX-License-Identifier: AGPL-3.0-or-later
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
 */

import { defaultBadgeColor, defaultBadgeEmblem } from "@anthers/shared/badge-art";
import { useState } from "react";
import { apiBaseUrl } from "../../lib/rpc";
import { BadgeMark } from "./BadgeMark";

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
	gateId,
	index,
	label,
	art,
	dim = false,
	size = "h-12 w-12",
}: {
	gateId: number;
	/** The rung's position on this creator's ladder, for the default emblem. */
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

	return (
		<BadgeMark
			shape={art.artShape}
			color={art.artColor ?? defaultBadgeColor(index)}
			label={label}
			emblem={art.artEmblem ?? defaultBadgeEmblem(index)}
			// 🚨 Rooted on `apiBaseUrl()` rather than written as `/api/...`. The web app and
			// the API are not always the same origin — the Studio subdomain, the desktop
			// shell, and the e2e preview all separate them — and a root-relative src asks the
			// page's own host, gets HTML or a 404, and silently falls back to the emblem.
			// Found in the browser; nothing else could have.
			imageSrc={showUpload ? `${apiBaseUrl()}/api/subscriptions/gates/${gateId}/art` : null}
			onImageError={() => setFailed(true)}
			clipId={`badge-gate-${gateId}`}
			dim={dim}
			size={size}
		/>
	);
}
