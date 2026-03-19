import { Link } from "react-router-dom";
import type { Project } from "../../lib/types";
import MediaTypeBadge from "../ui/MediaTypeBadge";
import StarRating from "../ui/StarRating";

export default function ProjectHero({ project }: { project: Project }) {
	return (
		<div>
			{project.coverImage && (
				<div className="w-full h-64 md:h-80 overflow-hidden rounded-lg mb-6">
					<img
						src={project.coverImage}
						alt={project.title}
						className="w-full h-full object-cover"
					/>
				</div>
			)}
			<div className="flex flex-wrap items-start gap-2 mb-2">
				<MediaTypeBadge type={project.mediaType} />
			</div>
			<h1 className="text-3xl font-bold mb-2">{project.title}</h1>
			{project.shortDescription && (
				<p className="text-lg text-base-content/70 mb-3">
					{project.shortDescription}
				</p>
			)}
			<div className="flex items-center gap-4 text-sm">
				<span>
					by{" "}
					<Link
						to={`/${project.creator?.username}`}
						className="link link-hover font-medium"
					>
						{project.creator?.displayName || project.creator?.username}
					</Link>
				</span>
				<StarRating
					rating={project.ratingAverage}
					count={project.ratingCount}
				/>
			</div>
		</div>
	);
}
