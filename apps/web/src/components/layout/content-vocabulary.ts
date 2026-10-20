// SPDX-License-Identifier: Apache-2.0
/**
 * The shared content vocabulary the sidebar filters draw: the Work types in their
 * display order and the curated tag corpus the Tags search reads.
 *
 * These lived in `ContentFilterSections.tsx`, Browse's own sidebar machinery, until
 * Browse was removed on 2026-10-19. The vocabulary outlived the mode — every tab's
 * Type section renders it — so it moved here rather than being deleted with the
 * component that happened to host it.
 */

import {
	BookOpenIcon,
	CommandLineIcon,
	CubeIcon,
	CubeTransparentIcon,
	MicrophoneIcon,
	MusicalNoteIcon,
	PencilSquareIcon,
	PhotoIcon,
	PuzzlePieceIcon,
	RectangleGroupIcon,
	VideoCameraIcon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";

export const CONTENT_TYPES = [
	{ id: "", label: "All", icon: CubeTransparentIcon },
	{ id: "game", label: "Games", icon: PuzzlePieceIcon },
	{ id: "music", label: "Music", icon: MusicalNoteIcon },
	{ id: "audio", label: "Audio", icon: MicrophoneIcon },
	{ id: "video", label: "Video", icon: VideoCameraIcon },
	{ id: "text", label: "Writing", icon: PencilSquareIcon },
	{ id: "ebook", label: "Books", icon: BookOpenIcon },
	{ id: "comic", label: "Comics", icon: RectangleGroupIcon },
	{ id: "image", label: "Images", icon: PhotoIcon },
	{ id: "software", label: "Software", icon: CommandLineIcon },
	{ id: "physical", label: "Physical", icon: CubeIcon },
	{ id: "service", label: "Services", icon: WrenchScrewdriverIcon },
] as const;

export const TAGS_BY_TYPE: Record<string, string[]> = {
	"": [
		"indie",
		"open-source",
		"pixel-art",
		"narrative",
		"relaxing",
		"horror",
		"puzzle",
		"chiptune",
		"lo-fi",
		"podcast",
		"essay",
		"tutorial",
		"devlog",
		"creative-tools",
	],
	game: [
		"rpg",
		"platformer",
		"puzzle",
		"horror",
		"narrative",
		"roguelike",
		"farming-sim",
		"visual-novel",
		"point-and-click",
		"casual",
		"speedrun",
		"pixel-art",
		"jam-game",
		"atmospheric",
		"replayable",
		"relaxing",
		"level-editor",
		"indie",
	],
	music: [
		"chiptune",
		"lo-fi",
		"ost",
		"game-music",
		"synthwave",
		"electronic",
		"ambient",
		"soundtrack",
		"remix",
	],
	audio: ["podcast", "interviews", "audiobook", "audio-drama", "soundscape", "field-recording"],
	video: [
		"devlog",
		"behind-the-scenes",
		"game-design",
		"tutorial",
		"live-performance",
		"essay",
		"documentary",
		"review",
	],
	text: [
		"essay",
		"tutorial",
		"devlog",
		"zine",
		"illustration",
		"art",
		"sketchbook",
		"technology",
		"culture",
		"guide",
		"postmortem",
	],
};
