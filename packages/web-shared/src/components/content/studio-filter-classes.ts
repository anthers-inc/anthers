// SPDX-License-Identifier: Apache-2.0
/**
 * The sidebar filter sections' shared classes, for the Studio listing pages whose filters
 * register below the nav (Works, Projects — the Feed's sections are an apps/web sibling
 * this package cannot import, so the classes mirror it rather than being shared by it).
 */

export const sectionTitleClass =
	"text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5";

export const filterBtnClass = (isActive: boolean) =>
	`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors w-full ${
		isActive
			? "bg-secondary/10 text-secondary font-medium"
			: "text-base-content/70 hover:bg-base-300/50 hover:text-base-content"
	}`;
