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
 * The listing is a **table of tall rows** (Parker, 2026-10-11), the Works table's treatment
 * with room for a different row: the project's header image and its title down the left,
 * the description as its own column beside the title (2026-10-16), and a grid of the works
 * it holds on the right — a project described by what it contains. The rows sort by header
 * and filter from the left sidebar below the Studio nav, the Works page's mechanism; the
 * filters and the sort are `projects-list.ts`'s, extracted so a suite can fail on them. The
 * works in the grid come from the owner listing's batched `worksSummary`; a Work's tile
 * opens its Edit page, the place a creator acts on it.
 *
 * The wiki's *Projects* carries the model: what joins what, and how finely a body of work
 * splits.
 */

import { PencilSquareIcon, PlusIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import ProjectsFilterSections from "../components/content/projects-filters";
import {
	arrangeProjects,
	DEFAULT_PROJECTS_SORT,
	type ProjectsSortKey,
} from "../components/content/projects-list";
import SortableHeader, { ariaSort } from "../components/content/SortableHeader";
import { TypeIcon } from "../components/content/works";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { creatorProjectUrl } from "../lib/profile";
import { Link, useSearchParams } from "../lib/router";
import { client } from "../lib/rpc";
import { useSidebar } from "../lib/sidebar";
import { studioEditWorkUrl, studioNewProjectUrl } from "../lib/studio";
import type { Project, ProjectWorkSummary } from "../lib/types";

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

	// The filters and the sort ride the URL, the Works page's pattern.
	const [searchParams, setSearchParams] = useSearchParams();
	const q = searchParams.get("q") ?? "";
	const status = searchParams.get("status") ?? "";
	const contentType = searchParams.get("type") ?? "";
	const [sort, setSort] = useState<{ key: ProjectsSortKey; dir: "asc" | "desc" }>(
		DEFAULT_PROJECTS_SORT,
	);

	const updateParams = useCallback(
		(updates: Record<string, string>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					for (const [key, value] of Object.entries(updates)) {
						if (value) {
							next.set(key, value);
						} else {
							next.delete(key);
						}
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	// Repeat click on a sorted column flips it; a new column starts names A→Z, dates high first.
	const onSort = (key: ProjectsSortKey) =>
		setSort((prev) =>
			prev.key === key
				? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { key, dir: key === "title" ? "asc" : "desc" },
		);

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

	// The sidebar's filter sections, below the Studio nav — registered here, the Feed
	// page's mechanism by way of the Works page. The sections read the URL.
	const { setPageContent } = useSidebar();
	const filters = useMemo(() => ({ q, status, type: contentType }), [q, status, contentType]);
	useEffect(() => {
		setPageContent(
			<ProjectsFilterSections
				items={projects}
				q={filters.q}
				status={filters.status}
				contentType={filters.type}
				onUpdateParams={updateParams}
			/>,
		);
		return () => setPageContent(null);
	}, [setPageContent, projects, filters, updateParams]);

	const rows = arrangeProjects(projects, filters, sort.key, sort.dir);

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="w-full px-6 py-6">
			<div className="flex items-center justify-between mb-4">
				<h2 className="text-lg font-semibold">Projects</h2>
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
			) : rows.length === 0 ? (
				/* Every Project is filtered out — distinguishable from an empty list, and
				   its remedy is a click, not a new shelf. */
				<div className="text-sm text-base-content/60">
					<p className="mb-2">No Projects match these filters.</p>
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={() => updateParams({ q: "", status: "", type: "" })}
					>
						Clear filters
					</button>
				</div>
			) : (
				<div className="overflow-x-auto">
					<table className="table w-full">
						<thead>
							<tr className="border-base-300/50 text-xs text-base-content/50">
								<th scope="col" aria-sort={ariaSort(sort, "title")}>
									<SortableHeader label="Project" sortKey="title" sort={sort} onSort={onSort} />
								</th>
								<th scope="col" className="min-w-[14rem]">
									Description
								</th>
								<th scope="col">Works</th>
								<th scope="col">Status</th>
								<th scope="col" aria-sort={ariaSort(sort, "date")}>
									<SortableHeader label="Date" sortKey="date" sort={sort} onSort={onSort} />
								</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((project) => (
								<ProjectRow
									key={project.id}
									project={project}
									handle={user?.handle ?? ""}
									onDelete={setProjectDeleteTarget}
								/>
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

/**
 * One Project as a tall row: the header image and the title on the left, the description as
 * its own column beside the title, the works it holds as a thumbnail grid on the right
 * (Parker's sketch, 2026-10-11; the description column, 2026-10-16).
 */
function ProjectRow({
	project,
	handle,
	onDelete,
}: {
	project: Project;
	handle: string;
	onDelete: (project: Project) => void;
}) {
	const works = project.worksSummary ?? [];
	const publicIfPublished = project.isPublished !== false;
	// The Project's page IS its editor now (the unified-editor pass, 2026-10-17), for
	// published and draft rows alike — the owner's page; the server answers a draft's
	// URL 404 for anyone but its creator, as a private Work's does.
	const projectUrl = creatorProjectUrl(handle, project.slug);

	return (
		<tr className="border-b border-base-300/50 hover:bg-base-200/40 align-top">
			{/* PROJECT — the header image above the name, the row's left zone.
			    The image carries the same link the title does, the Works table's pattern, and sits
			    out of the accessibility tree because the title already names the same place. */}
			<td className="py-3 pr-4">
				<div className="w-64">
					<Link
						to={projectUrl}
						tabIndex={-1}
						aria-hidden="true"
						className="block w-full aspect-[2/1] rounded"
					>
						{project.coverImage ? (
							<img
								src={project.coverImage}
								alt=""
								className="w-full h-full aspect-[2/1] object-cover rounded"
							/>
						) : (
							<div className="w-full h-full rounded bg-base-300/50 flex items-center justify-center">
								<TypeIcon type="image" className="w-8 h-8 text-base-content/30" />
							</div>
						)}
					</Link>
					<p className="font-medium text-sm mt-2" title={project.title ?? undefined}>
						<Link to={projectUrl} className="link link-hover">
							{project.title || "Untitled"}
						</Link>
					</p>
				</div>
			</td>

			{/* DESCRIPTION — its own column beside the title (Parker, 2026-10-16), the Works
			    table's same treatment; the tall row leaves the room beside the header image. */}
			<td className="py-3 pr-4">
				<p className="text-xs text-base-content/60 line-clamp-3 break-words max-w-lg">
					{project.description || "No description"}
				</p>
			</td>

			{/* WORKS — the row's right zone: the shelf's contents as a grid of thumbnails,
			    each opening the Work's Edit page. Six show; a bigger shelf says by how much. */}
			<td className="py-3 pr-4">
				<WorksGrid works={works} />
			</td>

			{/* Status — a project publishes as a whole, or it is still a draft. */}
			<td className="py-3 pr-4">
				<span className={`badge badge-sm ${publicIfPublished ? "badge-success" : "badge-warning"}`}>
					{publicIfPublished ? "Published" : "Draft"}
				</span>
			</td>

			<td className="py-3 pr-4 whitespace-nowrap text-sm text-base-content/70">
				{new Date(project.createdAt).toLocaleString(undefined, { dateStyle: "medium" })}
			</td>

			{/* Row actions: the editor, and the delete dialog the page owns. */}
			<td className="py-3 pr-4 text-right whitespace-nowrap">
				<div className="flex justify-end gap-1">
					<Link to={projectUrl} className="btn btn-ghost btn-xs" title="Edit">
						<PencilSquareIcon className="w-4 h-4" />
					</Link>
					<button
						type="button"
						className="btn btn-ghost btn-xs text-error"
						title="Delete"
						onClick={() => onDelete(project)}
					>
						<TrashIcon className="w-4 h-4" />
					</button>
				</div>
			</td>
		</tr>
	);
}

/** Up to PROJECT_ROW_WORK_LIMIT tiles, then a quiet count of the rest. */
const PROJECT_ROW_WORK_LIMIT = 6;

function WorksGrid({ works }: { works: ProjectWorkSummary[] }) {
	const shown = works.slice(0, PROJECT_ROW_WORK_LIMIT);
	if (shown.length === 0) {
		return <p className="text-xs text-base-content/40">No Works in this Project yet.</p>;
	}
	return (
		<div className="flex flex-wrap gap-2 max-w-lg">
			{shown.map((work) => (
				<Link
					key={work.id}
					to={studioEditWorkUrl(work.publicId ?? work.id)}
					className="block w-28 aspect-video rounded bg-base-200 overflow-hidden"
					title={work.title || "Untitled"}
				>
					{work.thumbnail ? (
						<img src={work.thumbnail} alt="" className="w-full h-full object-cover" />
					) : (
						<span className="w-full h-full flex items-center justify-center">
							<TypeIcon type={work.type} className="w-6 h-6 text-base-content/30" />
						</span>
					)}
				</Link>
			))}
			{works.length > shown.length && (
				<p className="text-xs text-base-content/40 self-center">
					+{works.length - shown.length} more
				</p>
			)}
		</div>
	);
}
