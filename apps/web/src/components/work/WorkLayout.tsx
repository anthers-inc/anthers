// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's page as a reader sees it, in parts, shared by the public Work page and the Studio's
 * Edit page. Parker's direction (2026-09-17) is that the Edit page looks like the Work, with its
 * details editable where they appear, rather than being a form a creator fills in blind.
 *
 * 🚨 **One layout, so the Edit page cannot drift from what a reader sees.** The Edit page exists
 * to show a creator the truth about their Work's page, and a second copy of this layout would
 * start lying the first time one of the two changed. Each part renders the reader's version by
 * default, and the Edit page passes its controls into the slots for the parts a creator changes.
 *
 * Nothing here decides access. Whether the deliverable may be shown at all is the caller's
 * question, answered by the server's verdict on the reader page and by ownership on the Edit page.
 */

import { isListened, isPaged } from "@anthers/shared/content";
import { contentNoteLabel } from "@anthers/shared/content-rating";
import { FONTS } from "@anthers/web-shared/fonts";
import { profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { apiBaseUrl } from "@anthers/web-shared/rpc";
import type { Work } from "@anthers/web-shared/types";
import { CalendarIcon, ClockIcon } from "@heroicons/react/24/outline";
import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { useMediaPlayer } from "../../lib/media-player";
import { trackFromWork } from "../../lib/tracks";
import AudioPlayer from "../media/AudioPlayer";
import ComicReader from "../media/ComicReader";
import { PublicAccessFooter } from "../media/PublicAccessNotice";
import SpokenPlayer from "../media/SpokenPlayer";
import VideoPlayer from "../media/VideoPlayer";
import ProjectEmbed from "../project/ProjectEmbed";
import ContentTypeBadge from "../ui/ContentTypeBadge";
import SanitizedHtml from "../ui/SanitizedHtml";

/** A Work as the detail endpoint returns it — with its creator and posting history. */
export type WorkDetail = Work & {
	creator?: { handle: string; displayName: string | null; avatar: string | null };
	/** Whether the creator can actually take a direct payment (Connect onboarded). */
	creatorHasStripe?: boolean;
	/**
	 * Display name of whoever shared the link this page was reached by. Present only on a
	 * share view — a display name and nothing else, since the rest of that person's account
	 * is none of the recipient's business.
	 */
	sharedBy?: string | null;
	postedIn?: {
		slug: string;
		title: string | null;
		isPublished: boolean;
		postedAt: string | null;
	}[];
};

/** The title's typography, so a control standing in for the title reads as the title. */
export const WORK_TITLE_CLASS = "text-3xl font-bold";

/** The public blurb's typography, likewise. */
export const WORK_DESCRIPTION_CLASS = "prose max-w-none text-base-content/80";

/**
 * Whether a Work is a piece of writing, which reads as an article rather than as a player.
 *
 * ⭐ **The reading experience is what tells writing apart from a post** (Parker, 2026-09-11): a
 * post is social and a text Work is an essay, a story or a poem, and the two were prose in the same
 * editor with nothing on the page to say which a reader was holding. So a text Work gets a reading
 * column, a display serif for its headline (Fraunces), its description as a standfirst under the
 * headline, and a text serif for its body (Spectral), where every post is set in the app's sans.
 */
export function isWriting(type: string): boolean {
	return type === "text";
}

/** The headline of a piece of writing, and the typography of a control standing in for it. */
export const WRITING_TITLE_CLASS = "text-4xl font-semibold leading-tight";
export const WRITING_TITLE_STYLE: CSSProperties = { fontFamily: FONTS.fraunces };

/** The standfirst: a piece of writing's description, set under its headline. */
export const WRITING_STANDFIRST_CLASS = "text-xl leading-snug text-base-content/70";
export const WRITING_BODY_STYLE: CSSProperties = { fontFamily: FONTS.spectral };

/** A piece of writing's body: a text serif at a reading size, with room between the lines. */
export const WRITING_ARTICLE_CLASS =
	"prose prose-lg max-w-none leading-relaxed prose-headings:font-semibold";

/** The title's typography for a Work of this kind. */
export function workTitleTypography(type: string): {
	className: string;
	style: CSSProperties | undefined;
} {
	return isWriting(type)
		? { className: WRITING_TITLE_CLASS, style: WRITING_TITLE_STYLE }
		: { className: WORK_TITLE_CLASS, style: undefined };
}

/** A music Work's lyrics panel, and its heading, likewise. */
export const WORK_LYRICS_CLASS = "mt-4 rounded-lg bg-base-200/60 p-4";
export const WORK_LYRICS_HEADING_CLASS =
	"mb-2 text-xs font-semibold uppercase tracking-wider text-base-content/50";

/**
 * The creator-asserted Created date, at the precision they actually claimed.
 *
 * Inventing a day the creator never asserted is exactly the false precision the
 * `authoredPrecision` column exists to prevent, so this never widens what was said.
 */
export function formatAuthored(
	iso: string | null | undefined,
	precision: string | null | undefined,
): string | null {
	if (!iso) return null;
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return null;
	switch (precision) {
		case "year":
			return String(d.getUTCFullYear());
		case "month":
			return d.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
		default:
			return d.toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
				timeZone: "UTC",
			});
	}
}

/**
 * Media whose METER the page owns, rather than the component.
 *
 * `VideoPlayer` and `AudioPlayer` each subscribe to the budget and render their own
 * countdown and wall, because they own the playback state the footer needs. Nothing
 * else does — and that now includes the **ebook** reader, which is deliberate rather
 * than an oversight: its pages are fetched one at a time from a metered endpoint, so
 * a spent allowance would otherwise surface as a reader full of broken images, which
 * is the dead-player failure this whole meter design exists to avoid. The page shows
 * the wall instead.
 */
export function pageHoldsTheMeter(type: string): boolean {
	return type !== "video" && !isListened(type);
}

/**
 * The page's column, shared so the Edit page is the width a reader's page is. A piece of writing
 * gets a reading column, narrow enough that a line of its body stays a comfortable length.
 */
export function WorkColumn({ children, type }: { children: ReactNode; type?: string }) {
	const width = type && isWriting(type) ? "max-w-2xl" : "max-w-4xl";
	return <div className={`${width} mx-auto px-4 py-8 space-y-6`}>{children}</div>;
}

interface WorkHeaderProps {
	work: WorkDetail;
	/** In place of the title, for a control standing in for it. */
	title?: ReactNode;
	/** Beside the title. */
	titleAside?: ReactNode;
	/** In place of the line of dates. */
	dates?: ReactNode;
	/** In place of the rating line. */
	rating?: ReactNode;
}

/** The kind, the creator, the title, the dates and the rating, in that order. */
export function WorkHeader({ work, title, titleAside, dates, rating }: WorkHeaderProps) {
	const creatorName = work.creator?.displayName || work.creator?.handle || "this creator";
	return (
		<header className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<ContentTypeBadge contentType={work.type} />
				{work.creator && (
					<Link
						to={profileUrl(work.creator.handle)}
						className="flex items-center gap-2 text-sm hover:underline"
					>
						{work.creator.avatar ? (
							<img
								src={work.creator.avatar}
								alt={work.creator.handle}
								className="w-6 h-6 rounded-full object-cover"
							/>
						) : (
							<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
								{work.creator.handle.charAt(0).toUpperCase()}
							</div>
						)}
						{creatorName}
					</Link>
				)}
			</div>

			<div className="flex flex-wrap items-start justify-between gap-3">
				{title ?? (
					<h1
						className={workTitleTypography(work.type).className}
						style={workTitleTypography(work.type).style}
					>
						{work.title || "Untitled"}
					</h1>
				)}
				{titleAside}
			</div>

			{dates ?? <WorkDates work={work} />}

			{/* The rating and its notes sit above the deliverable, not below it: a warning
			    that only appears once you already have the thing is not a warning. Nothing
			    renders for a General Work, which is nearly all of them. */}
			{rating ?? <WorkRating work={work} />}
		</header>
	);
}

/** Made, then released — never the upload date, which is bookkeeping. */
export function WorkDates({ work }: { work: WorkDetail }) {
	const made = formatAuthored(work.authoredAt, work.authoredPrecision);
	const released = work.releasedAt
		? new Date(work.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;
	return (
		<div className="flex flex-wrap items-center gap-4 text-sm text-base-content/60">
			{made && (
				<span className="flex items-center gap-1">
					<CalendarIcon className="w-4 h-4" />
					Made {made}
				</span>
			)}
			{released && <span>Released {released}</span>}
			{work.type === "text" && work.estimatedReadMinutes && (
				<span className="flex items-center gap-1">
					<ClockIcon className="w-4 h-4" />
					{work.estimatedReadMinutes} min read
				</span>
			)}
		</div>
	);
}

/**
 * The rating and its content notes, for a Mature or Adult Work. Nothing for a General Work,
 * which is nearly all of them. An Adult Work reaches only readers who opted in and verified, and
 * it is labeled for them all the same, because its notes are as much a warning there as anywhere.
 */
export function WorkRating({ work }: { work: WorkDetail }) {
	if (work.maturity !== "mature" && work.maturity !== "adult") return null;
	return (
		<div className="flex flex-wrap items-center gap-2 text-sm">
			<span
				className={`badge badge-sm ${work.maturity === "adult" ? "badge-error" : "badge-warning"}`}
			>
				{work.maturity === "adult" ? "Adult" : "Mature"}
			</span>
			{(work.maturityNotes ?? []).length > 0 && (
				<span className="text-base-content/60">
					{(work.maturityNotes ?? []).map(contentNoteLabel).join(" · ")}
				</span>
			)}
		</div>
	);
}

/**
 * The Work itself, for somebody who may open it: the player, the reader, the image, the
 * embedded build or the gated prose, whichever the kind has.
 */
export function WorkDeliverable({
	work,
	shareToken = null,
	lyrics,
	videoRef,
}: {
	work: WorkDetail;
	shareToken?: string | null;
	/** In place of a music Work's lyrics, for a control standing in for them. */
	lyrics?: ReactNode;
	/** Handed a video's `<video>` element, for the Studio to take a frame from. */
	videoRef?: MutableRefObject<HTMLVideoElement | null>;
}) {
	const { playTracks } = useMediaPlayer();
	return (
		<>
			{work.type === "video" && work.transcoding?.hlsManifestUrl && (
				<VideoPlayer
					src={work.transcoding.hlsManifestUrl}
					poster={work.thumbnail ?? undefined}
					attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
					publicAccess={work.publicAccess ?? false}
					elementRef={videoRef}
				/>
			)}
			{work.type === "music" && work.transcoding?.outputFileUrl && (
				<>
					<AudioPlayer
						src={work.transcoding.outputFileUrl}
						waveform={work.transcoding.waveformData ?? undefined}
						attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
						publicAccess={work.publicAccess ?? false}
						// Hand it to the persistent bar, so listening survives navigating
						// away — which is the whole reason the bar exists.
						onPlayInMiniPlayer={() => playTracks([trackFromWork(work)])}
					/>
					{/* A song's words, under the player. Gated with the audio: the API blanks
					    them for a viewer without access, so reaching this branch at all
					    means the viewer may read them. */}
					{lyrics ??
						(work.lyrics?.trim() && (
							<section className={WORK_LYRICS_CLASS}>
								<h2 className={WORK_LYRICS_HEADING_CLASS}>Lyrics</h2>
								<p className="whitespace-pre-wrap text-sm leading-relaxed text-base-content/85">
									{work.lyrics}
								</p>
							</section>
						))}
				</>
			)}
			{/* Spoken word takes its own player — listening to talk wants fixed-step skips,
			    a rate control and a remembered position, none of which a song does. */}
			{work.type === "audio" && work.transcoding?.outputFileUrl && (
				<SpokenPlayer
					src={work.transcoding.outputFileUrl}
					workId={work.id}
					waveform={work.transcoding.waveformData ?? undefined}
					attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
					publicAccess={work.publicAccess ?? false}
					onPlayInMiniPlayer={() => playTracks([trackFromWork(work)])}
				/>
			)}
			{isPaged(work.type) && (
				<ComicReader
					workId={work.id}
					pageCount={work.pageCount ?? 0}
					apiBase={apiBaseUrl()}
					title={work.title ?? "Untitled"}
					shareToken={shareToken}
				/>
			)}
			{work.type === "image" && work.sourceKey && (
				<img src={work.sourceKey} alt={work.title ?? ""} className="w-full rounded-lg" />
			)}
			{(work.type === "game" || work.type === "software") && work.embedUrl && (
				<ProjectEmbed embedUrl={work.embedUrl} title={work.title ?? "Play"} />
			)}
			{work.bodyHtml &&
				(isWriting(work.type) ? (
					<WorkArticle html={work.bodyHtml} />
				) : (
					<article className="prose max-w-none">
						<SanitizedHtml html={work.bodyHtml} />
					</article>
				))}
			{/*
			 * Reading, playing and looking draw the allowance exactly as watching does,
			 * and until now said nothing about it — the countdown and the wall were
			 * wired into the two players and nowhere else, so a reader nine hours in
			 * got no signal at all and then met a wall at a video.
			 *
			 * 🚨 Rendered here rather than inside each medium's block because there is
			 * no component to hang it on: text is an <article>, a game is an <iframe>,
			 * an image is an <img>. The players own their own footer; everything else
			 * has this one.
			 */}
			{pageHoldsTheMeter(work.type) && <PublicAccessFooter />}
		</>
	);
}

/**
 * The public blurb — visible whether or not the viewer can open the Work, because a locked
 * Work still has to say what it is. The gated prose renders inside the deliverable. For a piece
 * of writing it is the standfirst, which the page sets under the headline rather than here.
 */
export function WorkDescription({ work }: { work: WorkDetail }) {
	if (!work.description) return null;
	if (isWriting(work.type)) {
		return (
			<p className={WRITING_STANDFIRST_CLASS} style={WRITING_BODY_STYLE}>
				{work.description}
			</p>
		);
	}
	return (
		<section className={WORK_DESCRIPTION_CLASS}>
			<p>{work.description}</p>
		</section>
	);
}

/** A piece of writing's body, set for reading. */
export function WorkArticle({ html }: { html: string }) {
	return (
		<article className={WRITING_ARTICLE_CLASS} style={WRITING_BODY_STYLE}>
			<SanitizedHtml html={html} />
		</article>
	);
}
