// SPDX-License-Identifier: AGPL-3.0-or-later
import onelineDark from "@anthers/brand/logo/web/lockup-oneline-dark.png";
import onelineLight from "@anthers/brand/logo/web/lockup-oneline-light.png";
import stackedDark from "@anthers/brand/logo/web/lockup-stacked-dark.png";
import stackedLight from "@anthers/brand/logo/web/lockup-stacked-light.png";
import taglineDark from "@anthers/brand/logo/web/lockup-tagline-dark.png";
import taglineLight from "@anthers/brand/logo/web/lockup-tagline-light.png";
import { useTheme } from "../../lib/theme";

type Variant = "full" | "oneline" | "stacked";

// Each cut ships a light- and dark-background artwork so the mark suits its surface.
const SOURCES: Record<Variant, Record<"light" | "dark", string>> = {
	full: { light: taglineLight, dark: taglineDark },
	oneline: { light: onelineLight, dark: onelineDark },
	stacked: { light: stackedLight, dark: stackedDark },
};

/**
 * The Anthers logo — the orchid spray and bee beside or above the "Anthers" wordmark.
 * Shared by the consumer site and the Studio. Three cuts:
 *   • "full"    — horizontal, with the "Our Creative Garden" tagline; the footer.
 *   • "oneline" — horizontal wordmark with no tagline; the compact navbar cut.
 *   • "stacked" — the orchids arched over the wordmark and tagline; roomy single-purpose
 *                 surfaces such as the site gate.
 *
 * useTheme() tracks the live `data-theme` on <html>, so flipping the topbar toggle swaps
 * the light/dark artwork instantly (no reload, no flash).
 *
 * The files are `packages/brand/logo/web/`, made from the logo's own exports by
 * `bun run brand:logo` and trimmed to the artwork, so a height utility sizes the logo
 * itself rather than a canvas around it. Size via `className` height utilities — the image
 * keeps its aspect ratio (w-auto + object-contain).
 */
export default function Logo({
	variant = "full",
	className = "h-8",
}: {
	variant?: Variant;
	className?: string;
}) {
	const theme = useTheme();
	return (
		<img
			src={SOURCES[variant][theme]}
			alt="Anthers"
			className={`w-auto object-contain ${className}`}
		/>
	);
}
