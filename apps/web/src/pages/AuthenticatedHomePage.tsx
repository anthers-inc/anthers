import {
	BellIcon,
	BookmarkIcon,
	InformationCircleIcon,
	RocketLaunchIcon,
	RssIcon,
	UserGroupIcon,
	XMarkIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import ContentCard from "../components/cards/ContentCard";
import CreatorCard from "../components/cards/CreatorCard";
import ProjectCard from "../components/cards/ProjectCard";
import ContentFilterSections from "../components/layout/ContentFilterSections";
import { useSidebar } from "../components/layout/SidebarContext";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { client } from "../lib/rpc";
import type { PostListItem, Project, PublicUser } from "../lib/types";

function FeedSidebarContent({
	contentType,
	pricing,
	showLocked,
	minPrice,
	maxPrice,
	onSale,
	tag,
	onUpdateParams,
}: {
	contentType: string;
	pricing: string;
	showLocked: string;
	minPrice: string;
	maxPrice: string;
	onSale: string;
	tag: string;
	onUpdateParams: (updates: Record<string, string>) => void;
}) {
	const [showFeedInfo, setShowFeedInfo] = useState(false);

	return (
		<div className="flex flex-col gap-6">
			{/* Feed info toggle */}
			<section>
				<button
					type="button"
					className="flex items-center gap-1.5 text-xs text-base-content/40 hover:text-base-content/60 transition-colors"
					onClick={() => setShowFeedInfo(!showFeedInfo)}
				>
					<InformationCircleIcon className="w-3.5 h-3.5" />
					How does the feed work?
				</button>
				{showFeedInfo && (
					<div className="bg-base-200 rounded-lg p-3 text-sm mt-2 relative">
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-circle absolute top-1 right-1"
							onClick={() => setShowFeedInfo(false)}
						>
							<XMarkIcon className="w-3.5 h-3.5" />
						</button>
						<p className="text-base-content/70 mb-2 text-xs">
							Your feed shows content in three layers, blended by recency:
						</p>
						<ul className="text-base-content/60 space-y-1 text-xs">
							<li>
								<strong className="text-base-content/80">Primary:</strong> Posts from creators you
								follow
							</li>
							<li>
								<strong className="text-base-content/80">Network:</strong> Things your follows
								liked, shared, or purchased
							</li>
							<li>
								<strong className="text-base-content/80">Ambient:</strong> Content matching your
								interests -- never paid promotion
							</li>
						</ul>
						<p className="text-base-content/40 text-xs mt-2">
							No engagement-optimizing algorithms.{" "}
							<Link to="/faq" className="link link-primary">
								Learn more
							</Link>
						</p>
					</div>
				)}
			</section>

			{/* Bookmarks / Favorites */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
					<BookmarkIcon className="w-3.5 h-3.5" />
					Bookmarks
				</h3>
				<ul className="menu menu-sm p-0 gap-0.5">
					<li>
						<span className="text-base-content/40 text-xs italic">No bookmarks yet</span>
					</li>
				</ul>
				<p className="text-xs text-base-content/30 mt-1">
					Bookmark posts, projects, and creators to find them here.
				</p>
			</section>

			{/* Following / Subscriptions */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
					<UserGroupIcon className="w-3.5 h-3.5" />
					Following
				</h3>
				<ul className="menu menu-sm p-0 gap-0.5">
					<li>
						<span className="text-base-content/40 text-xs italic">Not following anyone yet</span>
					</li>
				</ul>
				<Link to="/discover" className="text-xs link link-primary mt-1 block">
					Discover creators
				</Link>
			</section>

			{/* New Releases */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
					<BellIcon className="w-3.5 h-3.5" />
					New Releases
				</h3>
				<ul className="menu menu-sm p-0 gap-0.5">
					<li>
						<span className="text-base-content/40 text-xs italic">Nothing new right now</span>
					</li>
				</ul>
				<p className="text-xs text-base-content/30 mt-1">
					New content from creators you follow shows up here.
				</p>
			</section>

			<div className="divider my-0" />

			{/* Shared filter sections */}
			<ContentFilterSections
				contentType={contentType}
				pricing={pricing}
				showLocked={showLocked}
				minPrice={minPrice}
				maxPrice={maxPrice}
				onSale={onSale}
				tag={tag}
				onUpdateParams={onUpdateParams}
			/>
		</div>
	);
}

export default function AuthenticatedHomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent } = useSidebar();
	const [feedPosts, setFeedPosts] = useState<PostListItem[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [creators, setCreators] = useState<PublicUser[]>([]);
	const [feedLoading, setFeedLoading] = useState(true);

	const contentType = searchParams.get("media_type") ?? "";
	const pricing = searchParams.get("pricing") ?? "";
	const showLocked = searchParams.get("show_locked") ?? "";
	const minPrice = searchParams.get("min_price") ?? "";
	const maxPrice = searchParams.get("max_price") ?? "";
	const onSale = searchParams.get("on_sale") ?? "";
	const tag = searchParams.get("tag") ?? "";

	const updateParams = useCallback(
		(updates: Record<string, string>) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					for (const [key, value] of Object.entries(updates)) {
						if (value) {
							next.set(key, value);
						} else {
							next.delete(key);
						}
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	// Register page-specific sidebar content
	useEffect(() => {
		setPageContent(
			<FeedSidebarContent
				contentType={contentType}
				pricing={pricing}
				showLocked={showLocked}
				minPrice={minPrice}
				maxPrice={maxPrice}
				onSale={onSale}
				tag={tag}
				onUpdateParams={updateParams}
			/>,
		);
		return () => setPageContent(null);
	}, [
		setPageContent,
		contentType,
		pricing,
		showLocked,
		minPrice,
		maxPrice,
		onSale,
		tag,
		updateParams,
	]);

	useEffect(() => {
		// Fetch the user's feed
		client.api.accounts.me.feed
			.$get()
			.then((res) => res.json())
			.then((data) => setFeedPosts((data as { posts: PostListItem[] }).posts))
			.catch(() => {})
			.finally(() => setFeedLoading(false));

		// Fetch featured projects for discovery section
		client.api.content.projects
			.$get()
			.then((res) => res.json())
			.then((data) => setProjects(data.projects.slice(0, 8)))
			.catch(() => {});

		// Fetch creators for discovery section
		client.api.accounts.creators
			.$get()
			.then((res) => res.json())
			.then((data) => setCreators(data.creators.slice(0, 4)))
			.catch(() => {});
	}, []);

	return (
		<div className="min-h-full">
			{/* Feed content */}
			<div className="max-w-4xl mx-auto px-4 py-6">
				{feedLoading ? (
					<div className="flex justify-center py-16">
						<LoadingSpinner size="lg" />
					</div>
				) : feedPosts.length > 0 ? (
					<div className="flex flex-col gap-4">
						{feedPosts.map((post) => (
							<ContentCard key={post.id} post={post} />
						))}
					</div>
				) : (
					<EmptyState
						icon={<RssIcon className="w-12 h-12" />}
						title="Your feed is empty"
						description="Follow creators to see their latest posts here. Content from your network -- things your follows like, share, and purchase -- will also appear."
						action={
							<Link to="/discover" className="btn btn-primary btn-sm">
								Discover creators
							</Link>
						}
					/>
				)}
			</div>

			{/* Discovery sections (below the feed) */}
			{projects.length > 0 && (
				<section className="py-8 px-4 bg-base-200/30 border-t border-base-300/30">
					<div className="max-w-4xl mx-auto">
						<div className="flex items-center justify-between mb-4">
							<h2 className="text-lg font-semibold flex items-center gap-2">
								<RocketLaunchIcon className="w-5 h-5 text-primary" />
								Discover Projects
							</h2>
							<Link to="/discover" className="btn btn-ghost btn-sm">
								View all
							</Link>
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
							{projects.map((p) => (
								<ProjectCard key={p.id} project={p} />
							))}
						</div>
					</div>
				</section>
			)}

			{creators.length > 0 && (
				<section className="py-8 px-4">
					<div className="max-w-4xl mx-auto">
						<div className="flex items-center justify-between mb-4">
							<h2 className="text-lg font-semibold flex items-center gap-2">
								<UserGroupIcon className="w-5 h-5 text-secondary" />
								Creators to Follow
							</h2>
							<Link to="/discover" className="btn btn-ghost btn-sm">
								View all
							</Link>
						</div>
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
							{creators.map((c) => (
								<CreatorCard key={c.id} creator={c} />
							))}
						</div>
					</div>
				</section>
			)}
		</div>
	);
}
