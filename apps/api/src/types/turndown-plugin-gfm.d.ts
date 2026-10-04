// SPDX-License-Identifier: Apache-2.0
/** The package ships no types; the plugin's shape is one `use`-able rule bundle. */
declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: TurndownService.Plugin;
	export const tables: TurndownService.Plugin;
	export const strikethrough: TurndownService.Plugin;
	export const taskListItems: TurndownService.Plugin;
	export const highlightedCodeBlock: TurndownService.Plugin;
}
