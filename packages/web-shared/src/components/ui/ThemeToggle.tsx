// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The topbar light/dark switch, shared by the consumer site and the Studio. Shows a moon
// in light mode (click → dark) and a sun in dark mode (click → light). The choice always
// persists to the device; when signed in it also saves to the account, so it follows the
// user across devices (see AuthProvider, which applies the account preference on load).

import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { useAuth } from "../../lib/auth";
import {
	applyTheme,
	persistThemeToAccount,
	storeTheme,
	type Theme,
	useTheme,
} from "../../lib/theme";

export default function ThemeToggle({ className = "" }: { className?: string }) {
	const theme = useTheme();
	const { isAuthenticated } = useAuth();

	function toggle() {
		const next: Theme = theme === "dark" ? "light" : "dark";
		applyTheme(next);
		storeTheme(next);
		if (isAuthenticated) persistThemeToAccount(next);
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
