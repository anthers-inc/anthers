// SPDX-License-Identifier: AGPL-3.0-or-later
//
// /for-users-lab — design test bed. Six botanical redesigns of the For Users
// page, flipped by the tab bar at the top; each ships a light + dark palette,
// toggled by the control in the corner. Bare full-page canvas (no marketing
// chrome) so each variant fully owns its look. Delete `pages/lab/` + the route
// to remove.

import { MoonIcon, SunIcon } from "@heroicons/react/24/solid";
import { useState } from "react";
import type { Mode } from "./kit";
import Canopy from "./variants/Canopy";
import Herbarium from "./variants/Herbarium";
import Meadow from "./variants/Meadow";
import SeedPacket from "./variants/SeedPacket";
import Terrarium from "./variants/Terrarium";
import Wildflower from "./variants/Wildflower";

type Variant = {
	id: string;
	label: string;
	blurb: string;
	Component: (props: { mode: Mode }) => React.ReactNode;
};

const VARIANTS: Variant[] = [
	{
		id: "meadow",
		label: "Meadow",
		blurb: "Airy editorial · forest green + soft yellow",
		Component: Meadow,
	},
	{
		id: "canopy",
		label: "Canopy",
		blurb: "Refined modern plant-shop · sage + terracotta + amber",
		Component: Canopy,
	},
	{
		id: "terrarium",
		label: "Terrarium",
		blurb: "Misty frosted glass · mint + moss (dark-mode showcase)",
		Component: Terrarium,
	},
	{
		id: "wildflower",
		label: "Wildflower",
		blurb: "Vivid meadow · poppy + cornflower + buttercup on green",
		Component: Wildflower,
	},
	{
		id: "herbarium",
		label: "Herbarium",
		blurb: "Curveball · pressed-specimen field guide",
		Component: Herbarium,
	},
	{
		id: "seedpacket",
		label: "Seed Packet",
		blurb: "Curveball · cheerful seed catalog",
		Component: SeedPacket,
	},
];

/** Initial variant/mode come from the URL (?v=…&mode=…) so the lab is deep-linkable. */
function initialState(): { id: string; mode: Mode } {
	if (typeof window === "undefined") return { id: VARIANTS[0].id, mode: "dark" };
	const p = new URLSearchParams(window.location.search);
	const v = p.get("v");
	const id = v && VARIANTS.some((x) => x.id === v) ? v : VARIANTS[0].id;
	return { id, mode: p.get("mode") === "light" ? "light" : "dark" };
}

export default function ForUsersLabPage() {
	const [start] = useState(initialState);
	const [activeId, setActiveId] = useState(start.id);
	const [mode, setMode] = useState<Mode>(start.mode);
	const active = VARIANTS.find((v) => v.id === activeId) ?? VARIANTS[0];
	const Active = active.Component;

	// Keep the URL in sync so any state is shareable/refresh-safe.
	function sync(id: string, m: Mode) {
		if (typeof window === "undefined") return;
		const p = new URLSearchParams(window.location.search);
		p.set("v", id);
		p.set("mode", m);
		window.history.replaceState(null, "", `?${p.toString()}`);
	}
	function pickVariant(id: string) {
		setActiveId(id);
		sync(id, mode);
	}
	function pickMode(m: Mode) {
		setMode(m);
		sync(activeId, m);
	}

	return (
		<div className="min-h-screen bg-zinc-950">
			{/* Lab chrome — palette-neutral, sits above every variant */}
			<div className="sticky top-0 z-50 border-b border-zinc-700/60 bg-zinc-900/85 backdrop-blur-md">
				<div className="mx-auto flex max-w-7xl items-center gap-3 px-3 py-2">
					<span className="hidden shrink-0 pl-1 pr-2 text-xs font-semibold uppercase tracking-widest text-zinc-500 sm:block">
						For Users · Lab
					</span>
					<div className="flex flex-1 gap-1 overflow-x-auto">
						{VARIANTS.map((v) => (
							<button
								key={v.id}
								type="button"
								onClick={() => pickVariant(v.id)}
								className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors ${
									v.id === activeId
										? "bg-zinc-100 text-zinc-900"
										: "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
								}`}
							>
								{v.label}
							</button>
						))}
					</div>
					<div className="flex shrink-0 items-center rounded-full bg-zinc-800 p-0.5">
						<button
							type="button"
							onClick={() => pickMode("light")}
							aria-label="Light mode"
							className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
								mode === "light"
									? "bg-amber-200 text-zinc-900"
									: "text-zinc-400 hover:text-zinc-100"
							}`}
						>
							<SunIcon className="h-4 w-4" />
							<span className="hidden sm:inline">Light</span>
						</button>
						<button
							type="button"
							onClick={() => pickMode("dark")}
							aria-label="Dark mode"
							className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
								mode === "dark" ? "bg-zinc-100 text-zinc-900" : "text-zinc-400 hover:text-zinc-100"
							}`}
						>
							<MoonIcon className="h-4 w-4" />
							<span className="hidden sm:inline">Dark</span>
						</button>
					</div>
				</div>
				<div className="mx-auto max-w-7xl px-4 pb-1.5 text-[11px] text-zinc-500">
					<span className="font-medium text-zinc-300">{active.label}</span> — {active.blurb}
				</div>
			</div>

			{/* The variant renders on its own scoped palette */}
			<Active mode={mode} />
		</div>
	);
}
