// SPDX-License-Identifier: Apache-2.0
/**
 * The signed-in account's rebindable shortcuts, resolved with their defaults.
 *
 * The player keymaps and the settings card read the same map through here, so a chord a
 * person records is the chord the player matches — the two cannot drift into different
 * ideas of what "the full-screen key" is. Signed out there is no account preference, and
 * the defaults stand; the player still works the same way.
 */
import { type KeyboardShortcuts, resolveKeyboardShortcuts } from "@anthers/shared/keybindings";
import { useAuth } from "@anthers/web-shared/auth";
import { useMemo } from "react";

export function useKeyboardShortcuts(): KeyboardShortcuts {
	const { user } = useAuth();
	return useMemo(
		() => resolveKeyboardShortcuts(user?.keyboardShortcuts),
		[user?.keyboardShortcuts],
	);
}
