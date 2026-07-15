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
import { useAttentionTracker } from "@/lib/attention";
import ContentTypeBadge from "../components/ui/ContentTypeBadge";
import { studioUrl } from "../lib/studio";

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

	// Attention tracking—a collection view is a page_view for the creator.
	useAttentionTracker({
		creatorId: project?.creatorId ?? null,
		eventType: "page_view",
		active: !!project,
	});

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
	const isOwner = !!user && user.id === project.creatorId;

	return (
		<div className="container mx-auto px-4 py-8 max-w-5xl">
			{/* Hero */}
			<div className="mb-8">
				{project.coverImage && (
					<div className="w-full h-56 md:h-72 overflow-hidden rounded-lg mb-6">
						<img
							src={project.coverImage}
							alt={project.title}
							className="w-full h-full object-cover"
						/>
					</div>
				)}
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
			</div>

			{/* Member posts */}
			<h2 className="text-xl font-bold mb-4">
				{posts.length} {posts.length === 1 ? "post" : "posts"}
			</h2>
			{posts.length === 0 ? (
				<p className="text-base-content/50 text-sm">This project has no posts yet.</p>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
					{posts.map((member) => {
						const locked = !!member.access && !member.access.canAccess;
						const image = member.thumbnail;
						return (
							<Link
								key={member.id}
								to={postUrl(member)}
								className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
							>
								<div className="aspect-video bg-base-300 relative">
									{image ? (
										<img
											src={image}
											alt={member.title ?? "Post"}
											className="w-full h-full object-cover"
										/>
									) : (
										<div className="w-full h-full flex items-center justify-center text-base-content/20">
											<ContentTypeBadge contentType={member.contentType} />
										</div>
									)}
									{locked && (
										<div className="absolute top-2 right-2 badge badge-neutral gap-1">
											<LockClosedIcon className="w-3 h-3" />
											Locked
										</div>
									)}
								</div>
								<div className="card-body p-4 gap-2">
									<ContentTypeBadge contentType={member.contentType} />
									{member.title && <h3 className="font-semibold line-clamp-2">{member.title}</h3>}
								</div>
							</Link>
						);
					})}
				</div>
			)}
		</div>
	);
}
