// SPDX-License-Identifier: Apache-2.0
/**
 * The ebook reflow reader's engine glue: how a Work's section/asset ladder becomes a
 * foliate-js book object, and the two security decisions that ride along.
 *
 * The layering, exactly as the 2026-10-11 design fixed its fork boundary:
 *
 * - **The ladder loader is ours.** `loadText`/`loadBlob` map a container-relative path
 *   (the stable identity a re-ingest keeps) to the manifest's ladder URL and fetch it —
 *   sections through `/sections/:n`, assets through `/assets/:id`, each a checked,
 *   metered, signed-redirect route. Nothing here ever fetches a whole container, and the
 *   loader holds no second way to load a byte.
 * - **The reference rewriting is upstream's.** A chapter's XHTML references its images,
 *   stylesheets and fonts by zip-relative paths; foliate's `Loader` class (vendored,
 *   see `vendor/foliate-js/VENDOR.md`) resolves every one of them — `src`, `href`,
 *   `srcset`, CSS `url()` and inline styles — against that ladder loader and hands back
 *   blob URLs. Reimplementing that machinery would be the known-hard seam done worse.
 * - **The book object is ours.** It is built directly from `GET /works/:id/sections`:
 *   spine order, per-section titles (a flat TOC — the ingest keeps titles flat; a nested
 *   nav needs the manifest's shape to grow), sizes for foliate's reading-progress math,
 *   and href resolution the rest of the view navigates through. The view opens only this
 *   object (its own file-opening dispatch was removed at vendoring for the same reason).
 *
 * 🚨 **The security posture is concretely two rewrites and a standing test.** A section's
 * document is untrusted creator input; it renders inside the paginator's sandboxed
 * iframe, and the `data` transform below injects a **strict meta-CSP** as the document's
 * first-in-head policy — `script-src 'none'` and `connect-src 'none'` headline it — and
 * strips `<script>` elements and `<meta http-equiv="refresh">`. A meta CSP **intersects**
 * with any inherited policy, so the app's own CSP cannot widen it, and the app's
 * `connect-src 'self'` cannot make a scripted book fetchable. The e2e suite proves the
 * posture against a scripted EPUB over a real ingest; it is the authority on whether
 * this held, not this comment.
 */
import { Loader, resolveURL } from "@/vendor/foliate-js/epub.js";

/** One spine component, as `GET /works/:id/sections` returns it. */
export interface SectionManifestRow {
	position: number;
	/** Container-relative path, the stable identity a re-ingest keeps. */
	href: string;
	title: string;
	/** Byte size, for foliate's reading-progress weighting. */
	size?: number;
	/** Ladder path, prefixed with the API base the way the page reader composes its URLs. */
	url: string;
}

/** One non-section component, as the manifest returns it. */
export interface AssetManifestRow {
	path: string;
	mimeType: string;
	url: string;
}

export interface SectionManifest {
	sections: SectionManifestRow[];
	assets: AssetManifestRow[];
}

/**
 * A ladder fetch that said no for a reason a reader should answer politely: an expired
 * allowance (402 — the Public Access meter), an access failure (403), the household
 * limit. The chrome renders this rather than a stack trace.
 */
export class LadderRefusal extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = "LadderRefusal";
	}
}

const shareQuery = (shareToken: string | null | undefined) =>
	shareToken ? `?share=${encodeURIComponent(shareToken)}` : "";

/**
 * The one way the app fetches a ladder URL. Every load the reader ever performs —
 * sections, assets, the manifest itself — goes through here: session credentials on,
 * share token riding the query the way the page reader composes its `<img>` URLs, and
 * refusals surfaced as {@link LadderRefusal} rather than silent empty strings.
 */
async function ladderFetch(url: string, shareToken: string | null | undefined): Promise<Response> {
	const res = await fetch(`${url}${shareQuery(shareToken)}`, { credentials: "include" });
	if (!res.ok) {
		if (res.status === 402) {
			throw new LadderRefusal(
				402,
				"This Work needs more of your monthly time allowance to keep reading.",
			);
		}
		if (res.status === 403) {
			throw new LadderRefusal(403, "You no longer have access to this Work.");
		}
		throw new LadderRefusal(
			res.status,
			`The reader could not load a piece of this book (${res.status}).`,
		);
	}
	return res;
}

/** The manifest itself, from the Work's page-fetch shape exactly as `ComicReader` reads its pages. */
export async function fetchSectionManifest(
	workId: number,
	apiBase: string,
	shareToken: string | null | undefined,
): Promise<SectionManifest> {
	const url = `${apiBase}/api/content/works/${workId}/sections`;
	const res = await ladderFetch(url, shareToken);
	return (await res.json()) as SectionManifest;
}

/**
 * The policy the section documents carry. Every load is refused unless it is a blob the
 * ladder's rewriter itself produced — so a chapter can show its pictures and load its
 * fonts and never fetch, submit, embed or execute anything else. Exported because the
 * reader chrome verifies each loaded section's document against it: what a loaded
 * section actually carries is the one fact worth surfacing, and worth testing against.
 */
export const SECTION_CSP = [
	"default-src 'none'",
	"script-src 'none'",
	"style-src 'unsafe-inline' blob:",
	"img-src blob: data:",
	"font-src blob:",
	"media-src blob:",
	"connect-src 'none'",
	"form-action 'none'",
	"base-uri 'none'",
	"frame-src 'none'",
	"object-src 'none'",
].join("; ");

// The section documents' media types the hardening applies to. `text/html` rides the
// list even though the manifest says XHTML: foliate's loader re-types a chapter that
// XML-parses incorrectly as HTML and still hands that document to the reader, and an
// unhardened fallback would be exactly the hole the posture must not have.
const HARDENABLE_TYPES = ["application/xhtml+xml", "application/xml", "text/xml", "text/html"];

/**
 * The rewrite foliate's `Loader` does not do and must not be trusted to: the section
 * document that goes out as a blob URL (a) carries the strict CSP as its own meta tag,
 * (b) carries no `<script>` elements, and (c) carries no `<meta http-equiv="refresh">`.
 *
 * Injected first-in-head so the policy is live before anything after it parses. Parsing
 * as XML first mirrors upstream's own loadReplaced fallback — a book whose chapters only
 * HTML-parse still gets its rewrite, and the serializer emits what the blob will hold.
 */
function hardenSectionDocument(str: string): string {
	let doc: Document;
	let parser = new DOMParser();
	doc = parser.parseFromString(str, "application/xhtml+xml");
	if (doc.querySelector("parsererror")) {
		parser = new DOMParser();
		doc = parser.parseFromString(str, "text/html");
	}

	doc.querySelectorAll("script").forEach((el) => {
		el.remove();
	});
	doc.querySelectorAll('meta[http-equiv="refresh" i]').forEach((el) => {
		el.remove();
	});
	// Any policy already in the book cannot widen ours — policies intersect — but an
	// author-supplied one only confuses the reader's own, so nothing of it rides along.
	doc.querySelectorAll('meta[http-equiv="content-security-policy" i]').forEach((el) => {
		el.remove();
	});
	// 🚨 **Off-ladder subresources go, not just get CSP-blocked.** The rewriter has already
	// pointed every reference the manifest holds at a blob of its own making; what is left
	// pointing at an absolute external address is content the ladder never delivered, and
	// Chromium's preload scanner can issue for it BEFORE the document's own CSP attaches —
	// a request whose failure itself is a leak (it tells the far host a reader opened this
	// book). So an absolute http(s) subresource loses its attribute outright: no request
	// event, no failure event, nothing to enforce. A relative path that resolves to
	// nothing stays — it can only 404 against this origin, read nothing, and leak nothing.
	for (const el of doc.querySelectorAll("[src], [data], [poster], link[href], track, image")) {
		for (const attr of ["src", "href", "data", "poster", "xlink:href"]) {
			const value = el.getAttribute(attr);
			if (value && /^(https?:)?\/\//i.test(value)) el.removeAttribute(attr);
		}
	}

	const head = doc.querySelector("head") ?? doc.querySelector("html");
	if (head) {
		const meta = doc.createElement("meta");
		meta.setAttribute("http-equiv", "Content-Security-Policy");
		meta.setAttribute("content", SECTION_CSP);
		head.insertBefore(meta, head.firstChild);
	}
	return new XMLSerializer().serializeToString(doc);
}

/**
 * The loader foliate's machinery is driven by — three functions keyed on
 * container-relative paths, backed by nothing but the ladder. Exported because the unit
 * suite asserts exactly this mapping: a path the manifest knows goes out to the right
 * ladder URL (session credentials on, the share token riding the query), and a path the
 * manifest does not know refuses rather than guessing — which is what keeps
 * `downloadEnabled: false` honest at the smallest granularity the medium has.
 */
export function makeLadderLoader(
	manifest: SectionManifest,
	apiBase: string,
	shareToken: string | null | undefined,
) {
	const sectionsByHref = new Map(manifest.sections.map((s) => [s.href, s]));
	const assetsByPath = new Map(manifest.assets.map((a) => [a.path, a]));
	const absolute = (path: string) => `${apiBase}${path}`;

	const loadText = async (href: string) => {
		const row = sectionsByHref.get(href) ?? assetsByPath.get(href);
		if (!row)
			throw new LadderRefusal(
				404,
				`This book references "${href}", which the manifest does not hold.`,
			);
		const res = await ladderFetch(absolute(row.url), shareToken);
		return await res.text();
	};

	const loadBlob = async (href: string) => {
		const row = assetsByPath.get(href);
		// Binary assets come from the manifest only; a section's XHTML never rides this
		// method (it goes out rewritten and blobbed through the Loader), so an asset path
		// the manifest does not hold is not loadable, full stop.
		if (!row)
			throw new LadderRefusal(
				404,
				`This book references "${href}", which the manifest does not hold.`,
			);
		const res = await ladderFetch(absolute(row.url), shareToken);
		return new Blob([await res.blob()], { type: row.mimeType });
	};

	// (The third loader method upstream's `EPUB` class wants, `getSize`, deliberately does
	// not exist here: there is no whole-container size that honestly belongs to the
	// ladder, and the reading-progress sizes ride the manifest rows into the book.)
	return { loadText, loadBlob };
}

/**
 * The section documents' XHTML media type, as foliate's loader keys its rewrite on.
 */
const SECTION_MEDIA_TYPE = "application/xhtml+xml";

/**
 * Build the book interface object the vendored view opens. The manifest is the whole
 * book: sections in spine order (positions 1…n, already ordered by the API), the flat
 * TOC from the sections' own titles, sizes for the progress math, and href resolution
 * the view's link handling and TOC walk both go through.
 */
export function buildEbookBook(
	workTitle: string,
	manifest: SectionManifest,
	apiBase: string,
	shareToken: string | null | undefined,
): object {
	const loader = makeLadderLoader(manifest, apiBase, shareToken);
	const foliateLoader = new Loader({
		loadText: loader.loadText,
		loadBlob: loader.loadBlob,
		// The manifest, as foliate's Loader reads it: every component the book resolves
		// references against, in one list keyed by container-relative href.
		resources: {
			manifest: [
				...manifest.sections.map((s) => ({ href: s.href, mediaType: SECTION_MEDIA_TYPE })),
				...manifest.assets.map((a) => ({ href: a.path, mediaType: a.mimeType })),
			],
		},
	});

	// The security hook lives here rather than inside the vendored tree: what a loaded
	// document may do is Anthers' decision, and the `data` event is upstream's own
	// transform point for exactly this.
	foliateLoader.eventTarget.addEventListener("data", (ev: Event) => {
		const detail = (ev as CustomEvent<{ data: unknown; type: string; name: string }>).detail;
		if (typeof detail.data !== "string" || !HARDENABLE_TYPES.includes(detail.type)) return;
		detail.data = hardenSectionDocument(detail.data);
	});

	const indexByHref = new Map(manifest.sections.map((s) => [s.href, s.position - 1]));

	// An href resolved inside a section — by that section's own resolver — becomes an
	// absolute container path, with or without a fragment. Both halves below read it.
	const resolveTarget = (href: string): { path: string; fragment: string | null } => {
		const [rawPath, rawFragment] = href.split("#") as [string, string | undefined];
		return {
			path: rawPath.replace(/^\//, ""),
			fragment: rawFragment != null ? decodeURIComponent(rawFragment) : null,
		};
	};

	const sections = manifest.sections.map((s) => ({
		id: s.href,
		load: () => foliateLoader.loadItem({ href: s.href, mediaType: SECTION_MEDIA_TYPE }),
		unload: () => foliateLoader.unloadItem({ href: s.href }),
		createDocument: async () => {
			const text = await loader.loadText(s.href);
			return new DOMParser().parseFromString(text, SECTION_MEDIA_TYPE);
		},
		size: s.size ?? 0,
		// The fragment resolver of a link that points into this section from another.
		resolveHref: (href: string) => resolveURL(href, s.href),
	}));

	const fragmentAnchor = (doc: Document, fragment: string | null) => {
		if (!fragment) return null;
		return doc.getElementById(fragment) ?? doc.querySelector(`[name="${CSS.escape(fragment)}"]`);
	};

	return {
		sections,
		// A flat TOC of the sections the book's own spine names. Nested navigation waits
		// on the manifest growing the nav's structure; the flat list is a TOC, and the
		// reader chrome renders it as one.
		toc: manifest.sections.filter((s) => s.title).map((s) => ({ label: s.title, href: s.href })),
		metadata: { title: workTitle },
		dir: "ltr" as const,
		resolveHref: (href: string) => {
			const { path, fragment } = resolveTarget(href);
			const index = indexByHref.get(path);
			if (index == null) {
				// Nowhere — the view's own go-to catch logs it rather than landing the
				// reader somewhere real. A broken internal link must not mean "go to the
				// start of the book".
				return { index: -1, anchor: () => null };
			}
			return { index, anchor: (doc: Document) => fragmentAnchor(doc, fragment) };
		},
		// The split upstream's TOC progress walks with: the first half is the section
		// **id** — the container-relative path, exactly what this book's sections carry —
		// matched as a string against the spine; the fragment rides along for anchor
		// resolution.
		splitTOCHref: (href: string) => {
			const { path, fragment } = resolveTarget(href);
			return [path, fragment] as const;
		},
		getTOCFragment: (doc: Document, fragment: string | null) => fragmentAnchor(doc, fragment),
		// The same test upstream's EPUB uses: a scheme is external unless it is the blob
		// scheme the rewriter itself produced.
		isExternal: (href: string) => /^(?!blob)\w+:/i.test(href),
	};
}
