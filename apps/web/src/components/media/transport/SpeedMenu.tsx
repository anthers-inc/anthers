// SPDX-License-Identifier: Apache-2.0
/**
 * One playback-speed menu, shared by the spoken player and the persistent bar.
 *
 * ⚠️ **A plain positioned panel, not a daisyUI dropdown** — the same decision the video
 * controls made: the popover API's anchor positioning is not yet everywhere, and a menu
 * that must work over any stacking context cannot lean on it. See `VideoControls.tsx`'s
 * file comment for the full reasoning.
 */
import { Cog6ToothIcon } from "@heroicons/react/24/solid";
import { useEffect, useRef, useState } from "react";
import { SPOKEN_RATES } from "../../../lib/spoken-rate";
import TransportButton from "./TransportButton";

export default function SpeedMenu({
	rate,
	onRate,
	size = "sm",
}: {
	rate: number;
	onRate: (rate: number) => void;
	size?: "xs" | "sm";
}) {
	const [open, setOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);

	// Close on an outside click. Bound only while open, so the page carries no listener
	// for a menu nobody has opened.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: PointerEvent) => {
			if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onDown);
		return () => document.removeEventListener("pointerdown", onDown);
	}, [open]);

	return (
		<div className="relative" ref={menuRef} data-testid="speed-menu">
			<TransportButton
				label={`Playback speed: ${rate}×`}
				icon={Cog6ToothIcon}
				onClick={() => setOpen((v) => !v)}
				active={open}
				size={size}
				badge={<span className="badge badge-ghost badge-xs">{rate}×</span>}
			/>
			{open && (
				<div className="absolute bottom-full right-0 z-10 mb-2 w-40 rounded-box bg-base-100 p-2 text-base-content shadow-xl">
					<p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
						Speed
					</p>
					<ul className="menu menu-sm w-full">
						{SPOKEN_RATES.map((r) => (
							<li key={r}>
								<button
									type="button"
									className={r === rate ? "menu-active" : ""}
									onClick={() => onRate(r)}
								>
									{r === 1 ? "Normal" : `${r}×`}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
