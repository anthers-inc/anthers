// SPDX-License-Identifier: Apache-2.0
/**
 * Stripe Elements styling. Stripe renders in its own iframe, where the parent document's
 * CSS variables do not exist, and it rejects `oklch()` and `var()` in Appearance values,
 * so every color is resolved against the live document here and rasterised to
 * `rgb()`/`rgba()` before it is handed over.
 *
 * 🚨 **The appearance depends on the theme, and the theme can change while it is
 * mounted.** The colors are read from the document, so a value computed once is a
 * snapshot of whichever theme was active at mount; changing the theme then leaves the
 * Elements painted for the old one. `useStripeAppearance` tracks `data-theme` and hands
 * the provider a new appearance, which both Stripe React providers apply in place.
 *
 * 🚨 **A payment surface needs a dark theme, not a light theme with dark variables.**
 * Stripe's `flat` theme is a light theme: its outer block and labels stay light even when
 * `colorBackground` and `colorText` are dark, which left a white card with cream labels
 * on a dark page. `night` is the theme that carries dark defaults; the brand colors are
 * still set explicitly below.
 *
 * The two surfaces also have to be distinguishable. `colorBackground` is the field
 * surface (base-200), while the block around it is the page surface (base-100); when both
 * read base-100 the fields disappeared into the card, which is exactly what a buyer
 * cannot use. Borders, labels and placeholders are resolved to the same theme tokens
 * rather than left to Stripe's defaults.
 */
import { isDarkTheme, type Theme, useTheme } from "@anthers/web-shared/theme";
import { useMemo } from "react";

/** Resolve a CSS color against the live document, then rasterise it to `rgb()`/`rgba()`. */
function toRgb(cssColor: string): string {
	if (typeof document === "undefined") return "#111111";
	const probe = document.createElement("span");
	probe.style.color = cssColor;
	document.body.appendChild(probe);
	const computed = getComputedStyle(probe).color;
	probe.remove();
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx) return computed;
	ctx.fillStyle = computed;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
	return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(2)})`;
}

/** A token blended toward another one, for the muted roles that need a solid color. */
function mix(color: string, toward: string, percent: number): string {
	return toRgb(`color-mix(in oklch, ${color} ${percent}%, ${toward})`);
}

/** The site's body font, so Stripe's fields do not render in a different typeface. */
function siteFontFamily(): string | undefined {
	if (typeof document === "undefined") return undefined;
	return getComputedStyle(document.body).fontFamily || undefined;
}

/**
 * Appearance for the Payment and Address Elements, resolved from the active theme.
 *
 * The roles, in the order they appear on a surface:
 * - `surface` (base-100) is the block around the fields, matching the card they sit in.
 * - `field` (base-200) is every input's own background, so a field is visible as a field.
 * - `text` is body ink; `label`, `secondary` and `placeholder` are its muted blends.
 * - `primary` is focus and the selected payment-method tab; `danger` is an invalid field.
 */
export function stripeAppearance(theme: Theme) {
	const dark = isDarkTheme(theme);
	const surface = toRgb("var(--color-base-100)");
	const field = toRgb("var(--color-base-200)");
	const text = toRgb("var(--color-base-content)");
	const primary = toRgb("var(--color-primary)");
	const danger = toRgb("var(--color-error)");
	const label = mix("var(--color-base-content)", "var(--color-base-100)", 85);
	const secondary = mix("var(--color-base-content)", "var(--color-base-100)", 70);
	const placeholder = mix("var(--color-base-content)", "var(--color-base-100)", 55);
	const border = toRgb("color-mix(in oklch, var(--color-base-content) 24%, transparent)");
	const primarySoft = toRgb("color-mix(in oklch, var(--color-primary) 35%, transparent)");

	return {
		theme: dark ? ("night" as const) : ("flat" as const),
		variables: {
			fontFamily: siteFontFamily(),
			fontSizeBase: "16px",
			colorPrimary: primary,
			colorText: text,
			colorTextSecondary: secondary,
			colorTextPlaceholder: placeholder,
			colorBackground: field,
			colorDanger: danger,
			colorSuccess: toRgb("var(--color-success)"),
			colorWarning: toRgb("var(--color-warning)"),
			labelColorText: label,
			inputColorBorder: border,
			inputFocusColorBorder: primary,
			inputFocusBoxShadow: `0 0 0 2px ${primarySoft}`,
			accessibleColorOnColorPrimary: toRgb("var(--color-primary-content)"),
			accessibleColorOnColorBackground: text,
			borderRadius: "0.5rem",
		},
		rules: {
			// The block that carries the Payment Element, so a dark page never gets a
			// white card from Stripe's light defaults.
			".Block": { backgroundColor: surface },
			".BlockDivider": { borderColor: border },
			// Every field gets its own surface and a border, in both themes.
			".Input": {
				backgroundColor: field,
				border: `1px solid ${border}`,
				boxShadow: "none",
				color: text,
			},
			".Input:focus": {
				borderColor: primary,
				boxShadow: `0 0 0 2px ${primarySoft}`,
			},
			".Input--invalid": { borderColor: danger },
			".Input::placeholder": { color: placeholder },
			".Label": { color: label },
			".Tab--selected": { borderColor: primary, color: primary },
		},
	};
}

/**
 * The appearance for the current theme, recomputed when `data-theme` changes.
 *
 * Both Stripe React providers update a mounted Elements group in place when the
 * appearance changes, so a theme switch repaints the fields without remounting the form
 * and losing what the buyer typed.
 */
export function useStripeAppearance() {
	const theme = useTheme();
	return useMemo(() => stripeAppearance(theme), [theme]);
}
