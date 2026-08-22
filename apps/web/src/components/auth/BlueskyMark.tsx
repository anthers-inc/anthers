// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bluesky's butterfly, as a single path.
 *
 * It sits here rather than inline because two surfaces draw it — the sign-in affordance on
 * `/login` and the linking card in settings — and a logo pasted twice is a logo that gets
 * updated once. Purely decorative: every caller supplies its own visible label, so this is
 * `aria-hidden` and contributes nothing to the accessibility tree.
 *
 * ⚠️ It is somebody else's mark, not ours, so it does not belong in `@anthers/brand`. That
 * package is the Anthers asset set and its licensing story is about Noun Project assets we
 * hold a licence for; this is a third-party trademark used to name a third-party service.
 */
export default function BlueskyMark({ className = "h-5 w-5" }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 568 501"
			className={`fill-current ${className}`}
			xmlns="http://www.w3.org/2000/svg"
		>
			<path d="M123.121 33.6637C188.241 82.5526 258.281 181.681 284 234.873C309.719 181.681 379.759 82.5526 444.879 33.6637C491.866 -1.61183 568 -28.9064 568 57.9464C568 75.2916 558.055 189.32 552 210.074C529.348 289.699 445.566 310.618 370.792 297.604C496.333 319.1 526.542 386.3 468.333 453.5C356.973 581.793 299.832 402.163 287.455 359.379C285.755 353.725 284.024 353.712 282.545 359.379C270.168 402.163 213.027 581.793 101.667 453.5C43.4583 386.3 73.6667 319.1 199.208 297.604C124.434 310.618 40.652 289.699 18 210.074C11.945 189.32 2 75.2916 2 57.9464C2 -28.9064 78.1345 -1.61183 123.121 33.6637Z" />
		</svg>
	);
}
