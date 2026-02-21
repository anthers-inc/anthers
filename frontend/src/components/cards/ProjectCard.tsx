import { Link } from "react-router-dom";
import type { ProjectListItem } from "../../lib/api";
import MediaTypeBadge from "../ui/MediaTypeBadge";
import PricingBadge from "../ui/PricingBadge";
import StarRating from "../ui/StarRating";

export default function ProjectCard({ project }: { project: ProjectListItem }) {
  return (
    <Link
      to={`/explore/${project.slug}`}
      className="card bg-base-200 shadow-sm hover:shadow-md transition-shadow"
    >
      {project.cover_image ? (
        <figure className="h-40 overflow-hidden">
          <img
            src={project.cover_image}
            alt={project.title}
            className="w-full h-full object-cover"
          />
        </figure>
      ) : (
        <figure className="h-40 bg-base-300 flex items-center justify-center">
          <span className="text-4xl text-base-content/20">
            {project.media_type === "game" ? "🎮" : project.media_type === "video" ? "🎬" : project.media_type === "audio" ? "🎵" : "📝"}
          </span>
        </figure>
      )}
      <div className="card-body p-4 gap-2">
        <h3 className="card-title text-base line-clamp-1">{project.title}</h3>
        <p className="text-xs text-base-content/60">
          by{" "}
          <span className="font-medium text-base-content/80">
            {project.creator}
          </span>
        </p>
        {project.short_description && (
          <p className="text-sm text-base-content/70 line-clamp-2">
            {project.short_description}
          </p>
        )}
        <div className="flex items-center justify-between mt-auto pt-2">
          <div className="flex gap-1">
            <MediaTypeBadge type={project.media_type} />
            <PricingBadge pricingType={project.pricing_type} price={project.price} />
          </div>
          <StarRating
            rating={project.rating_average}
            count={project.rating_count}
            size="sm"
          />
        </div>
      </div>
    </Link>
  );
}
