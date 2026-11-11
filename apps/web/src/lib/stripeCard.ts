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

/** CardElement `style` with theme-resolved colors Stripe will accept. */
export function cardElementStyle() {
	return {
		base: {
			fontSize: "16px",
			color: toRgb("oklch(var(--bc))"),
			"::placeholder": { color: toRgb("oklch(var(--bc) / 0.4)") },
		},
	};
}

/**
 * Appearance for the Payment and Address Elements, with the same theme-resolved colors the
 * card field uses. Stripe's Appearance API has the same restriction the `style` object has —
 * `oklch()` and CSS variables are rejected — so the values are rasterised to `rgb()` here
 * rather than passed through.
 */
export function stripeAppearance() {
	return {
		theme: "flat" as const,
		variables: {
			colorPrimary: toRgb("oklch(var(--p))"),
			colorText: toRgb("oklch(var(--bc))"),
			colorBackground: toRgb("oklch(var(--b1))"),
			colorDanger: toRgb("oklch(var(--er))"),
			borderRadius: "0.5rem",
		},
	};
}
