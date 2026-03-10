import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type { PublicUser, Project, PostListItem } from "../lib/types";
import { useAuth } from "../lib/auth";
import ProjectCard from "../components/cards/ProjectCard";
import ContentCard from "../components/cards/ContentCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import { LinkIcon, MapPinIcon } from "@heroicons/react/24/outline";

const apiBase =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:8000"
    : "";

type Tab = "all" | "games" | "videos" | "audio" | "writing" | "about";

export default function CreatorProfilePage() {
  const { username } = useParams<{ username: string }>();
  const { isAuthenticated, user: currentUser } = useAuth();

  const [creator, setCreator] = useState<PublicUser | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [posts, setPosts] = useState<PostListItem[]>([]);
  const [tab, setTab] = useState<Tab>("all");
  const [loading, setLoading] = useState(true);
  const [isFollowing, setIsFollowing] = useState(false);
  const [followerCount, setFollowerCount] = useState(0);

  const isOwnProfile = currentUser?.username === username;

  useEffect(() => {
    if (!username) return;
    setLoading(true);

    Promise.all([
      client.api.accounts.users[":username"]
        .$get({ param: { username } })
        .then((res) => res.json()),
      fetch(apiBase + "/api/content/projects?creator=" + username, {
        credentials: "include",
      }).then((res) => res.json()),
      fetch(apiBase + "/api/content/posts?creator=" + username, {
        credentials: "include",
      }).then((res) => res.json()),
    ])
      .then(([creatorData, projectData, postData]) => {
        const userData = (creatorData as { user: PublicUser }).user;
        setCreator(userData);
        setIsFollowing(userData.isFollowing);
        setFollowerCount(userData.followerCount);
        setProjects(projectData.projects);
        setPosts(postData.posts);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [username]);

  const handleFollow = async () => {
    if (!isAuthenticated || !username) return;
    try {
      if (isFollowing) {
        await client.api.accounts.users[":username"].unfollow.$post({
          param: { username },
        });
        setIsFollowing(false);
        setFollowerCount((c) => c - 1);
      } else {
        await client.api.accounts.users[":username"].follow.$post({
          param: { username },
        });
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

  // Filter content by tab
  const videoPosts = posts.filter((p) => p.contentType === "video");
  const audioPosts = posts.filter((p) => p.contentType === "audio");
  const textPosts = posts.filter((p) => p.contentType === "text");

  // All tab: interleave projects and posts by date
  const allItems: { type: "project" | "post"; item: Project | PostListItem; date: string }[] = [];
  projects.forEach((p) => allItems.push({ type: "project", item: p, date: p.createdAt }));
  posts.forEach((p) => allItems.push({ type: "post", item: p, date: p.createdAt }));
  allItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return (
    <div>
      {/* Header banner */}
      <div
        className="w-full h-48 md:h-64 bg-base-300"
        style={
          creator.headerImage
            ? {
                backgroundImage: `url(${creator.headerImage})`,
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
              alt={creator.displayName || creator.username}
              className="w-24 h-24 rounded-full object-cover border-4 border-base-100"
            />
          ) : (
            <div className="w-24 h-24 rounded-full bg-base-300 border-4 border-base-100 flex items-center justify-center text-3xl font-bold text-base-content/40">
              {(creator.displayName || creator.username)
                .charAt(0)
                .toUpperCase()}
            </div>
          )}
          <div className="flex-1 pt-4">
            <h1 className="text-2xl font-bold">
              {creator.displayName || creator.username}
            </h1>
            <p className="text-base-content/60">
              @{creator.username} · {followerCount} followers
            </p>
            {creator.bio && (
              <p className="mt-2 text-sm max-w-2xl">{creator.bio}</p>
            )}
            <div className="flex items-center gap-4 mt-2 text-sm text-base-content/60">
              {creator.websiteUrl && (
                <a
                  href={creator.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 link link-hover"
                >
                  <LinkIcon className="w-4 h-4" />
                  {new URL(creator.websiteUrl).hostname}
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
        <div className="tabs tabs-bordered mb-6 overflow-x-auto">
          {([
            ["all", "All"],
            ["games", `Games (${projects.length})`],
            ["videos", `Videos (${videoPosts.length})`],
            ["audio", `Audio (${audioPosts.length})`],
            ["writing", `Writing (${textPosts.length})`],
            ["about", "About"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              className={`tab whitespace-nowrap ${tab === key ? "tab-active" : ""}`}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="pb-8">
          {tab === "all" && (
            allItems.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {allItems.map((entry) =>
                  entry.type === "project" ? (
                    <ProjectCard key={`proj-${entry.item.id}`} project={entry.item as Project} />
                  ) : (
                    <ContentCard key={`post-${entry.item.id}`} post={entry.item as PostListItem} />
                  )
                )}
              </div>
            ) : (
              <EmptyState
                title="No content yet"
                description={`${creator.displayName || creator.username} hasn't published anything yet.`}
              />
            )
          )}

          {tab === "games" && (
            projects.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No games yet"
                description={`${creator.displayName || creator.username} hasn't published any games.`}
              />
            )
          )}

          {tab === "videos" && (
            videoPosts.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {videoPosts.map((post) => (
                  <ContentCard key={post.id} post={post} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No videos yet"
                description={`${creator.displayName || creator.username} hasn't published any videos.`}
              />
            )
          )}

          {tab === "audio" && (
            audioPosts.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {audioPosts.map((post) => (
                  <ContentCard key={post.id} post={post} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No audio yet"
                description={`${creator.displayName || creator.username} hasn't published any audio.`}
              />
            )
          )}

          {tab === "writing" && (
            textPosts.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-7xl">
                {textPosts.map((post) => (
                  <ContentCard key={post.id} post={post} />
                ))}
              </div>
            ) : (
              <EmptyState
                title="No writing yet"
                description={`${creator.displayName || creator.username} hasn't published any articles.`}
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
                {new Date(creator.createdAt).toLocaleDateString("en-US", {
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
