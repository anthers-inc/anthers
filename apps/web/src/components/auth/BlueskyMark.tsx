// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bluesky's butterfly, as a single path.
 *
 * It sits here rather than inline because several surfaces draw it — the sign-in
 * affordance on `/login`, the signup card on `/subscribe`, the handle modal and the
 * linking card in settings — and a logo pasted five times is a logo that gets updated
 * once. Purely decorative: every caller supplies its own visible label, so this is
 * `aria-hidden` and contributes nothing to the accessibility tree.
 *
 * ⚠️ It is somebody else's mark, not ours, so it does not belong in `@anthers/brand`. That
 * package is the Anthers asset set and its licensing story is about Noun Project assets we
 * hold a license for; this is a third-party trademark used to name a third-party service.
 *
 * ── 🚨 The color is not ours to choose ──────────────────────────────────────────────
 *
 * Bluesky's brand guidance (https://bsky.social/about/support/branding) permits exactly
 * three colors for the butterfly — their blue `#0560FF`, black, and white — and says in
 * as many words: **"do not substitute, tint, or approximate."**
 *
 * This component drew with `fill-current` until 2026-08-23, which meant it took whichever
 * color its container happened to set. In practice that was `--color-base-content`, a
 * dark green in the light theme and a warm off-white in the dark one, and inside a
 * `btn-primary` it was `--color-primary-content`, which is *dark green* under the dark
 * theme. Every one of those is an approximation of their mark in our palette, which is
 * the specific thing the guidance forbids. Nothing looked wrong, which is why it survived
 * five call sites.
 *
 * So the default is now `--bluesky-mark`, a theme token defined in `theme.css` that holds
 * their blue in the light theme and white in the dark one — the two variants their
 * guidance names for light and dark backgrounds. **Reach for `variant` only when the
 * surface makes the token wrong** (a mark sitting on a colored button rather than on the
 * base), and pick from the three approved values rather than inventing a fourth.
 *
 * Two other rules worth knowing before you use this elsewhere, because they are easy to
 * break with good intentions: the mark may not be given effects (shadow, gradient,
 * outline, glow), and it may not be combined with other logos or icons into a single
 * composed element. Sitting beside our own chrome is fine; being merged into it is not.
 */

/** The three colors Bluesky's guidance allows, plus the theme-aware default. */
type MarkVariant = "auto" | "brand" | "black" | "white";

const FILL: Record<MarkVariant, string> = {
	auto: "var(--bluesky-mark)",
	brand: "#0560FF",
	black: "#000000",
	white: "#FFFFFF",
};

export default function BlueskyMark({
	className = "h-5 w-5",
	variant = "auto",
}: {
	className?: string;
	variant?: MarkVariant;
}) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 568 501"
			className={className}
			fill={FILL[variant]}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 189.32 552 210.074C529.348 289.699 445.566 310.618 370.792 297.604C496.333 319.1 526.542 386.3 468.333 453.5C356.973 581.793 299.832 402.163 287.455 359.379C285.755 353.725 284.024 353.712 282.545 359.379C270.168 402.163 213.027 581.793 101.667 453.5C43.4583 386.3 73.6667 319.1 199.208 297.604C124.434 310.618 40.652 289.699 18 210.074C11.945 189.32 2 75.2916 2 57.9464C2 -28.9064 78.1345 -1.61183 123.121 33.6637Z" />
		</svg>
	);
}
