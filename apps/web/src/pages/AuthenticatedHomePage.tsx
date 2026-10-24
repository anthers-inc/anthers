// SPDX-License-Identifier: Apache-2.0

import { BOOKSHELF_WORK_TYPES } from "@anthers/shared/content";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { InformationCircleIcon, RssIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useMemo, useState } from "react";
import FeedTile from "../components/cards/FeedTile";
import NetworkMembershipSection from "../components/layout/NetworkMembershipSection";
import SharedFilterSections, {
	SHARED_FILTER_TYPES,
} from "../components/layout/SharedFilterSections";
import SharedLensesSection, { ALL_LENS_IDS } from "../components/layout/SharedLensesSection";
import { useFilterable, useViewFilter } from "../components/layout/search/filter-context";
import TabHeader from "../components/layout/TabHeader";
import BookshelfLens from "../components/library/BookshelfLens";
import ChannelGuideLens, {
	channelGuideChannelsFromShelf,
} from "../components/library/ChannelGuideLens";
import MusicDial from "../components/library/MusicDial";
import MusicLens from "../components/library/MusicLens";
import { feedLensItems } from "../lib/feed-lenses";

/*
 * The LENSES the Network carries (Parker, 2026-10-23): all three, over the feed. The
 * Music Player and Bookshelf read the feed the way the Library's read the shelf, and the
 * Channel Guide draws the feed's videos as creator channels — its player gets its
 * address from `feedLensItems`, which composes the delivery endpoint the feed omits.
 * The set is the shared all-lenses constant so no tab can fall behind the list.
 */

export default function AuthenticatedHomePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const { setPageContent, setSharedContent } = useSidebar();
	const viewFilter = useViewFilter();
	useFilterable("Network");
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
	/** The lens is a second organizing metaphor over the feed, never a filter. */
	const lens = searchParams.get("lens") ?? "";
	const includeSpoken = searchParams.get("spoken") === "1";

	/** The lens's corpus: the feed's releases, translated once per fetch. */
	const lensDraw = useMemo(() => feedLensItems(feedPosts), [feedPosts]);

	/**
	 * The Work types the active lens draws on, or null with No Lens. The Type rows outside
	 * this set gray out while it is active — the Library's rule, applied to the feed.
	 */
	const lensIncluded = useMemo<string[] | null>(() => {
		if (lens === "music") return includeSpoken ? ["music", "audio"] : ["music"];
		if (lens === "channel-guide") return ["video"];
		if (lens === "bookshelf") return [...BOOKSHELF_WORK_TYPES];
		return null;
	}, [lens, includeSpoken]);

	const unavailableTypes = useMemo(() => {
		if (!lensIncluded) return undefined;
		const set = new Set<string>();
		for (const t of SHARED_FILTER_TYPES) {
			if (t.id && !lensIncluded.includes(t.id)) set.add(t.id);
		}
		return set;
	}, [lensIncluded]);

	/**
	 * The Type selection rides the request as the feed's server-side condition — except
	 * under a lens, where the lens decides what it draws on and the rows outside it are
	 * grayed. Dropping it here is what keeps a lens a view of the corpus rather than a
	 * filter applied before the corpus arrives.
	 */
	const mediaType = lens ? "" : contentType;

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
	//
	// Under a lens the Type rows the lens does not draw gray out, exactly as the
	// Library's do: a lens decides what it draws on, so the Type section cannot narrow
	// the corpus first. The selection stays in the URL and returns with No Lens.
	useEffect(() => {
		setPageContent(
			<div className="flex flex-col gap-5">
				<NetworkMembershipSection
					value={networkSource}
					onValue={(value) => updateParams({ network_source: value })}
				/>
				<SharedLensesSection
					lens={lens}
					onLens={(id) => updateParams({ lens: id })}
					live={ALL_LENS_IDS}
					extras={{
						music: (
							<MusicDial
								includeSpoken={includeSpoken}
								onIncludeSpoken={(on) => updateParams({ spoken: on ? "1" : "" })}
							/>
						),
					}}
				/>
			</div>,
		);
		setSharedContent(
			<SharedFilterSections
				type={contentType}
				onType={(id) => updateParams({ media_type: id })}
				unavailableTypes={unavailableTypes}
				access={{ value: access, onAccess: (value) => updateParams({ access: value }) }}
				tags={tags}
				onTags={(value) => updateParams({ tags: value })}
			/>,
		);
		return () => {
			setPageContent(null);
			setSharedContent(null);
		};
	}, [
		setPageContent,
		setSharedContent,
		contentType,
		access,
		tags,
		networkSource,
		lens,
		includeSpoken,
		unavailableTypes,
		updateParams,
	]);

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
					...(mediaType === "posts"
						? { kind: "posts" }
						: mediaType
							? { media_type: mediaType }
							: {}),
					...(access ? { access } : {}),
					...(tags ? { tags } : {}),
					// Filter mode's term. The feed paginates, so this is a server condition
					// rather than a filter over the page already loaded.
					...(viewFilter.query ? { q: viewFilter.query } : {}),
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
	}, [mediaType, access, tags, viewFilter.query, networkSource]);

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
					subtitle="Works and Posts from all of the creators you follow, you're subscribed to, or have made content you've saved or purchased."
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
				) : lens === "music" ? (
					/* A lens reorganizes the feed, never refetches it: the corpus is the same
					   stream the grid draws. `scope="feed"` opens a release whole, because the
					   feed is what arrived rather than a kept list of tracks. */
					<MusicLens items={lensDraw} includeSpoken={includeSpoken} scope="feed" />
				) : lens === "bookshelf" ? (
					/* The same shelf metaphor over the feed's written Works: spines instead of
					   tiles, alphabetical by title. */
					<BookshelfLens items={lensDraw} source="network" />
				) : lens === "channel-guide" ? (
					/* The feed's videos as creator channels, latest at the top of each column.
					   A feed entry ships no payload, so the guide's inline player reads the
					   delivery address `feedLensItems` composes for it. */
					<ChannelGuideLens channels={channelGuideChannelsFromShelf(lensDraw)} source="feed" />
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
