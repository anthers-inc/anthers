// SPDX-License-Identifier: AGPL-3.0-or-later
import logoFull from "@anthers/brand/logo/anthers-lockup.png";
import logoFullDark from "@anthers/brand/logo/anthers-lockup-dark.png";
import logoOneline from "@anthers/brand/logo/anthers-lockup-oneline.png";
import logoOnelineDark from "@anthers/brand/logo/anthers-lockup-oneline-dark.png";
import { useTheme } from "../../lib/theme";

type Variant = "full" | "oneline";

// Each cut ships a light- and dark-background artwork so the mark suits its surface.
const SOURCES: Record<Variant, Record<"light" | "dark", string>> = {
	full: { light: logoFull, dark: logoFullDark },
	oneline: { light: logoOneline, dark: logoOnelineDark },
};

/**
 * The Anthers brand lockup — lily + bee + "Anthers" wordmark. Shared by the consumer
 * site and the Studio. Two cuts:
 *   • "full"    — with the "Our Creative Garden" tagline; footers, heroes, general use.
 *   • "oneline" — wordmark only, no tagline; the compact navbar cut.
 *
 * useTheme() tracks the live `data-theme` on <html>, so flipping the topbar toggle
 * swaps the light/dark artwork instantly (no reload, no flash).
 *
 * The artwork is the shared brand asset — packages/brand/logo/anthers-lockup*.png (a
 * raster placeholder for now). Bun's bundler emits each imported PNG as a hashed asset.
 * Swap those four files in @anthers/brand for the final artwork and every call site
 * updates at once. Size via `className` height utilities — the image keeps its aspect
 * ratio (w-auto + object-contain).
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
