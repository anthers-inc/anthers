// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The topbar light/dark switch. Shows a sun in dark mode (click → light) and a
// moon in light mode (click → dark); the choice persists across sessions.

import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { applyTheme, getStoredTheme, storeTheme, type Theme } from "../../lib/theme";

export default function ThemeToggle({ className = "" }: { className?: string }) {
	const [theme, setTheme] = useState<Theme>(getStoredTheme);

	function toggle() {
		const next: Theme = theme === "dark" ? "light" : "dark";
		setTheme(next);
		storeTheme(next);
		applyTheme(next);
	}

	const nextLabel = theme === "dark" ? "light" : "dark";
	return (
		<button
			type="button"
			onClick={toggle}
			aria-label={`Switch to ${nextLabel} mode`}
			title={`Switch to ${nextLabel} mode`}
			className={`btn btn-ghost btn-sm btn-circle ${className}`}
		>
			{theme === "dark" ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
		</button>
	);
}
