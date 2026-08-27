// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared presentation helpers for creator-owned library content items: the type
 * catalog, per-type icons/labels, the derived processing-state badge, and the card
 * preview URL. Used by the Catalog page, the Work editor, and the
 * post authoring content picker.
 */

import { contentNoteLabel } from "@anthers/shared/content-rating";
import {
	CommandLineIcon,
	CubeIcon,
	FilmIcon,
	MusicalNoteIcon,
	PhotoIcon,
	PuzzlePieceIcon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";
import type { ComponentType } from "react";
import type { UploadableWorkType, Work } from "../../lib/types";
import { type AccessState, accessState } from "./work-state";

export { type AccessState, accessState } from "./work-state";

/** The uploadable/processable library content types (text stays post-native). */
export const LIBRARY_TYPE_OPTIONS: { value: UploadableWorkType; label: string }[] = [
	{ value: "video", label: "Video" },
	{ value: "audio", label: "Audio" },
	{ value: "image", label: "Image" },
	{ value: "game", label: "Game" },
	{ value: "software", label: "Software" },
	{ value: "physical", label: "Physical" },
	{ value: "service", label: "Service" },
];

const TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
	video: FilmIcon,
	audio: MusicalNoteIcon,
	image: PhotoIcon,
	game: PuzzlePieceIcon,
	software: CommandLineIcon,
	physical: CubeIcon,
	service: WrenchScrewdriverIcon,
};

/** Human label for a content type (falls back to the raw value capitalized). */
export function typeLabel(type: string): string {
	return LIBRARY_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
}

/** The heroicon for a content type (defaults to the image icon). */
export function TypeIcon({ type, className }: { type: string; className?: string }) {
	const Icon = TYPE_ICONS[type] ?? PhotoIcon;
	return <Icon className={className} />;
}

/** Whether the type is downloadable-build capable (games/software carry build assets). */
export function isBuildType(type: string): boolean {
	return type === "game" || type === "software";
}

/**
 * Processing lifecycle of an item, derived (no new schema) from its latest transcode.
 * `none` = nothing to process (or not yet queued); `processing` = pending/processing;
 * `ready` = completed; `failed` = failed.
 */
export type ProcessingState = "none" | "processing" | "ready" | "failed";

export function processingState(item: Work): ProcessingState {
	const status = item.transcoding?.status;
	if (!status) return "none";
	if (status === "failed") return "failed";
	if (status === "completed") return "ready";
	return "processing"; // pending | processing
}

/** Small state badge for a library item (null when there is nothing to show). */
export function ProcessingBadge({ item }: { item: Work }) {
	switch (processingState(item)) {
		case "processing":
			return <span className="badge badge-warning badge-sm gap-1">Processing…</span>;
		case "ready":
			return <span className="badge badge-success badge-sm">Ready</span>;
		case "failed":
			return <span className="badge badge-error badge-sm">Failed</span>;
		default:
			return null;
	}
}

const ACCESS_BADGES: Record<AccessState, { label: string; className: string; title: string }> = {
	private: {
		label: "Private",
		className: "badge-neutral",
		title: "Only you can see this. Release it to put it in your public Catalog.",
	},
	locked: {
		label: "Nobody can open",
		className: "badge-error",
		title: "Released, but no access row allows anyone in. Set access on this Work.",
	},
	"public-access": {
		label: "Public Access",
		className: "badge-success",
		title: "Free to everyone, nothing to clear. Earns from the Time Pool.",
	},
	free: {
		label: "Free download",
		className: "badge-success badge-outline",
		title: "Free to everyone, but it doesn't stream — so it isn't Public Access.",
	},
	sale: { label: "For sale", className: "badge-info", title: "Anyone can buy this." },
	gated: {
		label: "Badge gated",
		className: "badge-info badge-outline",
		title: "Reachable by people supporting you at one of your Badge levels.",
	},
};

/** The Work's release + access state, as one badge. */
export function AccessBadge({ item }: { item: Work }) {
	const badge = ACCESS_BADGES[accessState(item)];
	return (
		<span className={`badge badge-sm ${badge.className}`} title={badge.title}>
			{badge.label}
		</span>
	);
}

/**
 * The Work's content rating, as one badge, with its content notes in the tooltip.
 *
 * ⭐ **`general` renders nothing, deliberately.** Almost everything on Anthers is General,
 * so a badge on all of it would say nothing and would make Mature read as a mark against a
 * work rather than as information about it. What earns a badge is the answer that changes
 * what a reader is walking into, plus the *absence* of an answer — which a creator has to
 * see, because it is what is holding their release.
 */
export function MaturityBadge({ work }: { work: Work }) {
	const notes = (work.maturityNotes ?? []).map(contentNoteLabel);
	if (!work.maturity || work.maturity === "general") return null;
	if (work.maturity === "unrated") {
		return (
			<span
				className="badge badge-sm badge-warning badge-outline"
				title="Nobody has rated this yet"
			>
				Unrated
			</span>
		);
	}
	return (
		<span
			className="badge badge-sm badge-warning"
			title={notes.length > 0 ? notes.join(" · ") : "Made for adults"}
		>
			Mature
		</span>
	);
}

/** A small type badge. */
export function TypeBadge({ type }: { type: string }) {
	return (
		<span className="badge badge-outline badge-sm gap-1">
			<TypeIcon type={type} className="w-3 h-3" />
			{typeLabel(type)}
		</span>
	);
}

/**
 * The best still image for a card: an explicit thumbnail, else (for images) the image
 * itself. Videos without a poster and audio/game/etc. fall back to the type icon.
 */
export function itemPreviewUrl(item: Work): string | null {
	if (item.thumbnail) return item.thumbnail;
	if (item.type === "image" && item.sourceKey) return item.sourceKey;
	return null;
}
