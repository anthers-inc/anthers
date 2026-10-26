// SPDX-License-Identifier: Apache-2.0
//
// The theme card on the account settings page. It is the signed-in home for the choice the
// header used to carry as a dropdown (Parker, 2026-10-26): the header's corner is for
// things that act on the page in front of you, and a preference that belongs to the account
// belongs with the account's other preferences.
//
// The catalog is `THEMES` from lib/theme, the same table the marketing shell's dropdown
// renders, so a new theme joins both surfaces by editing that table and nothing here. The
// group headings stay because a theme is a palette family and `Light`/`Dark` are its
// variants — the table sorts them that way rather than treating a whole palette as a mode.

import { THEMES, type ThemeGroup } from "../../lib/theme";
import { useThemeChoice } from "../../lib/theme-choice";

/** Group order as the picker shows it — the default (light) family's group first. */
const THEME_GROUPS: readonly ThemeGroup[] = ["Light", "Dark"];

export default function ThemeCard({ className = "" }: { className?: string }) {
	const { theme, choose } = useThemeChoice();

	return (
		<div className={`card bg-base-200 ${className}`}>
			<div className="card-body">
				<h3 className="card-title text-lg">Color Theme</h3>
				<p className="text-sm text-base-content/60">
					Applies right away and saves to your account, so every device opens the same way.
				</p>

				{THEME_GROUPS.map((group) => (
					<fieldset key={group} className="form-control mt-2 gap-1">
						<legend className="text-xs font-medium text-base-content/50">{group}</legend>
						{THEMES.filter((option) => option.group === group).map((option) => (
							<label
								key={option.value}
								className="label whitespace-normal cursor-pointer justify-start gap-3 py-1"
							>
								<input
									type="radio"
									name="color-theme"
									className="radio radio-sm"
									checked={option.value === theme}
									onChange={() => choose(option.value)}
								/>
								<span className="label-text">{option.label}</span>
							</label>
						))}
					</fieldset>
				))}
			</div>
		</div>
	);
}
