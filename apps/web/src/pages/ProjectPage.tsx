// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { postUrl } from "@anthers/web-shared/postUrl";
import { Link, useParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Project } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { LockClosedIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useReportVisit } from "@/lib/attention";
import WorkCard from "../components/cards/WorkCard";
import SaveButton from "../components/library/SaveButton";
import AlbumView from "../components/media/AlbumView";
import ContentTypeBadge from "../components/ui/ContentTypeBadge";
import { studioUrl } from "../lib/studio";
import { isAlbum, tracksFrom } from "../lib/tracks";

export default function ProjectPage() {
	const { slug } = useParams<{ slug: string }>();
	const { user } = useAuth();
	const [project, setProject] = useState<Project | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!slug) return;
		setLoading(true);
		client.api.content.projects[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) {
					setError("Project not found.");
					return;
				}
				const data = await res.json();
				setProject(data.project as Project);
			})
			.catch(() => setError("Project not found."))
			.finally(() => setLoading(false));
	}, [slug]);

	// Attention tracking — a Project view is a page_view for the creator.
	// A Project is a shelf holding no work of its own, so browsing one records the visit
	// and earns no Time Pool minutes. The time is earned on the **Works**, which is where
	// consumption actually happens. (This said "on the posts" until Works could appear
	// here at all; only a Work has ever been able to earn — see 40.05.)
	useReportVisit({ creatorId: project?.creatorId ?? null });

	if (loading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	if (error || !project) {
		return (
			<div className="container mx-auto px-4 py-16 text-center">
				<h1 className="text-2xl font-bold mb-2">Not Found</h1>
				<p className="text-base-content/60">{error ?? "Project not found."}</p>
			</div>
		);
	}

	const posts = project.posts ?? [];
	const works = project.works ?? [];
	const isOwner = !!user && user.id === project.creatorId;
	/*
	 * A Project of nothing but audio is a record, and `AlbumView` becomes its hero: cover,
	 * title, creator, Play. So the page's own title block stands down rather than printing
	 * the same three lines directly above it — two identical headings stacked is what the
	 * first cut looked like, and it read as a bug.
	 */
	const asAlbum = isAlbum(works);

	return (
		<div className="container mx-auto px-4 py-8 max-w-5xl">
			{/* Hero — stood down for an album, which brings its own. */}
			<div className={asAlbum ? "mb-4 flex justify-end" : "mb-8"}>
				{!asAlbum && project.coverImage && (
					<div className="w-full h-56 md:h-72 overflow-hidden rounded-lg mb-6">
						<img
							src={project.coverImage}
							alt={project.title}
							className="w-full h-full object-cover"
						/>
					</div>
				)}
				{asAlbum ? (
					isOwner && (
						<a
							href={studioUrl(`/projects/${project.slug}/edit`)}
							className="btn btn-outline btn-sm shrink-0"
						>
							<PencilSquareIcon className="w-4 h-4" />
							Edit
						</a>
					)
				) : (
					<>
						<div className="flex items-start justify-between gap-4 mb-2">
							<h1 className="text-3xl font-bold">{project.title}</h1>
							{isOwner && (
								<a
									href={studioUrl(`/projects/${project.slug}/edit`)}
									className="btn btn-outline btn-sm shrink-0"
								>
									<PencilSquareIcon className="w-4 h-4" />
									Edit
								</a>
							)}
						</div>
						{project.creator && (
							<p className="text-sm text-base-content/70 mb-3">
								by{" "}
								<Link to={`/${project.creator.username}`} className="link link-hover font-medium">
									{project.creator.displayName || project.creator.username}
								</Link>
							</p>
						)}
						{(project.description || project.shortDescription) && (
							<div className="prose prose-sm max-w-none">
								<Markdown remarkPlugins={[remarkGfm]}>
									{project.description || project.shortDescription || ""}
								</Markdown>
							</div>
						)}
					</>
				)}
			</div>

			{/*
			 * Member Works, first — they are the substance of the Project, and posts are
			 * announcements about them.
			 *
			 * A Project whose members are ALL audio is a record, and gets rendered as one:
			 * cover, Play, Shuffle, tracks in `sortOrder`. That column exists precisely
			 * because "an album could not hold its tracks", and a grid of cards throws the
			 * order away at the moment it matters most. Anything else keeps the grid —
			 * a game Project holding a soundtrack is not an album, and turning it into a
			 * track list would bury the game.
			 *
			 * Either way each member resolves its own access: `WorkCard` shows a gated
			 * member's blurred cover and unlock route, and `AlbumView` shows a gated track
			 * as a padlocked row that leads to the same place.
			 */}
			{works.length > 0 &&
				(asAlbum ? (
					<div className="mb-10 space-y-4">
						<AlbumView
							title={project.title}
							cover={project.coverImage || works.find((w) => w.thumbnail)?.thumbnail || null}
							creator={
								project.creator && (
									<Link
										to={`/${project.creator.username}`}
										className="hover:text-primary hover:underline"
									>
										{project.creator.displayName || project.creator.username}
									</Link>
								)
							}
							tracks={tracksFrom(works, {
								id: project.creatorId,
								username: project.creator?.username,
								displayName: project.creator?.displayName,
							})}
							// People keep albums, not four loose tracks — so the record itself is
							// savable, and saving it keeps the record rather than scattering it.
							action={<SaveButton projectId={project.id} />}
						/>
						{/* The sleeve notes, under the record rather than above it. */}
						{(project.description || project.shortDescription) && (
							<div className="prose prose-sm max-w-none px-1">
								<Markdown remarkPlugins={[remarkGfm]}>
									{project.description || project.shortDescription || ""}
								</Markdown>
							</div>
						)}
					</div>
				) : (
					<div className="mb-10">
						<h2 className="text-xl font-bold mb-4">
							{works.length} {works.length === 1 ? "work" : "works"}
						</h2>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
							{works.map((work) => (
								<WorkCard key={work.id} work={{ ...work, creator: project.creator }} />
							))}
						</div>
					</div>
				))}

			{/* Member posts */}
			{(posts.length > 0 || works.length === 0) && (
				<>
					<h2 className="text-xl font-bold mb-4">
						{posts.length} {posts.length === 1 ? "post" : "posts"}
					</h2>
					{posts.length === 0 ? (
						<p className="text-base-content/50 text-sm">
							{works.length === 0 ? "This Project is empty." : "No posts about this Project yet."}
						</p>
					) : (
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
							{posts.map((member) => {
								// A member post carries no gate and no cover — it is an announcement.
								// The Works it links resolve on their own, at the post itself.
								return (
									<Link
										key={member.id}
										to={postUrl(member)}
										className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
									>
										<div className="card-body p-4 gap-2">
											{member.title && (
												<h3 className="font-semibold line-clamp-2">{member.title}</h3>
											)}
											{member.publishedAt && (
												<span className="text-xs text-base-content/40">
													{new Date(member.publishedAt).toLocaleDateString("en-US", {
														month: "short",
														day: "numeric",
														year: "numeric",
													})}
												</span>
											)}
										</div>
									</Link>
								);
							})}
						</div>
					)}
				</>
			)}
		</div>
	);
}
