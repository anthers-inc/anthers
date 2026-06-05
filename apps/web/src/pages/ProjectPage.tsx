import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import { useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { useAttentionTracker } from "@/lib/attention";
import { useAuth } from "@/lib/auth";
import { client } from "@/lib/rpc";
import type { Project } from "@/lib/types";
import ProjectComments from "../components/project/ProjectComments";
import ProjectDevlog from "../components/project/ProjectDevlog";
import ProjectDownloads from "../components/project/ProjectDownloads";
import ProjectEmbed from "../components/project/ProjectEmbed";
import ProjectHero from "../components/project/ProjectHero";
import ProjectPricing from "../components/project/ProjectPricing";
import ProjectRating from "../components/project/ProjectRating";
import ProjectScreenshots from "../components/project/ProjectScreenshots";
import ProjectSidebar from "../components/project/ProjectSidebar";
import LoadingSpinner from "../components/ui/LoadingSpinner";

export default function ProjectPage() {
	const { slug } = useParams<{ slug: string }>();
	const { isAuthenticated } = useAuth();
	const [project, setProject] = useState<Project | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [userOwns, setUserOwns] = useState<boolean | null>(null);

	useEffect(() => {
		if (!slug) return;
		setLoading(true);
		client.api.content.projects[":slug"]
			.$get({ param: { slug } })
			.then((res) => res.json())
			.then((data) => setProject((data as { project: Project }).project))
			.catch(() => setError("Project not found."))
			.finally(() => setLoading(false));
	}, [slug]);

	// Check ownership for authenticated users
	useEffect(() => {
		if (!slug || !isAuthenticated) {
			setUserOwns(null);
			return;
		}
		client.api.payments.owns[":slug"]
			.$get({ param: { slug } })
			.then(async (res) => {
				if (!res.ok) {
					setUserOwns(null);
					return;
				}
				const data = await res.json();
				setUserOwns((data as { owns: boolean }).owns);
			})
			.catch(() => setUserOwns(null));
	}, [slug, isAuthenticated]);

	// Attention tracking—games use "play", other project types use "page_view"
	const eventType = project?.mediaType === "game" ? "play" : "page_view";

	useAttentionTracker({
		creatorId: project?.creatorId ?? null,
		projectId: project?.id ?? null,
		eventType,
		active: !!project,
	});

	const handlePurchaseComplete = useCallback(() => {
		setUserOwns(true);
	}, []);

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

					{/* Embed */}
					{project.embedUrl && <ProjectEmbed embedUrl={project.embedUrl} title={project.title} />}

					{/* Screenshots */}
					<ProjectScreenshots screenshots={project.screenshots ?? []} />

					{/* Description */}
					{project.description && (
						<div>
							<h2 className="text-xl font-bold mb-4">About</h2>
							<div className="prose prose-sm max-w-none">
								<Markdown remarkPlugins={[remarkGfm]}>{project.description}</Markdown>
							</div>
						</div>
					)}

					{/* Pricing */}
					<ProjectPricing
						pricingType={project.pricingType as "free" | "pwyw" | "paid"}
						price={project.price}
						slug={project.slug}
						creatorHasStripe={false}
						userOwns={userOwns}
						onPurchaseComplete={handlePurchaseComplete}
					/>

					{/* Downloads */}
					<ProjectDownloads
						assets={project.assets ?? []}
						mediaType={project.mediaType}
						pricingType={project.pricingType as "free" | "pwyw" | "paid"}
						userOwns={userOwns}
						projectSlug={project.slug}
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
