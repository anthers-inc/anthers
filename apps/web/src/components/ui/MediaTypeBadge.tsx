// SPDX-License-Identifier: AGPL-3.0-or-later
const MEDIA_TYPE_STYLES: Record<string, string> = {
	game: "badge-secondary",
	video: "badge-error",
	audio: "badge-success",
	text: "badge-info",
};

const MEDIA_TYPE_LABELS: Record<string, string> = {
	game: "Game",
	video: "Video",
	audio: "Audio",
	text: "Text",
};

export default function MediaTypeBadge({ type }: { type: string }) {
	return (
		<span className={`badge badge-sm ${MEDIA_TYPE_STYLES[type] ?? "badge-neutral"}`}>
			{MEDIA_TYPE_LABELS[type] ?? type}
		</span>
	);
}
