// SPDX-License-Identifier: Apache-2.0
/**
 * The Studio's **Projects** tab: the creator's Projects, and the way to start another one.
 *
 * 🚨 **One object, one place** (Parker, 2026-10-10). This, the Works page, and Posts were one
 * "Catalog" page with a Projects table above a Works grid, and each object now has its own
 * listing, its own New button and its own tab. A Project is the shelf a set of Works sit on —
 * grouping, ordering, nothing else — so a Project's listing is a table of names and states,
 * not a grid: the substance lives on the Works it holds.
 *
 * The wiki's *Projects* carries the model: what joins what, and how finely a body of work
 * splits.
 */

import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { creatorProjectUrl } from "../lib/profile";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioEditProjectUrl, studioNewProjectUrl } from "../lib/studio";
import type { Project } from "../lib/types";

export default function ProjectsPage() {
	const { user } = useAuth();
	const [projects, setProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(true);

	/**
	 * Project pending deletion. Milder than deleting a Work: `project_posts.projectId`
	 * cascades, so only the MEMBERSHIP rows go and every post and Work inside survives on the
	 * creator's profile. There is nothing to purge, so offering a media checkbox here would
	 * imply a destructiveness this action does not have.
	 */
	const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
	const [deletingProject, setDeletingProject] = useState(false);

	useEffect(() => {
		let live = true;
		client.api.content.projects
			.$get({ query: { mine: "true" } })
			.then((res) => res.json())
			.then((data) => {
				if (live) setProjects((data as { projects: Project[] }).projects ?? []);
			})
			.catch(() => {})
			.finally(() => {
				if (live) setLoading(false);
			});
		return () => {
			live = false;
		};
	}, []);

	const confirmDeleteProject = async () => {
		if (!projectDeleteTarget) return;
		setDeletingProject(true);
		try {
			const res = await client.api.content.projects[":slug"].$delete({
				param: { slug: projectDeleteTarget.slug },
			});
			if (res.status === 204 || res.ok) {
				setProjects((prev) => prev.filter((p) => p.id !== projectDeleteTarget.id));
				setProjectDeleteTarget(null);
			}
		} finally {
			setDeletingProject(false);
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
		<div className="max-w-5xl mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-6">
				<h1 className="text-2xl font-bold">Projects</h1>
				<Link to={studioNewProjectUrl()} className="btn btn-primary btn-sm">
					<PlusIcon className="w-4 h-4" /> New Project
				</Link>
			</div>

			{projects.length === 0 ? (
				<EmptyState
					icon={<PlusIcon className="w-12 h-12" />}
					title="No projects yet"
					description="A Project is a shelf that groups related Works and Posts — an album and its tracks, a game and its devlogs, a book and its chapters. It holds no files, prices or gates of its own: everything it shows belongs to the Works inside it. A Works page sits beside this one, and a single can ship there first and join an album here as the album forms."
					action={
						<Link to={studioNewProjectUrl()} className="btn btn-primary btn-sm">
							<PlusIcon className="w-4 h-4" /> New Project
						</Link>
					}
				/>
			) : (
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
											to={creatorProjectUrl(user?.handle ?? "", project.slug)}
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
			)}

			{/* Deleting a Project. Says plainly that its contents survive — the whole reason
			    this dialog is milder than the Work one on the Works page. */}
			{projectDeleteTarget && (
				<div className="modal modal-open" role="dialog">
					<div className="modal-box">
						<h3 className="text-lg font-bold">
							Delete "{projectDeleteTarget.title || "Untitled"}"?
						</h3>
						<p className="py-3 text-sm text-base-content/70">
							This removes the Project and its ordering.{" "}
							<strong>Nothing inside it is deleted</strong> — the Works stay in your Catalog with
							their access, and the posts stay on your profile. They just stop being grouped here.
							It can't be undone.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setProjectDeleteTarget(null)}
								disabled={deletingProject}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDeleteProject}
								disabled={deletingProject}
							>
								{deletingProject ? "Deleting..." : "Delete project"}
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
