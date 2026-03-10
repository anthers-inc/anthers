import { Link } from "react-router-dom";
import type { Project } from "../../lib/types";
import MediaTypeBadge from "../ui/MediaTypeBadge";
import PricingBadge from "../ui/PricingBadge";
import StarRating from "../ui/StarRating";

export default function ProjectCard({ project }: { project: Project }) {
  return (
    <Link
      to={`/explore/${project.slug}`}
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
          <span className="text-4xl text-base-content/20">
            {project.mediaType === "game" ? "🎮" : project.mediaType === "video" ? "🎬" : project.mediaType === "audio" ? "🎵" : "📝"}
          </span>
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
          <p className="text-sm text-base-content/70 line-clamp-2">
            {project.shortDescription}
          </p>
        )}
        <div className="flex items-center justify-between mt-auto pt-2">
          <div className="flex gap-1">
            <MediaTypeBadge type={project.mediaType} />
            <PricingBadge pricingType={project.pricingType} price={project.price} />
          </div>
          <StarRating
            rating={project.ratingAverage}
            count={project.ratingCount}
            size="sm"
          />
        </div>
      </div>
    </Link>
  );
}
