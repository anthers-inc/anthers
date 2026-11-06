// SPDX-License-Identifier: Apache-2.0
//
// The shared theme controls. Both surfaces that offer a theme render this: the marketing
// shell's corner dropdown (a menu) and the account settings card (a form). A variant
// toggle comes first, then the palette list, and every palette carries a small swatch of
// its primary color in the variant on screen.
//
// ⭐ **The swatch is a nested `data-theme` scope**, so `bg-primary` resolves to that
// family's primary in the currently selected variant. Nothing here repeats a color value,
// and a palette adjustment in theme.css moves the swatch with the rest of the site.

import type { Theme, ThemeFamily, ThemeGroup } from "../../lib/theme";
import { themeFamilies, themeFamily, themeVariant, withVariant } from "../../lib/theme";
import { useThemeChoice } from "../../lib/theme-choice";

type Layout = "card" | "menu";

/** The family's entry for the variant on screen; its first entry if the family lacks one. */
function valueFor(family: ThemeFamily, variant: ThemeGroup): Theme {
	return (
		family.variants.find((option) => option.group === variant)?.value ?? family.variants[0].value
	);
}

/** A palette's primary color as a small rounded square, in the variant being shown. */
function ThemeSwatch({ value }: { value: Theme }) {
	return (
		<span data-theme={value} aria-hidden="true" className="inline-flex shrink-0">
			<span className="h-3.5 w-3.5 rounded-[4px] bg-primary ring-1 ring-inset ring-base-content/20" />
		</span>
	);
}

export default function ThemePicker({
	layout = "card",
	className = "",
}: {
	/** The menu gets DaisyUI item styling; the card gets a roomier list of its own. */
	layout?: Layout;
	className?: string;
}) {
	const { theme, choose } = useThemeChoice();
	const family = themeFamily(theme);
	const variant = themeVariant(theme);
	const families = themeFamilies();

	return (
		<div className={className}>
			<fieldset className="m-0 border-0 p-0">
				<legend className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-base-content/50">
					Variant
				</legend>
				<div className="mt-1 grid grid-cols-2 gap-1 rounded-lg bg-base-300/70 p-1">
					{(["Light", "Dark"] as const).map((option) => (
						<button
							key={option}
							type="button"
							aria-pressed={variant === option}
							onClick={() => choose(withVariant(theme, option))}
							className={`rounded-md px-2 py-1 text-xs transition-colors ${
								variant === option
									? "bg-base-100 font-semibold text-base-content shadow-sm"
									: "text-base-content/60 hover:text-base-content"
							}`}
						>
							{option}
						</button>
					))}
				</div>
			</fieldset>

			<fieldset className="m-0 mt-3 border-0 p-0">
				<legend className="px-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-base-content/50">
					Palette
				</legend>
				<div className="mt-1">
					<ul className={layout === "menu" ? "menu menu-sm w-full p-0" : "space-y-1"}>
						{families.map((option) => {
							const value = valueFor(option, variant);
							const active = option.label === family;
							const itemClass =
								layout === "menu"
									? active
										? "bg-primary/10 font-semibold text-primary"
										: ""
									: `flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
											active
												? "bg-primary/10 font-semibold text-primary"
												: "text-base-content/75 hover:bg-base-300/60 hover:text-base-content"
										}`;
							return (
								<li key={option.label}>
									<button
										type="button"
										aria-pressed={active}
										onClick={(event) => {
											choose(value);
											if (layout === "menu") event.currentTarget.blur();
										}}
										className={itemClass}
									>
										<ThemeSwatch value={value} />
										<span>{option.label}</span>
									</button>
								</li>
							);
						})}
					</ul>
				</div>
			</fieldset>
		</div>
	);
}
