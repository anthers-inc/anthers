// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Shared presentation helpers for creator-owned library content items: the type
 * catalog, per-type icons/labels, the derived processing-state badge, and the card
 * preview URL. Used by the Content Library page, the content-item editor, and the
 * post authoring content picker.
 */
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
import type { ContentItem, LibraryContentType } from "../../lib/types";

/** The uploadable/processable library content types (text stays post-native). */
export const LIBRARY_TYPE_OPTIONS: { value: LibraryContentType; label: string }[] = [
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

export function processingState(item: ContentItem): ProcessingState {
	const status = item.transcoding?.status;
	if (!status) return "none";
	if (status === "failed") return "failed";
	if (status === "completed") return "ready";
	return "processing"; // pending | processing
}

/** Small state badge for a library item (null when there is nothing to show). */
export function ProcessingBadge({ item }: { item: ContentItem }) {
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
export function itemPreviewUrl(item: ContentItem): string | null {
	if (item.thumbnail) return item.thumbnail;
	if (item.type === "image" && item.sourceKey) return item.sourceKey;
	return null;
}
