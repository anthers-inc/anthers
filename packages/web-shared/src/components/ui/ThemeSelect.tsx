// SPDX-License-Identifier: Apache-2.0
//
// The marketing shell's corner theme picker. A daisyUI dropdown rather than a form
// select: an icon-only circle trigger (the corner utilities' own shape) over a panel
// that leads with the variant toggle and follows with the palette list, each palette
// carrying a swatch of its primary color in the variant on screen. Both halves are
// `ThemePicker`, the same component the account settings card renders, so the two
// surfaces cannot drift apart.
//
// ⚠️ **The signed-in site does not use this.** Its theme choice moved into the account
// settings page's card (Parker, 2026-10-26) — a preference that belongs to the account
// belongs with the account's other preferences, and the signed-in header's corner is for
// things that act on the page in front of you. This picker is the signed-out visitor's
// alone, and the two surfaces share `useThemeChoice` so the pick behaves identically.

import { SwatchIcon } from "@heroicons/react/24/outline";
import ThemePicker from "./ThemePicker";

export default function ThemeSelect({ className = "" }: { className?: string }) {
	return (
		// dropdown-end so the menu grows leftward from the trigger on both surfaces that
		// mount it: the floating corner utilities and the mobile menu's Theme row. The
		// trigger stays icon-only — a circle button, the shape the corner toggle this
		// replaced had — because the theme names live in the menu, not on the topbar.
		<div className={`dropdown dropdown-end ${className}`}>
			<button
				type="button"
				tabIndex={0}
				className="btn btn-ghost btn-sm btn-circle"
				aria-label="Color theme"
				title="Color theme"
			>
				<SwatchIcon className="w-5 h-5" />
			</button>
			<div className="dropdown-content z-50 mt-1 w-60 rounded-box border border-base-content/10 bg-base-200 p-3 shadow">
				{/* The border: base-200 sits only two steps above the cream page it floats
				    over, so the panel's edge can dissolve at light themes (Parker,
				    2026-10-16) — the shadow alone doesn't state the box the way this
				    hairline does. */}
				<ThemePicker layout="menu" />
			</div>
		</div>
	);
}
