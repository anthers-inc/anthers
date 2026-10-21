// SPDX-License-Identifier: Apache-2.0
/**
 * The Music Player's **include spoken word** dial — a control ON the lens, rendered
 * beneath its sidebar row only while that row is selected (the shared section's `extras`
 * slot). It belongs to the lens rather than to a page, which is why it lives here: the
 * Library and the Network both carry the row, and both owe it the same control in the
 * same place.
 *
 * Flipping it is a view change: the dial re-scopes what the lens draws on and never moves
 * anything in or out of a shelf or a feed.
 */
export default function MusicDial({
	includeSpoken,
	onIncludeSpoken,
}: {
	includeSpoken: boolean;
	onIncludeSpoken: (on: boolean) => void;
}) {
	return (
		<label className="mt-1 ml-6 flex w-fit cursor-pointer items-center gap-2 text-xs">
			<input
				type="checkbox"
				className="toggle toggle-sm"
				checked={includeSpoken}
				onChange={(e) => onIncludeSpoken(e.target.checked)}
			/>
			Include spoken word
		</label>
	);
}
