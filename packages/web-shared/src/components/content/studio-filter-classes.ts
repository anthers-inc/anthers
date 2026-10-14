// SPDX-License-Identifier: Apache-2.0
/**
 * The sidebar filter sections' shared classes, for the Studio listing pages whose filters
 * register below the nav (Works, Projects — the Feed's sections are an apps/web sibling
 * this package cannot import, so the classes mirror it rather than being shared by it;
 * see apps/web's `components/layout/sidebar-row-class.ts`, whose active treatment this
 * carries by hand — 🚨 `primary`, never `secondary`: light `--color-secondary` is a soft
 * yellow that as text on the cream base is nearly invisible, and the nav's green is
 * what a selected row already reads as).
 */

export const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

export const filterBtnClass = (isActive: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full ${
		isActive
			? "bg-primary/10 text-primary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;
