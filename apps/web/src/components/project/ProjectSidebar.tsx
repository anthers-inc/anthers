// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowDownTrayIcon, CodeBracketIcon, EyeIcon, LinkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { client } from "../../lib/rpc";
import type { Project, PublicUser } from "../../lib/types";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

export default function ProjectSidebar({ project }: { project: Project }) {
	const { isAuthenticated, user } = useAuth();
	const [creator, setCreator] = useState<PublicUser | null>(null);
	const [moreProjects, setMoreProjects] = useState<Project[]>([]);
	const [isFollowing, setIsFollowing] = useState(false);

	useEffect(() => {
		const username = project.creator?.username;
		if (!username) return;

		client.api.accounts.users[":username"]
			.$get({ param: { username } })
			.then((res) => res.json())
			.then((data) => {
				const u = (data as any).user;
				setCreator(u);
				setIsFollowing(u.isFollowing);
			})
			.catch(console.error);

		fetch(`${apiBase}/api/content/projects?creator=${username}`, {
			credentials: "include",
		})
			.then((res) => res.json())
			.then((data) => {
				setMoreProjects(
					(data.projects as Project[]).filter((p) => p.slug !== project.slug).slice(0, 3),
				);
			})
			.catch(console.error);
	}, [project.creator?.username, project.slug]);

	const handleFollow = async () => {
		if (!isAuthenticated || !creator) return;
		try {
			if (isFollowing) {
				await client.api.accounts.users[":username"].unfollow.$post({
					param: { username: creator.username },
				});
				setIsFollowing(false);
			} else {
				await client.api.accounts.users[":username"].follow.$post({
					param: { username: creator.username },
				});
				setIsFollowing(true);
			}
		} catch (err) {
			console.error("Follow/unfollow failed:", err);
		}
	};

	const isOwnProject = user?.username === project.creator?.username;

	return (
		<div className="flex flex-col gap-6">
			{/* Creator card */}
			{creator && (
				<div className="card bg-base-200">
					<div className="card-body p-4 items-center text-center">
						<Link to={`/${creator.username}`}>
							{creator.avatar ? (
								<img
									src={creator.avatar}
									alt={creator.displayName || creator.username}
									className="w-16 h-16 rounded-full object-cover"
								/>
							) : (
								<div className="w-16 h-16 rounded-full bg-base-300 flex items-center justify-center text-2xl font-bold text-base-content/40">
									{(creator.displayName || creator.username).charAt(0).toUpperCase()}
								</div>
							)}
						</Link>
						<Link to={`/${creator.username}`} className="font-semibold link link-hover">
							{creator.displayName || creator.username}
						</Link>
						<span className="text-xs text-base-content/50">{creator.followerCount} followers</span>
						{isAuthenticated && !isOwnProject && (
							<button
								type="button"
								className={`btn btn-sm w-full ${isFollowing ? "btn-outline" : "btn-primary"}`}
								onClick={handleFollow}
							>
								{isFollowing ? "Following" : "Follow"}
							</button>
						)}
					</div>
				</div>
			)}

			{/* Tags */}
			{Array.isArray(project.tags) && project.tags.length > 0 && (
				<div>
					<h3 className="font-semibold text-sm mb-2">Tags</h3>
					<div className="flex flex-wrap gap-1">
						{project.tags.map((tag) => (
							<Link key={tag} to={`/discover?tag=${tag}`} className="badge badge-outline badge-sm">
								{tag}
							</Link>
						))}
					</div>
				</div>
			)}

			{/* Links */}
			{(project.websiteUrl || project.sourceUrl) && (
				<div>
					<h3 className="font-semibold text-sm mb-2">Links</h3>
					<div className="flex flex-col gap-1">
						{project.websiteUrl && (
							<a
								href={project.websiteUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="link link-hover text-sm flex items-center gap-1"
							>
								<LinkIcon className="w-4 h-4" />
								Website
							</a>
						)}
						{project.sourceUrl && (
							<a
								href={project.sourceUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="link link-hover text-sm flex items-center gap-1"
							>
								<CodeBracketIcon className="w-4 h-4" />
								Source Code
							</a>
						)}
					</div>
				</div>
			)}

			{/* More by creator */}
			{moreProjects.length > 0 && (
				<div>
					<h3 className="font-semibold text-sm mb-2">
						More by {project.creator?.displayName || project.creator?.username}
					</h3>
					<div className="flex flex-col gap-2">
						{moreProjects.map((p) => (
							<Link
								key={p.slug}
								to={`/${project.creator?.username ?? "unknown"}/${p.slug}`}
								className="text-sm link link-hover"
							>
								{p.title}
							</Link>
						))}
					</div>
				</div>
			)}

			{/* Stats */}
			<div className="flex gap-4 text-sm text-base-content/60">
				<span className="flex items-center gap-1">
					<EyeIcon className="w-4 h-4" />
					{project.viewCount.toLocaleString()}
				</span>
				{project.downloadCount > 0 && (
					<span className="flex items-center gap-1">
						<ArrowDownTrayIcon className="w-4 h-4" />
						{project.downloadCount.toLocaleString()}
					</span>
				)}
			</div>

			{/* Published date */}
			<div className="text-xs text-base-content/50">
				Published{" "}
				{new Date(project.createdAt).toLocaleDateString("en-US", {
					month: "long",
					day: "numeric",
					year: "numeric",
				})}
			</div>
		</div>
	);
}
