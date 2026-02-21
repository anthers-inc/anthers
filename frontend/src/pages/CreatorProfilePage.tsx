import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  type PublicUser,
  type PaginatedResponse,
  type ProjectListItem,
  type Post,
} from "../lib/api";
import { useAuth } from "../lib/auth";
import ProjectCard from "../components/cards/ProjectCard";
import PostCard from "../components/cards/PostCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import { LinkIcon, MapPinIcon } from "@heroicons/react/24/outline";

type Tab = "projects" | "posts" | "about";

export default function CreatorProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { isAuthenticated, user: currentUser } = useAuth();

  const [creator, setCreator] = useState<PublicUser | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [tab, setTab] = useState<Tab>("projects");
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);

  const isOwnProfile = currentUser?.username === username;

  useEffect(() => {
    if (!username) return;
    setLoading(true);

    Promise.all([
      api.get<PublicUser>(`/api/v1/accounts/users/${username}/`),
      api.get<PaginatedResponse<ProjectListItem>>(
        `/api/v1/content/projects/?creator=${username}`
      ),
      api.get<PaginatedResponse<Post>>(
        `/api/v1/content/posts/?creator=${username}`
      ),
    ])
      .then(([creatorData, projectData, postData]) => {
        setCreator(creatorData);
        setIsFollowing(creatorData.is_following);
        setFollowerCount(creatorData.follower_count);
        setProjects(projectData.results);
        setPosts(postData.results);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [username]);

  const handleFollow = async () => {
    if (!isAuthenticated || !username) return;
    try {
      if (isFollowing) {
        await api.post(`/api/v1/accounts/users/${username}/unfollow/`);
        setIsFollowing(false);
        setFollowerCount((c) => c - 1);
      } else {
        await api.post(`/api/v1/accounts/users/${username}/follow/`);
        setIsFollowing(true);
        setFollowerCount((c) => c + 1);
      }
    } catch (err) {
      console.error("Follow/unfollow failed:", err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!creator) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-2">Not Found</h1>
        <p className="text-base-content/60">This user doesn't exist.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Header banner */}
      <div
        className="w-full h-48 md:h-64 bg-base-300"
        style={
          creator.header_image
            ? {
                backgroundImage: `url(${creator.header_image})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }
            : undefined
        }
      />

      <div className="container mx-auto px-4">
        {/* Profile info */}
        <div className="flex flex-col sm:flex-row items-start gap-4 -mt-12 mb-6">
          {creator.avatar ? (
            <img
              src={creator.avatar}
              alt={creator.display_name || creator.username}
              className="w-24 h-24 rounded-full object-cover border-4 border-base-100"
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-base-300 border-4 border-base-100 flex items-center justify-center text-3xl font-bold text-base-content/40">
              {(creator.display_name || creator.username)
                .charAt(0)
                .toUpperCase()}
            </div>
          )}
          <div className="flex-1 pt-4">
            <h1 className="text-2xl font-bold">
              {creator.display_name || creator.username}
            </h1>
            <p className="text-base-content/60">
              @{creator.username} · {followerCount} followers
            </p>
            {creator.bio && (
              <p className="mt-2 text-sm max-w-2xl">{creator.bio}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-sm text-base-content/60">
              {creator.website_url && (
                <a
                  href={creator.website_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 link link-hover"
                >
                  <LinkIcon className="w-4 h-4" />
                  {new URL(creator.website_url).hostname}
                </a>
              )}
              {creator.location && (
                <span className="flex items-center gap-1">
                  <MapPinIcon className="w-4 h-4" />
                  {creator.location}
                </span>
              )}
            </div>
          </div>
          {isAuthenticated && !isOwnProfile && (
            <button
              className={`btn mt-4 sm:mt-12 ${isFollowing ? "btn-outline" : "btn-primary"}`}
              onClick={handleFollow}
            >
              {isFollowing ? "Following" : "Follow"}
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="tabs tabs-bordered mb-6">
          <button
            className={`tab ${tab === "projects" ? "tab-active" : ""}`}
            onClick={() => setTab("projects")}
          >
            Projects ({projects.length})
          </button>
          <button
            className={`tab ${tab === "posts" ? "tab-active" : ""}`}
            onClick={() => setTab("posts")}
          >
            Posts ({posts.length})
          </button>
          <button
            className={`tab ${tab === "about" ? "tab-active" : ""}`}
            onClick={() => setTab("about")}
          >
            About
          </button>
        </div>

        {/* Tab content */}
        <div className="pb-8">
          {tab === "projects" && (
            projects.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No projects yet"
                description={`${creator.display_name || creator.username} hasn't published any projects.`}
              />
            )
          )}

          {tab === "posts" && (
            posts.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-4xl">
                {posts.map((post) => (
                  <PostCard key={post.id} post={post} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No posts yet"
                description={`${creator.display_name || creator.username} hasn't published any posts.`}
              />
            )
          )}

          {tab === "about" && (
            <div className="max-w-2xl">
              {creator.bio ? (
                <div className="prose prose-sm">
                  {creator.bio.split("\n").map((line, i) => (
                    <p key={i}>{line}</p>
                  ))}
                </div>
              ) : (
                <EmptyState title="No bio yet" />
              )}
              <div className="mt-6 text-sm text-base-content/50">
                Member since{" "}
                {new Date(creator.date_joined).toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
