// SPDX-License-Identifier: Apache-2.0
/**
 * Read an EPUB container — a pure library, tested against hand-built books and holding
 * no I/O of its own. The ingest job (`jobs/ingest-ebook.ts`) hands it the zipfile's
 * entries and gets back the book's structure: the spine's reading order, each chapter's
 * title as the book's own navigation names it, and the manifest of non-section
 * components (images, stylesheets, fonts) the chapters reference.
 *
 * 🚨 **This parses creator input that the design treats as hostile.** An EPUB's bytes are
 * untrusted; nothing here evaluates anything (no scripts, no XML entities expanded, no
 * external references followed) — the functions read structure out of well-formed OCF
 * packages and refuse, with a legible message, what they cannot read. The extracted
 * XHTML is stored unchanged for the reader to render inside its sandboxed iframe; the
 * script-blocking posture is the reader's CSP, not a promise made of sanitizing here.
 *
 * Everything is keyed on **container-relative paths** (no leading slash, no `..`), which
 * is the stable identity a re-ingest keeps: storage keys change, these do not.
 */

/**
 * The container-relative path a chapter or asset lives at, per the OCF resolution rules:
 * manifest hrefs resolve against the OPF file's directory, and `..` paths from subpackage
 * directories are the normal way a book reaches shared resources.
 */
export function resolveHref(base: string, href: string): string {
	// URL-encoding is legal in hrefs (spaces, non-ASCII titles' graphics); decode what
	// decodes and keep the raw form otherwise — a malformed escape must not abort a book.
	let decoded = href;
	try {
		decoded = decodeURIComponent(href);
	} catch {
		// keep the raw href
	}
	// Fragments are chapter-relative views of the same file; the section's identity
	// is the file, so the anchor drops.
	decoded = decoded.split("#")[0];
	if (decoded.startsWith("/")) base = "";
	const parts = [...base.split("/").filter(Boolean), ...decoded.split("/").filter(Boolean)];
	const out: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") {
			out.pop();
			continue;
		}
		out.push(part);
	}
	return out.join("/");
}

/** Reverse of `resolveHref`'s direction: the directory part of a container-relative path. */
function dirOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

/** Text of the element's inner markup, minus any nested tags — used for nav labels only. */
function textOf(fragment: string): string {
	return decodeEntities(
		fragment
			.replace(/<[^>]*>/g, "")
			.replace(/\s+/g, " ")
			.trim(),
	);
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

/** Decode the XML entities a title or label can legally carry. Numeric ones included. */
export function decodeEntities(text: string): string {
	return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
		if (body.startsWith("#x") || body.startsWith("#X")) {
			const code = parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		if (body.startsWith("#")) {
			const code = parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return NAMED_ENTITIES[body] ?? match;
	});
}

export interface EpubSection {
	/** Container-relative path of the spine item's resource. */
	href: string;
	/** The chapter's name from the book's own navigation; "" when the book names it not. */
	title: string;
}

export interface EpubResource {
	/** Container-relative path inside the EPUB, as references resolve to it. */
	path: string;
	/** The media type the manifest declared, "" when none did. */
	mediaType: string;
	bytes: Uint8Array;
}

export interface ParsedEpub {
	/** Spine order, contiguous — the reading order (one entry per spine item). */
	sections: EpubSection[];
	/** Every manifest resource the spine did not carry, by container-relative path. */
	assets: EpubResource[];
	/**
	 * Every manifest resource — spine items included — by container-relative path. The
	 * spine's own bytes live here too, because a section is both a row of the manifest and
	 * the component the job uploads; `assets` is the spine-complement view of this map.
	 */
	resources: Map<string, EpubResource>;
}

function attr(tag: string, name: string): string {
	// Single or double quotes both occur in real EPUBs; this only ever reads well-formed
	// attributes out of our own required elements — a malformed book refuses upstream.
	const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
	return match ? (match[2] ?? match[3] ?? "") : "";
}

/** Parse `META-INF/container.xml` down to the OPF's container-relative path. */
function rootfilePath(entries: Record<string, Uint8Array>): string {
	const container = entries["META-INF/container.xml"];
	if (!container) throw new Error("This EPUB has no META-INF/container.xml and cannot be read");
	const text = Buffer.from(container).toString("utf8");
	// The first rootfile is the default one; real-world books ship exactly one.
	const rootfile = /<rootfile\b[^>]*>/i.exec(text)?.[0] ?? "";
	const fullPath = attr(rootfile, "full-path");
	if (!fullPath) throw new Error("This EPUB's container names no package file and cannot be read");
	return fullPath;
}

/**
 * Titles, from the book's own navigation: EPUB 3's nav document (a manifest item carrying
 * `properties="nav"`) first, EPUB 2's NCX fallback second. Keys are container-relative
 * hrefs, and a book whose chapters appear in the nav several times takes the first label
 * it gave them.
 */
function navTitles(
	entries: Record<string, Uint8Array>,
	items: Map<string, { href: string; properties: string[]; mediaType: string }>,
): Map<string, string> {
	const titles = new Map<string, string>();

	for (const item of items.values()) {
		if (!item.properties.includes("nav")) continue;
		// `item.href` is already container-relative (resolved at the manifest read); the
		// nav's OWN hrefs below resolve against the nav document's directory.
		const bytes = entries[item.href];
		if (!bytes) continue;
		const markup = Buffer.from(bytes).toString("utf8");
		// <a href="chapter.xhtml">Chapter One</a> — the anchor's text is the section's title.
		for (const anchor of markup.matchAll(/<a\b([^>]*)>(.*?)<\/a>/gis)) {
			const href = attr(anchor[1], "href");
			const title = textOf(anchor[2]);
			if (href && title) {
				const key = resolveHref(dirOf(item.href), href);
				if (!titles.has(key)) titles.set(key, title);
			}
		}
		break; // one nav document is authoritative; a second is noise
	}

	if (titles.size > 0) return titles;

	// EPUB 2 fallback: toc.ncx navPoints. Every NCX anchor's href rides its navLabel.
	for (const item of items.values()) {
		if (item.mediaType !== "application/x-dtbncx+xml") continue;
		const bytes = entries[item.href];
		if (!bytes) continue;
		const markup = Buffer.from(bytes).toString("utf8");
		for (const point of markup.matchAll(/<navPoint\b([\s\S]*?)<\/navPoint>/gi)) {
			const content = /<content\b[^>]*>/i.exec(point[1])?.[0] ?? "";
			const src = attr(content, "src");
			const label = textOf(/<navLabel>([\s\S]*?)<\/navLabel>/i.exec(point[1])?.[1] ?? "");
			// An NCX src can carry a fragment; the section is the file.
			if (src) {
				const key = resolveHref(dirOf(item.href), src);
				if (label && !titles.has(key)) titles.set(key, label);
			}
		}
		break;
	}

	return titles;
}

/**
 * Read a full EPUB package. `entries` is the zipfile's decompressed contents keyed by
 * name — the caller's bounds (the extraction caps) have already been applied before this
 * runs, so every byte here is paid for once and bounded.
 */
export function parseEpub(entries: Record<string, Uint8Array>): ParsedEpub {
	const opfPath = rootfilePath(entries);
	const opf = entries[opfPath];
	if (!opf)
		throw new Error(
			"This EPUB's package file is present in its manifest but missing from the container",
		);
	const opfDir = dirOf(opfPath);
	const markup = Buffer.from(opf).toString("utf8");

	// The manifest: every resource the package declares, by container-relative path.
	const items = new Map<string, { href: string; properties: string[]; mediaType: string }>();
	const manifest = /<manifest\b([\s\S]*?)<\/manifest>/i.exec(markup)?.[1] ?? "";
	for (const tag of manifest.matchAll(/<item\b[^>]*>/gi)) {
		const id = attr(tag[0], "id");
		const href = attr(tag[0], "href");
		if (!id || !href) continue;
		const resolved = resolveHref(opfDir, href);
		items.set(id, {
			href: resolved,
			// Properties are a space-separated token list (nav, cover-image, …).
			properties: (attr(tag[0], "properties") ?? "").split(/\s+/).filter(Boolean),
			mediaType: attr(tag[0], "media-type") ?? "",
		});
	}
	if (items.size === 0) {
		throw new Error("This EPUB declares no manifest and cannot be read");
	}

	// The spine, in order. `itemref` entries whose id is unknown are skipped rather than
	// fatal — a book with a stray linear="no" sidecar reference still reads whole.
	const spine = /<spine\b([\s\S]*?)<\/spine>/i.exec(markup)?.[1] ?? "";
	const spineHrefs: string[] = [];
	for (const tag of spine.matchAll(/<itemref\b[^>]*>/gi)) {
		const idref = attr(tag[0], "idref");
		const item = idref ? items.get(idref) : undefined;
		if (item?.href) spineHrefs.push(item.href);
	}
	if (spineHrefs.length === 0) {
		throw new Error("This EPUB has no readable spine (no chapters) — it cannot be read");
	}

	const titles = navTitles(entries, items);

	const sections: EpubSection[] = spineHrefs.map((href) => ({
		href,
		title: titles.get(href) ?? "",
	}));

	// Every manifest resource, spine items included: a component the manifest names but
	// the caps filtered out is absent from `entries` here, and it records nothing rather
	// than half a component — the inventory stays honest (the reader's lookup of a
	// missing reference reads as its own "not found", never as a wrong file).
	const spineSet = new Set(spineHrefs);
	const resources = new Map<string, EpubResource>();
	const assets: EpubResource[] = [];
	for (const item of items.values()) {
		const bytes = entries[item.href];
		if (!bytes) continue;
		const resource: EpubResource = {
			path: item.href,
			mediaType: item.mediaType,
			bytes,
		};
		resources.set(item.href, resource);
		if (!spineSet.has(item.href)) assets.push(resource);
	}

	return { sections, assets, resources };
}

/** The OCF identifier's magic, which every zip — EPUB included — starts with. */
export const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Whether these bytes are plausibly an (unencrypted) EPUB: the zip magic plus the OCF
 * convention in the container's first local header — `mimetype` first per the OCF spec,
 * or `META-INF/container.xml` immediately, which some producers emit first. Everything
 * past this (the container's own rootfile, the OPF, the spine) is `parseEpub`'s reading,
 * which refuses legibly what the convention hides; a DRM-locked EPUB fails either way,
 * which is why the ingest's message mentions it.
 */
export function looksLikeEpub(bytes: Uint8Array): boolean {
	if (bytes.length < 4) return false;
	if (
		bytes[0] !== ZIP_MAGIC[0] ||
		bytes[1] !== ZIP_MAGIC[1] ||
		bytes[2] !== ZIP_MAGIC[2] ||
		bytes[3] !== ZIP_MAGIC[3]
	) {
		return false;
	}
	// Read the first local file header's name: 26–27 are its length, 30.. the name.
	const nameLength = bytes[26] | (bytes[27] << 8);
	const name = Buffer.from(bytes.slice(30, 30 + nameLength)).toString("latin1");
	return name === "mimetype" || name === "META-INF/container.xml";
}
