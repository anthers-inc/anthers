// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	BookOpenIcon,
	CommandLineIcon,
	CubeIcon,
	DocumentTextIcon,
	FilmIcon,
	MusicalNoteIcon,
	PhotoIcon,
	PuzzlePieceIcon,
	Squares2X2Icon,
	WrenchScrewdriverIcon,
} from "@heroicons/react/24/outline";

const config = {
	text: { label: "Article", Icon: DocumentTextIcon, color: "badge-info" },
	image: { label: "Image", Icon: PhotoIcon, color: "badge-accent" },
	// ⚠️ The fallback below is `config.text`, so a type missing from this map renders as
	// "Article" rather than as anything obviously wrong — an ebook labeled Article looks
	// like a copy choice, not a gap. Add the row when you add the type.
	ebook: { label: "Book", Icon: BookOpenIcon, color: "badge-accent" },
	audio: { label: "Audio", Icon: MusicalNoteIcon, color: "badge-secondary" },
	video: { label: "Video", Icon: FilmIcon, color: "badge-warning" },
	game: { label: "Game", Icon: PuzzlePieceIcon, color: "badge-primary" },
	software: { label: "Software", Icon: CommandLineIcon, color: "badge-neutral" },
	physical: { label: "Physical", Icon: CubeIcon, color: "badge-success" },
	service: { label: "Service", Icon: WrenchScrewdriverIcon, color: "badge-info" },
	// A bundled post's contentType can resolve to "mixed" — fall back sensibly.
	mixed: { label: "Mixed", Icon: Squares2X2Icon, color: "badge-ghost" },
} as const;

export default function ContentTypeBadge({ contentType }: { contentType: string }) {
	const { label, Icon, color } = config[contentType as keyof typeof config] ?? config.text;

	return (
		<span className={`badge badge-sm gap-1 ${color}`}>
			<Icon className="w-3 h-3" />
			{label}
		</span>
	);
}
