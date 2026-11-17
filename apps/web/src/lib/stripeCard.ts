// SPDX-License-Identifier: Apache-2.0
/**
 * Stripe Elements card styling. Stripe rejects `oklch()`/CSS vars, so resolve the
 * themed colors to concrete `rgb()` at runtime (rasterise one pixel), keeping the
 * card field on-theme in light and dark.
 */
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

/** The site's body font, so Stripe's fields do not render in a different typeface. */
function siteFontFamily(): string | undefined {
	if (typeof document === "undefined") return undefined;
	return getComputedStyle(document.body).fontFamily || undefined;
}

/**
 * Appearance for the Payment and Address Elements, with theme-resolved colors. Stripe's
 * Appearance API rejects `oklch()` and CSS variables, so the values are rasterised to
 * `rgb()` here rather than passed through.
 *
 * 🚨 **These are DaisyUI 5's tokens, and the short names are gone, not renamed quietly.**
 * This read `oklch(var(--bc))`, `--b1`, `--p` and `--er` — DaisyUI 4's variables — long
 * after the theme moved to DaisyUI 5, which defines none of them. An undefined custom
 * property inside `var()` makes the whole declaration invalid rather than falling back to
 * a default, so the probe kept the color it inherited from `body` and every Element was
 * painted with that one value: on the light theme the card and address fields came out
 * dark green (the body's ink) with dark green text, and on the dark theme they came out
 * cream with cream labels, which is unreadable rather than merely wrong.
 *
 * The tokens are complete colors, so they are passed through whole — never wrapped in
 * `oklch()` again, which would be `oklch(oklch(…))`. `stripeCard.test.ts` watches both
 * halves of that, because a missing variable here fails silently in exactly this way.
 */
export function stripeAppearance() {
	return {
		theme: "flat" as const,
		variables: {
			fontFamily: siteFontFamily(),
			fontSizeBase: "16px",
			colorPrimary: toRgb("var(--color-primary)"),
			colorText: toRgb("var(--color-base-content)"),
			colorBackground: toRgb("var(--color-base-100)"),
			colorDanger: toRgb("var(--color-error)"),
			borderRadius: "0.5rem",
		},
	};
}
