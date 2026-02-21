import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type Project } from "../lib/api";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import ProjectHero from "../components/project/ProjectHero";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectDevlog from "../components/project/ProjectDevlog";
import ProjectComments from "../components/project/ProjectComments";
import ProjectRating from "../components/project/ProjectRating";
import ProjectSidebar from "../components/project/ProjectSidebar";

export default function ProjectPage() {
  const { slug } = useParams<{ slug: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    api
      .get<Project>(`/api/v1/content/projects/${slug}/`)
      .then(setProject)
      .catch(() => setError("Project not found."))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[60vh]">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="container mx-auto px-4 py-16 text-center">
        <h1 className="text-2xl font-bold mb-2">Not Found</h1>
        <p className="text-base-content/60">{error ?? "Project not found."}</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
        {/* Main content */}
        <div className="flex flex-col gap-8">
          <ProjectHero project={project} />

          {/* Screenshots */}
          {project.screenshots.length > 0 && (
            <div>
              <h2 className="text-xl font-bold mb-4">Screenshots</h2>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {project.screenshots.map((ss) => (
                  <img
                    key={ss.id}
                    src={ss.image}
                    alt={ss.caption || "Screenshot"}
                    className="rounded-lg object-cover w-full h-40 cursor-pointer hover:opacity-80 transition-opacity"
                  />
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          {project.description && (
            <div>
              <h2 className="text-xl font-bold mb-4">About</h2>
              <div className="prose prose-sm max-w-none">
                {project.description.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            </div>
          )}

          {/* Downloads */}
          <ProjectDownloads
            assets={project.assets}
            mediaType={project.media_type}
          />

          {/* Devlog */}
          <ProjectDevlog slug={project.slug} />

          {/* Rating */}
          <ProjectRating slug={project.slug} />

          {/* Comments */}
          <ProjectComments slug={project.slug} />
        </div>

        {/* Sidebar */}
        <aside className="order-first lg:order-last">
          <ProjectSidebar project={project} />
        </aside>
      </div>
    </div>
  );
}
