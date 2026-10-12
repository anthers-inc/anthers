// SPDX-License-Identifier: Apache-2.0
/**
 * Hand-rolled declarations for the vendored foliate-js tree (`src/vendor/foliate-js/`,
 * see its VENDOR.md). The vendored modules are plain JavaScript with no type surface —
 * they are excluded from tsc (`allowJs` stays off), and these ambient declarations cover
 * exactly what the reader glue imports, no more: the rest of the tree is reached only
 * through `view.js`'s own imports, which tsc never sees.
 *
 * The declarations mirror upstream's documented book interface (README § The Main
 * Interface for Books); anything beyond what the glue uses is typed loosely on purpose —
 * upstream's API is explicitly unstable, and widening these by hand on every upstream
 * refresh would be a tax the vendoring does not want.
 */

interface FoliateSection {
	id: string;
	load(): Promise<string> | string | null;
	unload?(): void;
	createDocument?(): Promise<Document> | Document;
	size?: number;
	linear?: string;
	cfi?: string;
	pageSpread?: "left" | "right" | "center";
}

/**
 * The book interface object the reader glue builds from the access-ladder manifest.
 * Structural only — the optional fields the view consults are the ones present.
 */
interface FoliateBook {
	sections: FoliateSection[];
	toc: { label: string; href: string; subitems?: FoliateBook["toc"] }[];
	metadata?: { title?: string; language?: string; author?: string | string[] };
	dir?: "ltr" | "rtl";
	resolveHref(href: string): { index: number; anchor(doc: Document): Node | null | unknown };
	splitTOCHref(href: string): [unknown, string | null] | Promise<[unknown, string | null]>;
	getTOCFragment(doc: Document, id: unknown): Node | null | Promise<Node | null>;
	isExternal(href: string): boolean;
}

declare module "@/vendor/foliate-js/view.js" {
	const View: {
		new (): {
			open(book: object): Promise<void>;
			init(opts?: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
			goTo(target: string | number | { fraction: number }): Promise<unknown>;
			goToFraction(fraction: number): Promise<void>;
			next(distance?: number): Promise<void>;
			prev(distance?: number): Promise<void>;
			goLeft(): Promise<void>;
			goRight(): Promise<void>;
			close(): void;
			renderer: HTMLElement | null;
			getSectionFractions(): number[];
			addEventListener(
				type: "relocate",
				listener: (
					e: CustomEvent<{ index: number; fraction: number; cfi: string; reason: string }>,
				) => void,
			): void;
			addEventListener(
				type: "load",
				listener: (e: CustomEvent<{ doc: Document; index: number }>) => void,
			): void;
			addEventListener(type: "external-link", listener: EventListener): void;
			addEventListener(type: string, listener: EventListener): void;
		};
	};

	export { View };
}

declare module "@/vendor/foliate-js/epub.js" {
	/**
	 * Upstream's resource-rewriting machinery, driven by the reader's ladder-backed
	 * loader. `resources.manifest` is the list of container-relative components
	 * (`{ href, mediaType }`) references are resolved against.
	 */
	export class Loader {
		constructor(opts: {
			loadText(href: string): Promise<string> | string | null;
			loadBlob(href: string, type?: string): Promise<Blob> | Blob | null;
			resources: { manifest: { href: string; mediaType: string }[] };
		});
		eventTarget: EventTarget;
		loadItem(item: { href: string; mediaType: string }, parents?: string[]): Promise<string | null>;
		unloadItem(item: { href: string } | null | undefined): void;
		destroy(): void;
	}
	export function resolveURL(url: string, relativeTo: string): string;
}
