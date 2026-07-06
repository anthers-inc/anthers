// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Project } from "@anthers/web-shared/types";
import { RectangleStackIcon } from "@heroicons/react/24/outline";
import { Link } from "react-router-dom";

/** A collection (project) card — a playlist-like wrapper that groups posts. */
export default function ProjectCard({ project }: { project: Project }) {
	return (
		<Link
			to={`/${project.creator?.username ?? "unknown"}/${project.slug}`}
			className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow"
		>
			{project.coverImage ? (
				<figure className="h-40 overflow-hidden">
					<img
						src={project.coverImage}
						alt={project.title}
						className="w-full h-full object-cover"
					/>
				</figure>
			) : (
				<figure className="h-40 bg-base-300 flex items-center justify-center">
					<RectangleStackIcon className="w-12 h-12 text-base-content/20" />
				</figure>
			)}
			<div className="card-body p-4 gap-2">
				<h3 className="card-title text-base line-clamp-1">{project.title}</h3>
				<p className="text-xs text-base-content/60">
					by{" "}
					<span className="font-medium text-base-content/80">
						{project.creator?.displayName || project.creator?.username}
					</span>
				</p>
				{project.shortDescription && (
					<p className="text-sm text-base-content/70 line-clamp-2">{project.shortDescription}</p>
				)}
				<div className="flex items-center justify-between mt-auto pt-2">
					<span className="badge badge-sm badge-outline gap-1">
						<RectangleStackIcon className="w-3 h-3" />
						Project
					</span>
					{project.postCount !== undefined && (
						<span className="text-xs text-base-content/50">
							{project.postCount} {project.postCount === 1 ? "post" : "posts"}
						</span>
					)}
				</div>
			</div>
		</Link>
	);
}
