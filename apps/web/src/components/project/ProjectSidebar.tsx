import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  type Project,
  type PublicUser,
  type PaginatedResponse,
  type ProjectListItem,
} from "../../lib/api";
import { useAuth } from "../../lib/auth";
import {
  LinkIcon,
  CodeBracketIcon,
  EyeIcon,
  ArrowDownTrayIcon,
} from "@heroicons/react/24/outline";

export default function ProjectSidebar({ project }: { project: Project }) {
  const { isAuthenticated, user } = useAuth();
  const [creator, setCreator] = useState<PublicUser | null>(null);
  const [moreProjects, setMoreProjects] = useState<ProjectListItem[]>([]);
  const [isFollowing, setIsFollowing] = useState(false);

  useEffect(() => {
    api
      .get<PublicUser>(
        `/api/v1/accounts/users/${project.creator_username}/`
      )
      .then((data) => {
        setCreator(data);
        setIsFollowing(data.is_following);
      })
      .catch(console.error);

    api
      .get<PaginatedResponse<ProjectListItem>>(
        `/api/v1/content/projects/?creator=${project.creator_username}`
      )
      .then((data) => {
        setMoreProjects(
          data.results.filter((p) => p.slug !== project.slug).slice(0, 3)
        );
      })
      .catch(console.error);
  }, [project.creator_username, project.slug]);

  const handleFollow = async () => {
    if (!isAuthenticated || !creator) return;
    try {
      if (isFollowing) {
        await api.post(
          `/api/v1/accounts/users/${creator.username}/unfollow/`
        );
        setIsFollowing(false);
      } else {
        await api.post(
          `/api/v1/accounts/users/${creator.username}/follow/`
        );
        setIsFollowing(true);
      }
    } catch (err) {
      console.error("Follow/unfollow failed:", err);
    }
  };

  const isOwnProject = user?.username === project.creator_username;

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
                  alt={creator.display_name || creator.username}
                  className="w-16 h-16 rounded-full object-cover"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-base-300 flex items-center justify-center text-2xl font-bold text-base-content/40">
                  {(creator.display_name || creator.username)
                    .charAt(0)
                    .toUpperCase()}
                </div>
              )}
            </Link>
            <Link
              to={`/${creator.username}`}
              className="font-semibold link link-hover"
            >
              {creator.display_name || creator.username}
            </Link>
            <span className="text-xs text-base-content/50">
              {creator.follower_count} followers
            </span>
            {isAuthenticated && !isOwnProject && (
              <button
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
      {project.tags.length > 0 && (
        <div>
          <h3 className="font-semibold text-sm mb-2">Tags</h3>
          <div className="flex flex-wrap gap-1">
            {project.tags.map((tag) => (
              <Link
                key={tag}
                to={`/explore?tag=${tag}`}
                className="badge badge-outline badge-sm"
              >
                {tag}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Links */}
      {(project.website_url || project.source_url) && (
        <div>
          <h3 className="font-semibold text-sm mb-2">Links</h3>
          <div className="flex flex-col gap-1">
            {project.website_url && (
              <a
                href={project.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="link link-hover text-sm flex items-center gap-1"
              >
                <LinkIcon className="w-4 h-4" />
                Website
              </a>
            )}
            {project.source_url && (
              <a
                href={project.source_url}
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
            More by {project.creator}
          </h3>
          <div className="flex flex-col gap-2">
            {moreProjects.map((p) => (
              <Link
                key={p.slug}
                to={`/explore/${p.slug}`}
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
          {project.view_count.toLocaleString()}
        </span>
        {project.download_count > 0 && (
          <span className="flex items-center gap-1">
            <ArrowDownTrayIcon className="w-4 h-4" />
            {project.download_count.toLocaleString()}
          </span>
        )}
      </div>

      {/* Published date */}
      <div className="text-xs text-base-content/50">
        Published{" "}
        {new Date(project.created_at).toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
        })}
      </div>
    </div>
  );
}
