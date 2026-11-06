// SPDX-License-Identifier: Apache-2.0
//
// The theme card on the account settings page. It is the signed-in home for the choice the
// header used to carry as a dropdown (Parker, 2026-10-26): the header's corner is for
// things that act on the page in front of you, and a preference that belongs to the account
// belongs with the account's other preferences.
//
// ⭐ **It renders the same `ThemePicker` the marketing shell's dropdown does** (Parker,
// 2026-11-06): the variant toggle comes first, then the palette list, and each palette
// carries its primary-color swatch. The card supplies the surface and the heading; the
// controls and their order are shared, so the two surfaces cannot drift apart.

import ThemePicker from "./ThemePicker";

export default function ThemeCard({ className = "" }: { className?: string }) {
	return (
		<div className={`card bg-base-200 ${className}`}>
			<div className="card-body">
				<h3 className="card-title text-lg">Color Theme</h3>
				<ThemePicker />
			</div>
		</div>
	);
}
