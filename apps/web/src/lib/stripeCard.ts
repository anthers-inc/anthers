// SPDX-License-Identifier: AGPL-3.0-or-later
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
