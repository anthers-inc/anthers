// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	ArrowDownTrayIcon,
	ChartBarIcon,
	EyeSlashIcon,
	PencilSquareIcon,
	PlusIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { postUrl } from "../lib/postUrl";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import {
	studioEditPostUrl,
	studioEditProjectUrl,
	studioNewPostUrl,
	studioNewProjectUrl,
	studioUrl,
} from "../lib/studio";
import type { CreatorEarnings, PostListItem, Project } from "../lib/types";

export default function DashboardPage() {
	const { user } = useAuth();
	const [projects, setProjects] = useState<Project[]>([]);
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
	const [loading, setLoading] = useState(true);

	// ── Delete / unpublish ──
	const [deleteTarget, setDeleteTarget] = useState<PostListItem | null>(null);
	/** Project pending deletion. Separate from the post flow: the stakes differ (see below). */
	const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
	const [orphanMedia, setOrphanMedia] = useState<
		{ id: number; title: string | null; type: string; thumbnail: string | null }[]
	>([]);
	const [purgeMedia, setPurgeMedia] = useState(false);
	const [actioning, setActioning] = useState(false);

	useEffect(() => {
		Promise.all([
			client.api.content.projects.$get({ query: { mine: "true" } }).then((res) => res.json()),
			client.api.content.posts.$get({ query: { mine: "true" } }).then((res) => res.json()),
		])
			.then(([projData, postData]) => {
				setProjects(projData.projects);
				setPosts(postData.posts);
			})
			.finally(() => setLoading(false));

		// Fetch creator earnings (non-blocking)
		if (user?.isCreator) {
			client.api.subscriptions.earnings
				.$get()
				.then((res) => res.json())
				.then((data) => setEarnings(data as CreatorEarnings))
				.catch(() => {});
		}
	}, [user?.isCreator]);

	const openDelete = async (post: PostListItem) => {
		setDeleteTarget(post);
		setPurgeMedia(false);
		setOrphanMedia([]);
		try {
			const res = await client.api.content.posts[":slug"]["orphaned-media"].$get({
				param: { slug: post.slug },
			});
			if (res.ok) {
				const data = (await res.json()) as {
					items: { id: number; title: string | null; type: string; thumbnail: string | null }[];
				};
				setOrphanMedia(data.items ?? []);
			}
		} catch {
			// Preview is best-effort — delete still works without it.
		}
	};

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$delete({
				param: { slug: deleteTarget.slug },
				query: purgeMedia ? { purgeMedia: "true" } : {},
			});
			if (res.status === 204 || res.ok) {
				setPosts((prev) => prev.filter((p) => p.id !== deleteTarget.id));
				setDeleteTarget(null);
			}
		} finally {
			setActioning(false);
		}
	};

	/**
	 * Delete a Project.
	 *
	 * Deliberately NOT modelled on the post-delete flow above, because the stakes are
	 * different: `project_posts.projectId` cascades, so only the MEMBERSHIP rows go — every
	 * post in the Project survives on the creator's profile. There is no orphaned-media
	 * question here and nothing to purge, so offering a media checkbox would imply a
	 * destructiveness this action doesn't have.
	 */
	const confirmDeleteProject = async () => {
		if (!projectDeleteTarget) return;
		setActioning(true);
		try {
			const res = await client.api.content.projects[":slug"].$delete({
				param: { slug: projectDeleteTarget.slug },
			});
			if (res.status === 204 || res.ok) {
				setProjects((prev) => prev.filter((p) => p.id !== projectDeleteTarget.id));
				setProjectDeleteTarget(null);
			}
		} finally {
			setActioning(false);
		}
	};

	const unpublish = async (post: PostListItem) => {
		setActioning(true);
		try {
			const res = await client.api.content.posts[":slug"].$patch({
				param: { slug: post.slug },
				json: { isPublished: false },
			});
			if (res.ok) {
				setPosts((prev) =>
					prev.map((p) =>
						p.id === post.id ? { ...p, isPublished: false, scheduledFor: null } : p,
					),
				);
			}
		} finally {
			setActioning(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="max-w-7xl mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-bold">Dashboard</h1>
				{user?.isCreator && (
					<div className="flex gap-2">
						<Link to={studioUrl("/import")} className="btn btn-ghost btn-sm">
							<ArrowDownTrayIcon className="w-4 h-4" />
							Import
						</Link>
						<Link to={studioUrl("/analytics")} className="btn btn-ghost btn-sm">
							<ChartBarIcon className="w-4 h-4" />
							Analytics
						</Link>
						<Link to={studioNewProjectUrl()} className="btn btn-primary btn-sm">
							<PlusIcon className="w-4 h-4" />
							New Project
						</Link>
						<Link to={studioNewPostUrl()} className="btn btn-outline btn-sm">
							<PlusIcon className="w-4 h-4" />
							New Post
						</Link>
					</div>
				)}
			</div>

			{/* Stats */}
			<div className="stats shadow bg-base-200 w-full mb-8">
				<div className="stat">
					<div className="stat-title">Projects</div>
					<div className="stat-value text-primary">{projects.length}</div>
				</div>
				<div className="stat">
					<div className="stat-title">Posts</div>
					<div className="stat-value text-secondary">{posts.length}</div>
				</div>
				<div className="stat">
					<div className="stat-title">Published</div>
					<div className="stat-value text-success">
						{projects.filter((p) => p.isPublished).length}
					</div>
				</div>
			</div>

			{/* Creator Earnings */}
			{user?.isCreator && earnings && parseFloat(earnings.total) > 0 && (
				<div className="card bg-base-200 mb-8">
					<div className="card-body">
						<h2 className="card-title text-lg">Subscriber Earnings</h2>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-2">
							<div>
								<div className="text-xs text-base-content/50 uppercase">Pool Income</div>
								<div className="text-xl font-bold text-success">${earnings.poolTotal}</div>
							</div>
							<div>
								<div className="text-xs text-base-content/50 uppercase">Support Income</div>
								<div className="text-xl font-bold text-success">${earnings.seedTotal}</div>
							</div>
							<div>
								<div className="text-xs text-base-content/50 uppercase">Total</div>
								<div className="text-xl font-bold">${earnings.total}</div>
							</div>
							<div>
								<div className="text-xs text-base-content/50 uppercase">Subscribers</div>
								<div className="text-xl font-bold">{earnings.subscriberCount}</div>
							</div>
						</div>
						{earnings.cycle && (
							<p className="text-xs text-base-content/50 mt-2">
								Cycle:{" "}
								{new Date(earnings.cycle).toLocaleDateString("en-US", {
									month: "long",
									year: "numeric",
								})}
							</p>
						)}
					</div>
				</div>
			)}

			{/* Projects */}
			<section className="mb-8">
				<h2 className="text-lg font-semibold mb-4">Your Projects</h2>
				{projects.length > 0 ? (
					<div className="overflow-x-auto">
						<table className="table table-sm">
							<thead>
								<tr>
									<th>Title</th>
									<th>Status</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{projects.map((project) => (
									<tr key={project.id}>
										<td>
											<Link
												to={`/${user?.username}/${project.slug}`}
												className="link link-hover font-medium"
											>
												{project.title}
											</Link>
										</td>
										<td>
											<span
												className={`badge badge-sm ${project.isPublished ? "badge-success" : "badge-warning"}`}
											>
												{project.isPublished ? "Published" : "Draft"}
											</span>
										</td>
										<td className="flex gap-1">
											<Link
												to={studioEditProjectUrl(project.slug)}
												className="btn btn-ghost btn-xs"
												title="Edit"
											>
												<PencilSquareIcon className="w-4 h-4" />
											</Link>
											<button
												type="button"
												className="btn btn-ghost btn-xs text-error"
												title="Delete"
												onClick={() => setProjectDeleteTarget(project)}
											>
												<TrashIcon className="w-4 h-4" />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState
						title="No projects yet"
						description="Create your first project to get started."
						action={
							user?.isCreator ? (
								<Link to={studioNewProjectUrl()} className="btn btn-primary btn-sm">
									Create Project
								</Link>
							) : (
								<p className="text-sm text-base-content/50">
									Enable creator mode in{" "}
									<Link to="/settings" className="link">
										Settings
									</Link>{" "}
									to start publishing.
								</p>
							)
						}
					/>
				)}
			</section>

			{/* Posts */}
			<section>
				<h2 className="text-lg font-semibold mb-4">Your Posts</h2>
				{posts.length > 0 ? (
					<div className="overflow-x-auto">
						<table className="table table-sm">
							<thead>
								<tr>
									<th>Title</th>
									<th>Status</th>
									<th>Date</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{posts.map((post) => (
									<tr key={post.id}>
										<td>
											<Link to={postUrl(post)} className="link link-hover font-medium">
												{post.title || "Untitled"}
											</Link>
										</td>
										<td>
											{post.isPublished ? (
												<span className="badge badge-sm badge-success">Published</span>
											) : post.scheduledFor ? (
												<span
													className="badge badge-sm badge-info"
													title={`Scheduled for ${new Date(post.scheduledFor).toLocaleString()}`}
												>
													Scheduled
												</span>
											) : (
												<span className="badge badge-sm badge-warning">Draft</span>
											)}
										</td>
										<td className="text-sm text-base-content/50">
											{new Date(post.createdAt).toLocaleDateString()}
										</td>
										<td className="flex gap-1">
											<Link
												to={studioEditPostUrl(post.slug)}
												className="btn btn-ghost btn-xs"
												title="Edit"
											>
												<PencilSquareIcon className="w-4 h-4" />
											</Link>
											{post.isPublished && (
												<button
													type="button"
													className="btn btn-ghost btn-xs"
													title="Unpublish"
													onClick={() => unpublish(post)}
													disabled={actioning}
												>
													<EyeSlashIcon className="w-4 h-4" />
												</button>
											)}
											<button
												type="button"
												className="btn btn-ghost btn-xs text-error"
												title="Delete"
												onClick={() => openDelete(post)}
												disabled={actioning}
											>
												<TrashIcon className="w-4 h-4" />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<EmptyState
						title="No posts yet"
						description="Write your first devlog or update."
						action={
							user?.isCreator ? (
								<Link to={studioNewPostUrl()} className="btn btn-primary btn-sm">
									Write a Post
								</Link>
							) : undefined
						}
					/>
				)}
			</section>

			{/* Delete confirmation (with an offer to purge now-orphaned library media). */}
			{deleteTarget && (
				<div className="modal modal-open">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Delete "{deleteTarget.title || "Untitled"}"?</h3>
						<p className="py-3 text-sm text-base-content/70">
							This permanently removes the post along with its comments and reviews. It can't be
							undone.
						</p>
						{orphanMedia.length > 0 && (
							<label className="label cursor-pointer items-start justify-start gap-3 rounded-lg border border-base-300 p-3">
								<input
									type="checkbox"
									className="checkbox checkbox-sm mt-0.5"
									checked={purgeMedia}
									onChange={(e) => setPurgeMedia(e.target.checked)}
								/>
								<span className="label-text">
									Also delete {orphanMedia.length} unused media item
									{orphanMedia.length === 1 ? "" : "s"} from your library
									<span className="block text-xs text-base-content/50">
										{orphanMedia.map((m) => m.title || `Untitled ${m.type}`).join(", ")}
									</span>
									<span className="block text-xs text-base-content/50">
										No other post uses {orphanMedia.length === 1 ? "it" : "them"}. Leave unchecked
										to keep {orphanMedia.length === 1 ? "it" : "them"} in your library.
									</span>
								</span>
							</label>
						)}
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setDeleteTarget(null)}
								disabled={actioning}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDelete}
								disabled={actioning}
							>
								{actioning ? "Deleting..." : "Delete post"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setDeleteTarget(null)}
						aria-label="Close"
					/>
				</div>
			)}

			{/* Delete a project. Says plainly that the posts survive — the whole reason this
				dialog is milder than the post one. */}
			{projectDeleteTarget && (
				<div className="modal modal-open" role="dialog">
					<div className="modal-box">
						<h3 className="text-lg font-bold">
							Delete "{projectDeleteTarget.title || "Untitled"}"?
						</h3>
						<p className="py-3 text-sm text-base-content/70">
							This removes the Project and its ordering. <strong>Posts are not deleted</strong> —
							they stay on your profile and in your library, they just stop being grouped here. It
							can't be undone.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setProjectDeleteTarget(null)}
								disabled={actioning}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDeleteProject}
								disabled={actioning}
							>
								{actioning ? "Deleting..." : "Delete project"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setProjectDeleteTarget(null)}
						aria-label="Close"
					/>
				</div>
			)}
		</div>
	);
}
