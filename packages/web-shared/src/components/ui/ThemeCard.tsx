// SPDX-License-Identifier: Apache-2.0
//
// The theme card on the account settings page. It is the signed-in home for the choice the
// header used to carry as a dropdown (Parker, 2026-10-26): the header's corner is for
// things that act on the page in front of you, and a preference that belongs to the account
// belongs with the account's other preferences.
//
// ⭐ **A theme and a variant are chosen separately** (Parker, 2026-11-06). A palette family
// and its light/dark variant are two independent choices, and the old card rendered them as
// one list under `Light` / `Dark` headings — which read as two themes rather than one theme
// in two variants. The family radio picks a name, the variant radio picks which of that
// family's entries to apply.
//
// The catalog is `THEMES` from lib/theme, the same table the marketing shell's dropdown
// renders, so a new theme family joins both surfaces by editing that table and nothing here.

import { THEMES } from "../../lib/theme";
import { useThemeChoice } from "../../lib/theme-choice";

/** Variant order as the picker shows it — the default (light) variant first. */
const VARIANTS = ["Light", "Dark"] as const;

export default function ThemeCard({ className = "" }: { className?: string }) {
	const { theme, choose } = useThemeChoice();

	// A theme family is the set of entries sharing a label; the variant is its group. The
	// catalog is the authority, so a family with only one variant renders one radio and a
	// family that gains a variant needs no change here.
	const families = [...new Set(THEMES.map((option) => option.label))].map((label) => ({
		label,
		variants: THEMES.filter((option) => option.label === label),
	}));

	const current = THEMES.find((option) => option.value === theme) ?? THEMES[0];
	const family = families.find((option) => option.label === current.label) ?? families[0];

	return (
		<div className={`card bg-base-200 ${className}`}>
			<div className="card-body">
				<h3 className="card-title text-lg">Color Theme</h3>

				<fieldset className="form-control mt-2 gap-1" aria-label="Theme">
					<legend className="text-xs font-medium text-base-content/50">Theme</legend>
					{families.map((option) => (
						<label
							key={option.label}
							className="label flex w-full whitespace-normal cursor-pointer justify-start gap-3 py-1"
						>
							<input
								type="radio"
								name="color-theme-family"
								className="radio radio-sm"
								checked={family.label === option.label}
								onChange={() => choose(option.variants[0].value)}
							/>
							<span className="label-text">{option.label}</span>
						</label>
					))}
				</fieldset>

				<fieldset className="form-control mt-2 gap-1" aria-label="Variant">
					<legend className="text-xs font-medium text-base-content/50">Variant</legend>
					{VARIANTS.map((variant) => {
						const option = family.variants.find((entry) => entry.group === variant);
						if (!option) return null;
						return (
							<label
								key={variant}
								className="label flex w-full whitespace-normal cursor-pointer justify-start gap-3 py-1"
							>
								<input
									type="radio"
									name="color-theme-variant"
									className="radio radio-sm"
									checked={current.group === variant}
									onChange={() => choose(option.value)}
								/>
								<span className="label-text">{variant}</span>
							</label>
						);
					})}
				</fieldset>
			</div>
		</div>
	);
}
