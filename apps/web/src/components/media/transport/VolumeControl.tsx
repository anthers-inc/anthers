// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Mute toggle plus level, reading the app-wide volume from `./volume`.
 *
 * The slider collapses to nothing until the control is hovered or focused on the
 * `collapsible` layout, which is what keeps a video's control bar from being mostly
 * volume on a phone. It is never *removed* — a keyboard user tabbing through still
 * reaches it, because a control that only exists under a pointer is not a control.
 */
import { SpeakerWaveIcon, SpeakerXMarkIcon } from "@heroicons/react/24/solid";
import TransportButton from "./TransportButton";
import { useVolume } from "./volume";

export default function VolumeControl({
	collapsible = false,
	size = "sm",
}: {
	collapsible?: boolean;
	size?: "xs" | "sm";
}) {
	const { volume, setLevel, toggleMuted } = useVolume();
	const silent = volume.muted || volume.level === 0;

	return (
		<div className="group/vol flex shrink-0 items-center gap-1">
			<TransportButton
				label={silent ? "Unmute" : "Mute"}
				icon={silent ? SpeakerXMarkIcon : SpeakerWaveIcon}
				onClick={toggleMuted}
				size={size}
			/>
			<input
				type="range"
				min={0}
				max={1}
				step={0.01}
				value={silent ? 0 : volume.level}
				onChange={(e) => setLevel(Number(e.target.value))}
				aria-label="Volume"
				className={`range range-xs ${
					collapsible
						? // `group-focus-within` as well as `group-hover`, and it is not decoration:
							// without it a keyboard user tabs to a zero-width control and cannot see
							// what they are changing. A touch device has no hover at all, which is
							// why the caller hides this below `sm` and leaves the mute button —
							// phone volume is an OS control there anyway.
							"w-0 opacity-0 transition-[width,opacity] duration-200 group-hover/vol:w-20 group-hover/vol:opacity-100 group-focus-within/vol:w-20 group-focus-within/vol:opacity-100"
						: "w-20"
				}`}
			/>
		</div>
	);
}
