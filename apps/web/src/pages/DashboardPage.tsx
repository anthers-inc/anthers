import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { client } from "../lib/rpc";
import type { Project, Post, CreatorEarnings } from "../lib/types";
import { useAuth } from "../lib/auth";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import MediaTypeBadge from "../components/ui/MediaTypeBadge";
import PricingBadge from "../components/ui/PricingBadge";
import {
  PlusIcon,
  PencilSquareIcon,
  WrenchScrewdriverIcon,
  ChartBarIcon,
  ArrowDownTrayIcon,
} from "@heroicons/react/24/outline";

const apiBase =
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1"
    ? "http://localhost:8000"
    : "";

export default function DashboardPage() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [earnings, setEarnings] = useState<CreatorEarnings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(apiBase + "/api/content/projects?mine=true", {
        credentials: "include",
      }).then((res) => res.json()),
      fetch(apiBase + "/api/content/posts?mine=true", {
        credentials: "include",
      }).then((res) => res.json()),
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
            <Link
              to="/dashboard/import"
              className="btn btn-ghost btn-sm"
            >
              <ArrowDownTrayIcon className="w-4 h-4" />
              Import
            </Link>
            <Link
              to="/dashboard/analytics"
              className="btn btn-ghost btn-sm"
            >
              <ChartBarIcon className="w-4 h-4" />
              Analytics
            </Link>
            <Link
              to="/dashboard/projects/new"
              className="btn btn-primary btn-sm"
            >
              <PlusIcon className="w-4 h-4" />
              New Project
            </Link>
            <Link to="/dashboard/posts/new" className="btn btn-outline btn-sm">
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
                <div className="text-xs text-base-content/50 uppercase">
                  Pool Income
                </div>
                <div className="text-xl font-bold text-success">
                  ${earnings.poolTotal}
                </div>
              </div>
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Boost Income
                </div>
                <div className="text-xl font-bold text-success">
                  ${earnings.boostTotal}
                </div>
              </div>
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Total
                </div>
                <div className="text-xl font-bold">
                  ${earnings.total}
                </div>
              </div>
              <div>
                <div className="text-xs text-base-content/50 uppercase">
                  Subscribers
                </div>
                <div className="text-xl font-bold">
                  {earnings.subscriberCount}
                </div>
              </div>
            </div>
            {earnings.cycle && (
              <p className="text-xs text-base-content/50 mt-2">
                Cycle: {new Date(earnings.cycle).toLocaleDateString("en-US", { month: "long", year: "numeric" })}
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
                  <th>Type</th>
                  <th>Pricing</th>
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
                      <MediaTypeBadge type={project.mediaType} />
                    </td>
                    <td>
                      <PricingBadge
                        pricingType={project.pricingType}
                        price={project.price}
                      />
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
                        to={`/dashboard/projects/${project.slug}/edit`}
                        className="btn btn-ghost btn-xs"
                        title="Edit"
                      >
                        <PencilSquareIcon className="w-4 h-4" />
                      </Link>
                      <Link
                        to={`/dashboard/projects/${project.slug}/builds`}
                        className="btn btn-ghost btn-xs"
                        title="Builds"
                      >
                        <WrenchScrewdriverIcon className="w-4 h-4" />
                      </Link>
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
                <Link
                  to="/dashboard/projects/new"
                  className="btn btn-primary btn-sm"
                >
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
                  <th>Project</th>
                  <th>Status</th>
                  <th>Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => (
                  <tr key={post.id}>
                    <td>
                      <Link
                        to={`/${user?.username}/posts/${post.id}`}
                        className="link link-hover font-medium"
                      >
                        {post.title || "Untitled"}
                      </Link>
                    </td>
                    <td>
                      {post.projectId ? (
                        <span className="badge badge-sm badge-outline">
                          Project
                        </span>
                      ) : (
                        <span className="text-base-content/30">—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`badge badge-sm ${post.isPublished ? "badge-success" : "badge-warning"}`}
                      >
                        {post.isPublished ? "Published" : "Draft"}
                      </span>
                    </td>
                    <td className="text-sm text-base-content/50">
                      {new Date(post.createdAt).toLocaleDateString()}
                    </td>
                    <td>
                      <Link
                        to={`/dashboard/posts/${post.id}/edit`}
                        className="btn btn-ghost btn-xs"
                        title="Edit"
                      >
                        <PencilSquareIcon className="w-4 h-4" />
                      </Link>
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
                <Link
                  to="/dashboard/posts/new"
                  className="btn btn-primary btn-sm"
                >
                  Write a Post
                </Link>
              ) : undefined
            }
          />
        )}
      </section>
    </div>
  );
}
