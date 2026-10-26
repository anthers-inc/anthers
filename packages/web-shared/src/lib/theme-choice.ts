// SPDX-License-Identifier: Apache-2.0
//
// The one place a theme choice is made, shared by the two surfaces that offer one: the
// marketing shell's corner dropdown (`ThemeSelect`) and the account settings card
// (`ThemeCard`). A pick applies to the document immediately, persists to this device, and
// — when somebody is signed in — saves to the account, so it follows them across devices.
// Both halves call this hook rather than repeating the three steps, so a surface added
// later inherits the contract instead of a copy that can drift.

import { useAuth } from "./auth";
import { applyTheme, persistThemeToAccount, storeTheme, type Theme, useTheme } from "./theme";

export function useThemeChoice(): { theme: Theme; choose: (next: Theme) => void } {
	const theme = useTheme();
	const { isAuthenticated } = useAuth();

	function choose(next: Theme) {
		applyTheme(next);
		storeTheme(next);
		if (isAuthenticated) persistThemeToAccount(next);
	}

	return { theme, choose };
}
