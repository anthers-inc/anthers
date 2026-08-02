// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A single **Work** — the public face of one entry in a creator's Catalog.
 *
 * Almost everything on this page used to live on the post page, and moving it here is the
 * whole revamp in one file: the player, the gate, the unlock panel, the download list, the
 * transcode poller and the Time Pool claim are all properties of the *work*, not of an
 * announcement that happens to mention it. A Work reaches this page whether or not a post
 * was ever written about it.
 *
 * Three dates exist and only two are ours to assert. **Created** is what the creator says —
 * rendered at exactly the precision they claimed, so a Work back-dated to "2015" reads
 * "2015" and never "1 January 2015". **Released** is when we made it public. The upload
 * date is bookkeeping and is deliberately not shown.
 */
import { consumptionModeFor, isTimePoolEligible } from "@anthers/shared/attention";
import { useAuth } from "@anthers/web-shared/auth";
import { LockedCover, lockedByBadge } from "@anthers/web-shared/post/unlock";
import { postUrl, workUrl } from "@anthers/web-shared/postUrl";
import { Link, useLocation, useNavigate, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { TranscodingJob, Work } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { CalendarIcon, ClockIcon, MegaphoneIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import AudioPlayer from "../components/media/AudioPlayer";
import TranscodingStatus from "../components/media/TranscodingStatus";
import VideoPlayer from "../components/media/VideoPlayer";
import InlineUnlock from "../components/post/InlineUnlock";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectEmbed from "../components/project/ProjectEmbed";
import ProjectPricing from "../components/project/ProjectPricing";
import ContentTypeBadge from "../components/ui/ContentTypeBadge";
import SanitizedHtml from "../components/ui/SanitizedHtml";
import { useAttentionClaim } from "../lib/attention";

/** A Work as the detail endpoint returns it — with its creator and posting history. */
type WorkDetail = Work & {
	creator?: { username: string; displayName: string | null; avatar: string | null };
	/** Whether the creator can actually take a direct payment (Connect onboarded). */
	creatorHasStripe?: boolean;
	postedIn?: {
		slug: string;
		title: string | null;
		isPublished: boolean;
		postedAt: string | null;
	}[];
};

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

export default function WorkPage() {
	const { slug } = useParams<{ slug: string }>();
	const navigate = useNavigate();
	const location = useLocation();
	const { user, isAuthenticated } = useAuth();

	const [work, setWork] = useState<WorkDetail | null>(null);
	const [loading, setLoading] = useState(true);

	/** Re-read the Work — the access verdict changes under us when a viewer unlocks it. */
	const refetch = useCallback(async () => {
		if (!slug) return;
		const res = await client.api.content.works[":id"].$get({ param: { id: slug } });
		if (!res.ok) {
			setWork(null);
			return;
		}
		const data = (await res.json()) as unknown as { work: WorkDetail };
		setWork(data.work);
	}, [slug]);

	useEffect(() => {
		if (!slug) return;
		setLoading(true);
		refetch()
			.catch(() => setWork(null))
			.finally(() => setLoading(false));
	}, [slug, refetch]);

	// Keep the canonical `/works/{slug}-{publicId}` URL in the bar, so a link shared from a
	// bare id or a stale slug settles on the durable form.
	useEffect(() => {
		if (!work) return;
		const canonical = workUrl(work);
		if (location.pathname !== canonical) navigate(canonical, { replace: true });
	}, [work, location.pathname, navigate]);

	// Poll while the media is still encoding, so the player swaps in without a refresh.
	const jobStatus = work?.transcoding?.status;
	const encoding = jobStatus != null && jobStatus !== "completed" && jobStatus !== "failed";
	useEffect(() => {
		if (!work || !encoding) return;
		const tick = async () => {
			try {
				const res = await client.api.content.works[":id"].transcoding.$get({
					param: { id: String(work.id) },
				});
				if (!res.ok) return;
				const { jobs } = (await res.json()) as unknown as { jobs: TranscodingJob[] };
				const latest = jobs[0];
				if (!latest) return;
				setWork((prev) => (prev ? { ...prev, transcoding: latest } : prev));
			} catch {
				// transient — keep polling
			}
		};
		const interval = setInterval(tick, 2000);
		return () => clearInterval(interval);
	}, [work, encoding]);

	// Time Pool. A Work is what earns, and its own type decides how. Playback-mode media
	// (video/audio) claims from inside its player, gated on real playback; this covers the
	// presence-mode types (text, image, game, software) that are consumed by being there.
	const presence = work ? consumptionModeFor(work.type) === "presence" : false;
	useAttentionClaim({
		creatorId: work?.creatorId ?? null,
		workId: work?.id ?? null,
		contentType: work?.type ?? "",
		active:
			!!work && presence && isTimePoolEligible(work.type) && (work.access?.canAccess ?? false),
	});

	if (loading) return <LoadingSpinner />;
	if (!work) {
		return (
			<div className="text-center py-20">
				<h1 className="text-2xl font-bold mb-2">Not Found</h1>
				<p className="text-base-content/60">This work doesn't exist, or isn't public yet.</p>
			</div>
		);
	}

	const access = work.access;
	const canAccess = access?.canAccess ?? false;
	const isOwner = isAuthenticated && user?.id === work.creatorId;
	const creatorName = work.creator?.displayName || work.creator?.username || "this creator";
	const made = formatAuthored(work.authoredAt, work.authoredPrecision);
	const released = work.releasedAt
		? new Date(work.releasedAt).toLocaleDateString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
			})
		: null;

	return (
		<div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
			{work.visibility === "private" && isOwner && (
				<div className="alert alert-warning">
					<span>
						This Work is still private — only you can see it. Release it from your Catalog when it's
						ready.
					</span>
				</div>
			)}

			<header className="space-y-3">
				<div className="flex flex-wrap items-center gap-3">
					<ContentTypeBadge contentType={work.type} />
					{work.creator && (
						<Link
							to={`/${work.creator.username}`}
							className="flex items-center gap-2 text-sm hover:underline"
						>
							{work.creator.avatar ? (
								<img
									src={work.creator.avatar}
									alt={work.creator.username}
									className="w-6 h-6 rounded-full object-cover"
								/>
							) : (
								<div className="w-6 h-6 rounded-full bg-base-300 flex items-center justify-center text-xs font-bold">
									{work.creator.username.charAt(0).toUpperCase()}
								</div>
							)}
							{creatorName}
						</Link>
					)}
				</div>

				<h1 className="text-3xl font-bold">{work.title || "Untitled"}</h1>

				{/* Made, then released — never the upload date, which is bookkeeping. */}
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
			</header>

			{/* ── The deliverable, or the gate in front of it ── */}
			<section>
				{!canAccess ? (
					<div className="space-y-4">
						<LockedCover
							thumbnail={work.thumbnail}
							className="aspect-video rounded-lg"
							lockedBy={access ? lockedByBadge(access, creatorName) : null}
						/>
						{access &&
							(access.requiresPurchase ? (
								<ProjectPricing
									slug={work.slug ?? ""}
									access={access}
									creatorHasStripe={work.creatorHasStripe ?? false}
									onPurchaseComplete={refetch}
								/>
							) : (
								<InlineUnlock post={work} access={access} onUnlocked={refetch} />
							))}
					</div>
				) : encoding ? (
					<TranscodingStatus
						status={work.transcoding?.status ?? "pending"}
						progress={work.transcoding?.progress ?? 0}
						etaSeconds={work.transcoding?.etaSeconds ?? undefined}
						errorMessage={work.transcoding?.errorMessage ?? undefined}
					/>
				) : (
					<>
						{work.type === "video" && work.transcoding?.hlsManifestUrl && (
							<VideoPlayer
								src={work.transcoding.hlsManifestUrl}
								poster={work.thumbnail ?? undefined}
								attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
							/>
						)}
						{work.type === "audio" && work.transcoding?.outputFileUrl && (
							<AudioPlayer
								src={work.transcoding.outputFileUrl}
								waveform={work.transcoding.waveformData ?? undefined}
								attention={{ creatorId: work.creatorId ?? null, workId: work.id }}
							/>
						)}
						{work.type === "image" && work.sourceKey && (
							<img src={work.sourceKey} alt={work.title ?? ""} className="w-full rounded-lg" />
						)}
						{(work.type === "game" || work.type === "software") && work.embedUrl && (
							<ProjectEmbed embedUrl={work.embedUrl} title={work.title ?? "Play"} />
						)}
						{work.bodyHtml && (
							<article className="prose max-w-none">
								<SanitizedHtml html={work.bodyHtml} />
							</article>
						)}
					</>
				)}
			</section>

			{/* The public blurb — visible whether or not the viewer can open the Work, because a
			    locked Work still has to say what it is. The gated prose renders above, inside
			    the deliverable. */}
			{work.description && (
				<section className="prose max-w-none text-base-content/80">
					<p>{work.description}</p>
				</section>
			)}

			{work.assets.length > 0 && (
				<ProjectDownloads
					assets={work.assets}
					contentType={work.type}
					workId={work.id}
					canAccess={canAccess}
				/>
			)}

			{/* Where this Work has been announced — the other half of an inert reference. */}
			{work.postedIn && work.postedIn.length > 0 && (
				<section className="border-t border-base-300 pt-6">
					<h2 className="flex items-center gap-2 text-lg font-semibold mb-3">
						<MegaphoneIcon className="w-5 h-5" />
						Posted about
					</h2>
					<ul className="space-y-2">
						{work.postedIn
							.filter((p) => p.isPublished)
							.map((p) => (
								<li key={p.slug}>
									<Link
										to={postUrl({ slug: p.slug, publicId: 0 })}
										className="link link-hover text-sm"
									>
										{p.title || p.slug}
									</Link>
									{p.postedAt && (
										<span className="text-xs text-base-content/40 ml-2">
											{new Date(p.postedAt).toLocaleDateString("en-US", {
												month: "short",
												day: "numeric",
												year: "numeric",
											})}
										</span>
									)}
								</li>
							))}
					</ul>
				</section>
			)}
		</div>
	);
}
