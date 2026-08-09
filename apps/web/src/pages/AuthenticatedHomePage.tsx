// SPDX-License-Identifier: AGPL-3.0-or-later

import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PostListItem, Project, PublicUser, Work } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
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
import CreatorCard from "../components/cards/CreatorCard";
import PostCard from "../components/cards/PostCard";
import ProjectCard from "../components/cards/ProjectCard";
import WorkCard from "../components/cards/WorkCard";
import ContentFilterSections from "../components/layout/ContentFilterSections";
import { useSidebar } from "../components/layout/SidebarContext";

function FeedSidebarContent({
	contentType,
	pricing,
	showLocked,
	minPrice,
	maxPrice,
	platform,
	duration,
	tag,
	onUpdateParams,
}: {
	contentType: string;
	pricing: string;
	showLocked: string;
	minPrice: string;
	maxPrice: string;
	platform: string;
	duration: string;
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
				platform={platform}
				duration={duration}
				tag={tag}
				onUpdateParams={onUpdateParams}
			/>
		</div>
	);
}

export default function AuthenticatedHomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent } = useSidebar();
	/** One stream over both kinds — `kind` says which card to render. */
	type FeedEntry = { kind: "post" | "release"; id: number } & Record<string, unknown>;
	const [feedPosts, setFeedPosts] = useState<FeedEntry[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [creators, setCreators] = useState<PublicUser[]>([]);
	const [feedLoading, setFeedLoading] = useState(true);

	const contentType = searchParams.get("media_type") ?? "";
	const pricing = searchParams.get("pricing") ?? "";
	const showLocked = searchParams.get("show_locked") ?? "";
	const minPrice = searchParams.get("min_price") ?? "";
	const maxPrice = searchParams.get("max_price") ?? "";
	const platform = searchParams.get("platform") ?? "";
	const duration = searchParams.get("duration") ?? "";
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
				platform={platform}
				duration={duration}
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
		platform,
		duration,
		tag,
		updateParams,
	]);

	useEffect(() => {
		// Fetch the user's feed. Guard on res.ok before reading the body: an error
		// response (e.g. a 401 when the session cookie isn't valid) is `{ error }`,
		// not `{ entries }`, so parsing it blindly would set the feed to `undefined`
		// and crash the render on `.length`. On error we keep the initial [].
		client.api.accounts.me.feed
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as unknown as { entries: FeedEntry[] };
				setFeedPosts(data.entries ?? []);
			})
			.catch(() => {})
			.finally(() => setFeedLoading(false));

		// Fetch creators for discovery section
		client.api.accounts.creators
			.$get()
			.then(async (res) => {
				if (!res.ok) return;
				const data = await res.json();
				setCreators(data.creators.slice(0, 4));
			})
			.catch(() => {});
	}, []);

	// Featured projects are their own effect because they are the only thing on this page
	// the sidebar's filters touch — the feed above is a chronological follow feed and
	// deliberately takes no filtering, and re-fetching it whenever someone drags a price
	// slider would be work for nothing. Until now this fetch ignored every filter, so the
	// controls moved the URL and changed no pixels.
	useEffect(() => {
		client.api.content.projects
			.$get({
				query: {
					...(contentType ? { media_type: contentType } : {}),
					...(pricing ? { pricing } : {}),
					...(tag ? { tag } : {}),
					...(minPrice ? { min_price: minPrice } : {}),
					...(maxPrice ? { max_price: maxPrice } : {}),
					...(platform ? { platform } : {}),
					...(duration ? { duration } : {}),
					...(showLocked ? { show_locked: showLocked } : {}),
				},
			})
			.then(async (res) => {
				if (!res.ok) return;
				const data = await res.json();
				setProjects(data.projects.slice(0, 8));
			})
			.catch(() => {});
	}, [contentType, pricing, tag, minPrice, maxPrice, platform, duration, showLocked]);

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
						{/* Posts and releases in one stream. A creator who only ever adds to
							    their Catalog still reaches the people who follow them — without
							    that, a post would be the price of being seen, which is exactly
							    the coupling the Catalog/Posts split removes. */}
						{feedPosts.map((entry) =>
							entry.kind === "release" ? (
								<WorkCard key={`work-${entry.id}`} work={entry as unknown as Work} />
							) : (
								<PostCard key={`post-${entry.id}`} post={entry as unknown as PostListItem} />
							),
						)}
					</div>
				) : (
					<EmptyState
						icon={<RssIcon className="w-12 h-12" />}
						title="Your feed is empty"
						description="Follow creators to see their latest posts and releases here. Content from your network -- things your follows like, share, and purchase -- will also appear."
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
