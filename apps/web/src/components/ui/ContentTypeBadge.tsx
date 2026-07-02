// SPDX-License-Identifier: AGPL-3.0-or-later
import { DocumentTextIcon, FilmIcon, MusicalNoteIcon } from "@heroicons/react/24/outline";

const config = {
	text: { label: "Article", Icon: DocumentTextIcon, color: "badge-info" },
	video: { label: "Video", Icon: FilmIcon, color: "badge-warning" },
	audio: { label: "Audio", Icon: MusicalNoteIcon, color: "badge-secondary" },
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
