// SPDX-License-Identifier: Apache-2.0

import { postUrl } from "@anthers/web-shared/postUrl";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { Project, PublicUser } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	BookmarkIcon,
	RocketLaunchIcon,
	RssIcon,
	UserGroupIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import CreatorCard from "../components/cards/CreatorCard";
import FeedTile from "../components/cards/FeedTile";
import ProjectCard from "../components/cards/ProjectCard";
import FeedFilterSections from "../components/layout/FeedFilterSections";
import { useSidebar } from "../components/layout/SidebarContext";

/** One bookmarked post as the sidebar's shelf shows it. */
interface BookmarkedPost {
	id: number;
	post: { title: string | null; slug: string; publicId: number } | null;
}

function FeedSidebarContent({
	access,
	contentType,
	tags,
	onUpdateParams,
}: {
	access: string;
	contentType: string;
	tags: string;
	onUpdateParams: (updates: Record<string, string>) => void;
}) {
	// The bookmarks are the section: a real fetch of the shelf ordered by the user's
	// own sort order, rendered small. (An empty shelf says so and stops.)
	const [bookmarks, setBookmarks] = useState<BookmarkedPost[] | null>(null);

	useEffect(() => {
		client.api.content.bookmarks
			.$get()
			.then(async (res) => {
				if (res.ok) {
					const data = (await res.json()) as unknown as { bookmarks: BookmarkedPost[] };
					setBookmarks(data.bookmarks ?? []);
				} else {
					setBookmarks([]);
				}
			})
			.catch(() => setBookmarks([]));
	}, []);

	return (
		<div className="flex flex-col gap-5">
			{/* Bookmarks — the strip between the nav and the filters, and the only page
			    content in this sidebar that is not a filter. Renders as a smaller list. */}
			<section>
				<h3 className="text-xs font-semibold uppercase tracking-wider text-base-content/40 mb-2 flex items-center gap-1.5">
					<BookmarkIcon className="w-3.5 h-3.5" />
					Bookmarks
				</h3>
				{bookmarks === null ? null : bookmarks.length > 0 ? (
					<ul className="space-y-1">
						{bookmarks.map((b) =>
							b.post ? (
								<li key={b.id}>
									<Link
										to={postUrl({ slug: b.post.slug, publicId: b.post.publicId } as never)}
										className="text-xs text-base-content/60 hover:text-base-content line-clamp-1 block"
									>
										{b.post.title || "Untitled post"}
									</Link>
								</li>
							) : null,
						)}
					</ul>
				) : (
					<p className="text-xs text-base-content/40 italic">
						Nothing bookmarked yet. Bookmark posts to find them here.
					</p>
				)}
			</section>

			{/* The feed's own filters: what the stream binds, in the order the page reads. */}
			<FeedFilterSections
				access={access}
				contentType={contentType}
				tags={tags}
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
	const [showFeedInfo, setShowFeedInfo] = useState(false);

	const contentType = searchParams.get("media_type") ?? "";
	const access = searchParams.get("access") ?? "";
	const tags = searchParams.get("tags") ?? "";

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
				access={access}
				contentType={contentType}
				tags={tags}
				onUpdateParams={updateParams}
			/>,
		);
		return () => setPageContent(null);
	}, [setPageContent, contentType, access, tags, updateParams]);

	useEffect(() => {
		// Fetch the user's feed. Guard on res.ok before reading the body: an error
		// response (e.g. a 401 when the session cookie isn't valid) is `{ error }`,
		// not `{ entries }`, so parsing it blindly would set the feed to `undefined`
		// and crash the render on `.length`. On error we keep the initial [].
		//
		// The sidebar's filters ride the fetch, so it re-runs when they change — the
		// filtered feed is their whole job.
		client.api.accounts.me.feed
			.$get({
				query: {
					...(contentType ? { media_type: contentType } : {}),
					...(access ? { access } : {}),
					...(tags ? { tags } : {}),
				},
			})
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as unknown as { entries: FeedEntry[] };
				setFeedPosts(data.entries ?? []);
			})
			.catch(() => {})
			.finally(() => setFeedLoading(false));
	}, [contentType, access, tags]);

	useEffect(() => {
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

	// Featured projects are their own effect: the sidebar's filters govern the FEED —
	// that is the access and tag machinery's subject — and this section keeps only the
	// type row meaningful, which is the one its endpoint takes natively. Until the
	// store's listing work names an access shape for projects, inventing one here
	// would be a filter over nothing.
	useEffect(() => {
		client.api.content.projects
			.$get({
				query: {
					...(contentType ? { media_type: contentType } : {}),
				},
			})
			.then(async (res) => {
				if (!res.ok) return;
				const data = await res.json();
				setProjects(data.projects.slice(0, 8));
			})
			.catch(() => {});
	}, [contentType]);

	return (
		<div className="min-h-full">
			{/* Feed content */}
			<div className="max-w-6xl mx-auto px-4 py-6">
				{/* The feed's own heading, and the page explanation beside it — moved out of
				    the sidebar, which holds filters; a HOW-does-it-work is a page element. */}
				<div className="flex items-center justify-between mb-4">
					<h2 className="text-lg font-semibold flex items-center gap-2">
						<RssIcon className="w-5 h-5 text-primary" />
						Your Feed
					</h2>
					<button
						type="button"
						className="flex items-center gap-1.5 text-xs text-base-content/40 hover:text-base-content/60 transition-colors"
						onClick={() => setShowFeedInfo(!showFeedInfo)}
					>
						<InformationCircleIcon className="w-3.5 h-3.5" />
						How does the feed work?
					</button>
				</div>
				{showFeedInfo && (
					<div className="bg-base-200 rounded-lg p-3 text-sm relative mb-6">
						<button
							type="button"
							className="btn btn-ghost btn-xs btn-circle absolute top-1 right-1"
							onClick={() => setShowFeedInfo(false)}
						>
							<XMarkIcon className="w-3.5 h-3.5" />
						</button>
						{/* 🚨 This listed three layers — follows, the network's likes and purchases, and
						    followed interests — while only the first has ever run. The other two are the
						    Layered Feed lane and are named here as not built, which is what the FAQ says. */}
						<p className="text-base-content/70 mb-2 text-xs">
							Your feed shows posts and releases from the creators you follow, newest first.
						</p>
						<p className="text-base-content/60 text-xs">
							Things the people you follow recommend, and work matching tags you follow, are planned
							and not built yet — and neither will ever be paid placement.
						</p>
						<p className="text-base-content/40 text-xs mt-2">
							No engagement-optimizing algorithms.{" "}
							<Link to="/faq" className="link link-primary">
								Learn more
							</Link>
						</p>
					</div>
				)}
				{feedLoading ? (
					<div className="flex justify-center py-16">
						<LoadingSpinner size="lg" />
					</div>
				) : feedPosts.length > 0 ? (
					// A uniform grid, still sorted on the one chronological key —
					// the grid is the layout, never a ranking. Columns are wide
					// enough to read at two-across and tighten up as the screen
					// widens, the YouTube home-grid's shape.
					<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4 items-stretch">
						{/* Posts and releases in one stream. A creator who only ever adds to
							    their Catalog still reaches the people who follow them — without
							    that, a post would be the price of being seen, which is exactly
							    the coupling the Catalog/Posts split removes. */}
						{feedPosts.map((entry) => (
							<FeedTile key={`${entry.kind}-${entry.id}`} entry={entry} />
						))}
					</div>
				) : (
					<EmptyState
						icon={<RssIcon className="w-12 h-12" />}
						title="Your feed is empty"
						description={
							contentType || access || tags
								? "No posts or releases match these filters. Clear one and the stream returns; follow more creators and it grows."
								: "Follow creators to see their latest posts and releases here, newest first."
						}
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
					<div className="max-w-6xl mx-auto">
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
					<div className="max-w-6xl mx-auto">
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
