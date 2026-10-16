// SPDX-License-Identifier: Apache-2.0
//
// The topbar theme picker, shared by the consumer site and the Studio. A daisyUI
// dropdown in the same shape as the account menu in LoggedInLayout — the CSS-only
// focus pattern, whose reasoning lives beside that menu — rather than a form select:
// the trigger names the theme in use, and the menu lists THEMES from lib/theme under
// Light and Dark headings, the active one marked menu-active.
//
// Picking keeps the contract the toggle this replaced had: the choice applies
// immediately and persists always to the device, and when signed in additionally to
// the account, so it follows the user across devices (see AuthProvider, which applies
// the account preference on load). The catalog itself — every available theme, its
// label and its group — lives in the THEMES table, so a new theme never edits this
// component.

import { ChevronDownIcon, SwatchIcon } from "@heroicons/react/24/outline";
import { Fragment } from "react";
import { useAuth } from "../../lib/auth";
import {
	applyTheme,
	persistThemeToAccount,
	storeTheme,
	THEMES,
	type Theme,
	type ThemeGroup,
	useTheme,
} from "../../lib/theme";

/** Group order as the picker shows it — the default (light) family's group first. */
const THEME_GROUPS: readonly ThemeGroup[] = ["Light", "Dark"];

export default function ThemeSelect({ className = "" }: { className?: string }) {
	const theme = useTheme();
	const { isAuthenticated } = useAuth();
	const current = THEMES.find((option) => option.value === theme) ?? THEMES[0];

	function apply(next: Theme) {
		applyTheme(next);
		storeTheme(next);
		if (isAuthenticated) persistThemeToAccount(next);
	}

	return (
		// dropdown-end so the menu grows leftward from the trigger on both surfaces that
		// mount it: the nav's right cluster and the mobile menu's Theme row.
		<div className={`dropdown dropdown-end ${className}`}>
			<button
				type="button"
				tabIndex={0}
				className="btn btn-ghost btn-sm gap-1.5 px-3"
				title="Color theme"
			>
				<SwatchIcon className="w-4 h-4" />
				<span>{current.label}</span>
				<ChevronDownIcon className="w-3.5 h-3.5 opacity-60" />
			</button>
			<ul className="menu menu-sm dropdown-content z-50 mt-1 w-36 p-2 shadow bg-base-200 rounded-box">
				{THEME_GROUPS.map((group) => (
					<Fragment key={group}>
						<li className="menu-title px-2 pb-0.5 pt-2">
							<span className="text-xs text-base-content/50">{group}</span>
						</li>
						{THEMES.filter((option) => option.group === group).map((option) => (
							<li key={option.value}>
								{option.value === theme ? (
									<button type="button" className="menu-active">
										{option.label}
									</button>
								) : (
									/* blur() closes the CSS-only dropdown after a pick: focus-within is
									   what holds it open, and a selected option's button would
									   otherwise swallow focus and keep the menu standing. */
									<button
										type="button"
										onClick={(e) => {
											apply(option.value);
											e.currentTarget.blur();
										}}
									>
										{option.label}
									</button>
								)}
							</li>
						))}
					</Fragment>
				))}
			</ul>
		</div>
	);
}
