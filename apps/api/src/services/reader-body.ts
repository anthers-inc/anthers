// SPDX-License-Identifier: Apache-2.0
/**
 * The words a Work, a post and a creator's profile carry for a reader that runs no
 * JavaScript.
 *
 * The standing pages are rendered at build time, because their text is in their components.
 * These three pages have no text until an API read answers, so their document bodies are
 * rendered here and injected by `apps/web/serve.ts` exactly as the standing pages' bodies
 * are. The split is the one `serve.ts` already keeps for the link card: this module renders
 * what it is handed, and each route that calls it applies the visibility and rating gates
 * its own page route applies.
 *
 * 🚨 **Everything a creator wrote is escaped here.** The fragment is injected into the
 * served document without React, so it is a trust boundary rather than a template: a title,
 * a bio or a project description containing markup must read as the text its author typed.
 * The one HTML string that travels unescaped is a post's body, which has already been through
 * the write boundary's sanitizer (`postBodyHtml`).
 *
 * The markup is deliberately plain — headings, paragraphs, lists and links — because a
 * reader without JavaScript gets the document's own base styling, not the app's.
 */
import { contentNoteLabel, maturityLabel } from "@anthers/shared/content-rating";
import { postBodyHtml } from "./post-markdown.js";

/** The account a document is by, as much of it as a reader needs. */
export interface ReaderAuthor {
	displayName?: string | null;
	handle?: string | null;
}

export interface WorkReaderInput {
	title: string | null;
	description: string | null;
	type: string;
	maturity: string;
	maturityNotes?: string[] | null;
	releasedAt?: Date | string | null;
	author: ReaderAuthor | null;
}

export interface PostReaderInput {
	title: string | null;
	body: string | null;
	publishedAt?: Date | string | null;
	author: ReaderAuthor | null;
}

export interface ProfileReaderProject {
	title: string | null;
	slug: string;
	description: string | null;
}

export interface ProfileReaderInput {
	displayName: string | null;
	handle: string | null;
	bio: string | null;
	websiteUrl: string | null;
	location: string | null;
	projects: ProfileReaderProject[];
}

/** Escape text for a document body. The five characters that can change its structure. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** A multi-line plain-text field, keeping the line breaks its author typed. */
function paragraphs(text: string): string {
	return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

/**
 * The kinds' human labels, matching the Studio's type pickers.
 *
 * `packages/web-shared` owns the labels, but that module imports React icons and cannot be
 * reached from the API. The list is short and the shared `ContentType` union is the thing
 * that fails to compile when a kind is added, so the drift has a loud edge rather than a
 * silent one.
 */
const TYPE_LABELS: Record<string, string> = {
	text: "Writing",
	video: "Video",
	music: "Music",
	audio: "Audio",
	image: "Image",
	comic: "Comic",
	ebook: "Book",
	game: "Game",
	software: "Software",
	physical: "Physical",
	service: "Service",
};

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
	month: "long",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

/** A stored timestamp as the date a page states, or null when it is absent or unreadable. */
function dateLabel(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	// Stored timestamps are instants; the date is stated in UTC so a server in any zone
	// prints the day the row says rather than the day before it.
	return DATE_FORMAT.format(value instanceof Date ? value : date);
}

/** A link to a creator's profile, or their name as plain text when no handle is known. */
function authorLine(author: ReaderAuthor | null): string | null {
	if (!author) return null;
	const name = author.displayName?.trim() || author.handle?.trim();
	if (!name) return null;
	const handle = author.handle?.trim();
	const label = escapeHtml(name);
	return handle
		? `<p>by <a href="/@${encodeURIComponent(handle)}">${label}</a></p>`
		: `<p>by ${label}</p>`;
}

/** A URL a reader body may link to: only the two schemes an ordinary site link uses. */
function safeHttpUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
	} catch {
		return null;
	}
}

/** One Work's words: what it is, who made it, when it came out and what it says it is. */
export function workReaderBody(work: WorkReaderInput): string {
	const title = work.title?.trim() || "Untitled";
	const facts: string[] = [];
	const type = TYPE_LABELS[work.type];
	if (type) facts.push(type);
	const released = dateLabel(work.releasedAt);
	if (released) facts.push(`Released ${released}`);
	// The page shows a rating only when it is above General: a General Work's rating is the
	// absent state rather than a label everyone needs to read.
	if (work.maturity === "mature" || work.maturity === "adult") {
		const notes = (work.maturityNotes ?? []).map(contentNoteLabel);
		facts.push(
			notes.length > 0
				? `${maturityLabel(work.maturity)} — ${notes.join(", ")}`
				: maturityLabel(work.maturity),
		);
	}

	const parts = [`<article><h1>${escapeHtml(title)}</h1>`];
	const by = authorLine(work.author);
	if (by) parts.push(by);
	if (facts.length > 0) parts.push(`<p>${facts.map(escapeHtml).join(" · ")}</p>`);
	const description = work.description?.trim();
	if (description) parts.push(`<p>${paragraphs(description)}</p>`);
	parts.push("</article>");
	return parts.join("");
}

/** One post's words: its heading, its maker, its stamp and its body. */
export function postReaderBody(post: PostReaderInput): string {
	const title = post.title?.trim() || "Untitled";
	const parts = [`<article><h1>${escapeHtml(title)}</h1>`];
	const by = authorLine(post.author);
	if (by) parts.push(by);
	const published = dateLabel(post.publishedAt);
	if (published) parts.push(`<p>${escapeHtml(published)}</p>`);
	const body = postBodyHtml(post.body);
	if (body) parts.push(body);
	parts.push("</article>");
	return parts.join("");
}

/** A creator's words: who they are, what they say about themselves and what they have made. */
export function profileReaderBody(profile: ProfileReaderInput): string {
	const name = profile.displayName?.trim() || profile.handle?.trim() || "A creator";
	const parts = [`<div><h1>${escapeHtml(name)}</h1>`];
	if (profile.handle) parts.push(`<p>@${escapeHtml(profile.handle)}</p>`);

	const bio = profile.bio?.trim();
	if (bio) parts.push(`<p>${paragraphs(bio)}</p>`);

	const facts: string[] = [];
	const website = safeHttpUrl(profile.websiteUrl);
	if (website)
		facts.push(`<a href="${escapeHtml(website)}">${escapeHtml(profile.websiteUrl ?? website)}</a>`);
	if (profile.location?.trim()) facts.push(escapeHtml(profile.location.trim()));
	if (facts.length > 0) parts.push(`<p>${facts.join(" · ")}</p>`);

	if (profile.projects.length > 0) {
		parts.push("<h2>Projects</h2><ul>");
		for (const project of profile.projects) {
			const title = project.title?.trim() || "Untitled";
			const description = project.description?.trim();
			parts.push(
				`<li><a href="/projects/${encodeURIComponent(project.slug)}">${escapeHtml(title)}</a>${
					description ? ` — ${escapeHtml(description)}` : ""
				}</li>`,
			);
		}
		parts.push("</ul>");
	}
	parts.push("</div>");
	return parts.join("");
}
