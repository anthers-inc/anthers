// SPDX-License-Identifier: Apache-2.0
//
// The topbar theme picker, shared by the consumer site and the Studio. A dropdown
// select listing the available themes from lib/theme's THEMES, grouped into Light
// and Dark by <optgroup>s, which a native select renders as headings over its
// options. Picking keeps the contract the toggle it replaced had: the choice
// applies immediately and persists always to the device, and when signed in
// additionally to the account, so it follows the user across devices (see
// AuthProvider, which applies the account preference on load). The catalog itself —
// every available theme, its label and its group — lives in the THEMES table, so a
// new theme never edits this component.

import { useAuth } from "../../lib/auth";
import {
	applyTheme,
	persistThemeToAccount,
	storeTheme,
	THEMES,
	type ThemeGroup,
	useTheme,
} from "../../lib/theme";

/** Group order as the picker shows it — the default (light) family's group first. */
const THEME_GROUPS: readonly ThemeGroup[] = ["Light", "Dark"];

export default function ThemeSelect({ className = "" }: { className?: string }) {
	const theme = useTheme();
	const { isAuthenticated } = useAuth();

	function pick(value: string) {
		const next = THEMES.find((option) => option.value === value);
		if (!next) return;
		applyTheme(next.value);
		storeTheme(next.value);
		if (isAuthenticated) persistThemeToAccount(next.value);
	}

	return (
		// w-36 pins the closed control at one width on every surface that mounts it —
		// DaisyUI's select stretches inside flex containers, and a select that grows
		// to fill the topbar slot reads like a filter control rather than a utility.
		<select
			value={theme}
			onChange={(event) => pick(event.target.value)}
			className={`select select-bordered select-sm w-36 shrink-0 ${className}`}
			aria-label="Color theme"
		>
			{THEME_GROUPS.map((group) => (
				<optgroup key={group} label={group}>
					{THEMES.filter((option) => option.group === group).map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}
