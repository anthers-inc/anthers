// SPDX-License-Identifier: Apache-2.0

import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { InformationCircleIcon, RssIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import FeedTile from "../components/cards/FeedTile";
import NetworkMembershipSection from "../components/layout/NetworkMembershipSection";
import SharedFilterSections from "../components/layout/SharedFilterSections";
import SharedLensesSection from "../components/layout/SharedLensesSection";
import TabHeader from "../components/layout/TabHeader";

export default function AuthenticatedHomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent, setSharedContent } = useSidebar();
	/** One stream over both kinds — `kind` says which card to render. */
	type FeedEntry = { kind: "post" | "release"; id: number } & Record<string, unknown>;
	const [feedPosts, setFeedPosts] = useState<FeedEntry[]>([]);
	const [feedLoading, setFeedLoading] = useState(true);
	const [showFeedInfo, setShowFeedInfo] = useState(false);

	/**
	 * The shared Type selection, which on the feed rides `media_type` — with "posts"
	 * (a kind of feed entry, not a Work type) carried inside it and translated to the
	 * feed route's `kind=posts` query below. `access` and `tags` are the shared
	 * filters' other two params, read the same way.
	 */
	const contentType = searchParams.get("media_type") ?? "";
	const access = searchParams.get("access") ?? "";
	const tags = searchParams.get("tags") ?? "";
	/** `""` is the whole network; the rest narrow to one route in. */
	const networkSource = searchParams.get("network_source") ?? "";

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

	// Register the sidebar's pieces (the house structure, 2026-10-11): the Network's
	// own membership filter — the one control that belongs to this tab — above the
	// tab-shared LENSES, and the shared filters with the Access control below the
	// divider. The membership filter narrows the stream to the part of the network the
	// reader means, and the shared filters narrow what that stream draws.
	useEffect(() => {
		setPageContent(
			<div className="flex flex-col gap-5">
				<NetworkMembershipSection
					value={networkSource}
					onValue={(value) => updateParams({ network_source: value })}
				/>
				<SharedLensesSection lens="" onLens={() => {}} />
			</div>,
		);
		setSharedContent(
			<SharedFilterSections
				type={contentType}
				onType={(id) => updateParams({ media_type: id })}
				access={{ value: access, onAccess: (value) => updateParams({ access: value }) }}
				tags={tags}
				onTags={(value) => updateParams({ tags: value })}
			/>,
		);
		return () => {
			setPageContent(null);
			setSharedContent(null);
		};
	}, [setPageContent, setSharedContent, contentType, access, tags, networkSource, updateParams]);

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
					// "posts" is not a Work type; it is the feed's kind filter over its other
					// half of entries. A Work type narrows the work side and leaves posts
					// in place (a post survives a type filter through what it announces).
					...(contentType === "posts"
						? { kind: "posts" }
						: contentType
							? { media_type: contentType }
							: {}),
					...(access ? { access } : {}),
					...(tags ? { tags } : {}),
					...(networkSource ? { network_source: networkSource } : {}),
				},
			})
			.then(async (res) => {
				if (!res.ok) return;
				const data = (await res.json()) as unknown as { entries: FeedEntry[] };
				setFeedPosts(data.entries ?? []);
			})
			.catch(() => {})
			.finally(() => setFeedLoading(false));
	}, [contentType, access, tags, networkSource]);

	return (
		<div className="min-h-full">
			{/* Feed content. The grid fills the content area — the wide-tile shelf's
			    whole point is using the width the layout already gives it. */}
			<div className="w-full px-6 py-6">
				{/* The tab's one shared header (Parker, 2026-10-19): icon, title, and the
				    paragraph that says what the stream is made of. The how-it-works
				    affordance rides the header's right edge. */}
				<TabHeader
					icon={RssIcon}
					title="Network"
					subtitle="The latest Works and Posts from all of the creators you follow, creators you're subscribed to, and creators who have made works or posts that you've saved or purchased. A pure chronological feed with no hidden algorithm."
					actions={
						<button
							type="button"
							className="flex items-center gap-1.5 text-xs text-base-content/40 hover:text-base-content/60 transition-colors"
							onClick={() => setShowFeedInfo(!showFeedInfo)}
						>
							<InformationCircleIcon className="w-3.5 h-3.5" />
							How does the feed work?
						</button>
					}
				/>
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
							Your feed shows your own posts and releases alongside the posts and releases of the
							creators you follow, newest first.
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
					// the grid is the layout, never a ranking. Columns keep a workable
					// minimum width and count themselves: the row flexes to fewer, larger
					// tiles as the window narrows and to more of them as it widens — the
					// YouTube home-grid's shape (`auto-fill` decides; nothing is fixed).
					<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
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
						title={
							networkSource ? "Nothing from this part of your network yet" : "Your feed is empty"
						}
						description={
							contentType || access || tags || networkSource
								? "No posts or releases match this view. Clear a filter, or follow, support, or save a creator and the stream grows."
								: "Follow creators to see their latest posts and releases here, newest first."
						}
						action={
							<Link to="/discovery" className="btn btn-primary btn-sm">
								Explore Discovery
							</Link>
						}
					/>
				)}
			</div>
		</div>
	);
}
