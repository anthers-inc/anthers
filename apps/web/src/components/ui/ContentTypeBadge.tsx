// SPDX-License-Identifier: Apache-2.0

import type { WorkType } from "@anthers/shared/content";
import {
	BookOpenIcon,
	CommandLineIcon,
	CubeIcon,
	DocumentTextIcon,
	FilmIcon,
	MicrophoneIcon,
	MusicalNoteIcon,
	PhotoIcon,
	PuzzlePieceIcon,
	RectangleGroupIcon,
	Squares2X2Icon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";

const config = {
	// Writing, the Studio's word for the kind, which covers an essay, a story and a poem alike.
	text: { label: "Writing", Icon: DocumentTextIcon, color: "badge-info" },
	image: { label: "Image", Icon: PhotoIcon, color: "badge-accent" },
	// ⚠️ The fallback below is `config.text`, so a type missing from this map would render as
	// "Writing" rather than as anything obviously wrong — an ebook labeled Writing looks like a
	// copy choice, not a gap. The `satisfies` below is what makes a missing row a compile error.
	comic: { label: "Comic", Icon: RectangleGroupIcon, color: "badge-accent" },
	ebook: { label: "Book", Icon: BookOpenIcon, color: "badge-accent" },
	music: { label: "Music", Icon: MusicalNoteIcon, color: "badge-secondary" },
	audio: { label: "Audio", Icon: MicrophoneIcon, color: "badge-secondary" },
	video: { label: "Video", Icon: FilmIcon, color: "badge-warning" },
	game: { label: "Game", Icon: PuzzlePieceIcon, color: "badge-primary" },
	software: { label: "Software", Icon: CommandLineIcon, color: "badge-neutral" },
	physical: { label: "Physical", Icon: CubeIcon, color: "badge-success" },
	service: { label: "Service", Icon: WrenchScrewdriverIcon, color: "badge-info" },
	// A bundled post's contentType can resolve to "mixed" — fall back sensibly.
	mixed: { label: "Mixed", Icon: Squares2X2Icon, color: "badge-ghost" },
} as const satisfies Record<WorkType | "mixed", unknown>;

export default function ContentTypeBadge({ contentType }: { contentType: string }) {
	const { label, Icon, color } = config[contentType as keyof typeof config] ?? config.text;

	return (
		<span className={`badge badge-sm gap-1 ${color}`}>
			<Icon className="w-3 h-3" />
			{label}
		</span>
	);
}
