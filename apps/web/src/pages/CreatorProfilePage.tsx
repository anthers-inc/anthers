// SPDX-License-Identifier: Apache-2.0

import { ANTHERS_BADGES, amountLabel, supportAmount } from "@anthers/shared/constants";
import { isListened } from "@anthers/shared/content";
import { withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { usePageTitle } from "@anthers/web-shared/page-title";
import BadgeMaker from "@anthers/web-shared/post/BadgeMaker";
import { displayHandle, handleFromParam } from "@anthers/web-shared/profile";
import {
	INTERACTION_PERMISSION_HINT,
	useInteractionPermissionMissing,
} from "@anthers/web-shared/publishing";
import {
	Link,
	useLocation,
	useNavigate,
	useParams,
	useSearchParams,
} from "@anthers/web-shared/router";
import { apiFetch, client } from "@anthers/web-shared/rpc";
import type {
	Badge,
	Creator,
	CreatorBadge,
	CreatorStatus,
	PostListItem,
	Project,
	PublicUser,
	Work,
} from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import Modal from "@anthers/web-shared/ui/Modal";
import {
	BoltIcon,
	CalendarDaysIcon,
	CheckCircleIcon,
	EllipsisHorizontalIcon,
	LinkIcon,
	LockClosedIcon,
	MapPinIcon,
	NoSymbolIcon,
	PencilSquareIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import FeedTile from "../components/cards/FeedTile";
import ProjectCard from "../components/cards/ProjectCard";
import ReportDialog from "../components/ui/ReportDialog";
import { InlineField } from "../components/work/Editing";
import { useReportVisit } from "../lib/attention";
import { useBasket } from "../lib/basket";

/** A Work as the public Catalog listing returns it. */
type CatalogWork = Work & {
	creator?: { handle: string; displayName?: string | null; avatar?: string | null };
};

/**
 * The FeedTile entry a catalog Work renders — the `kind` tag naming which tile
 * shape the rest of the Work rides. The catalog's user serialization carries
 * everything the tile reads (thumbnail, the access verdict, merch, the rating),
 * so the spread is the whole entry.
 */
function workEntry(work: CatalogWork): { kind: "release"; id: number } & Record<string, unknown> {
	return { kind: "release", ...work };
}

/** The FeedTile entry a listed post renders — same shape rule as a work's. */
function postEntry(post: PostListItem): { kind: "post"; id: number } & Record<string, unknown> {
	return { kind: "post", ...post };
}

type Tab = "all" | "posts" | "games" | "videos" | "audio" | "writing" | "badges";

function badgeNameFor(id: string): string {
	if (id === "none" || id === "free" || !id) return "Free";
	return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The host a saved website link shows, or the stored value when it will not parse. */
function hostLabel(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/* ------------------------------------------------------------------ */
/*  Support this creator                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Badges tab                                                          */
/* ------------------------------------------------------------------ */

/**
 * The Badge purchase ladder — the rungs a buyer picks from, and the two actions a pick
 * offers: add it to the basket, or buy it now — which is the same add plus the trip to
 * the one checkout ("Buy Now never skips the basket's checkout flow", the Work page's
 * own rule, applied to Badges).
 *
 * 🚨 **One ladder, one flow, on every creator's page — Anthers' own included.** Holding
 * a Badge is what a subscription to its issuer is; the pick's first Month is charged at
 * the basket (the full threshold, or the upgrade's delta — the server's resolution
 * prices it, never this surface), the recurring line joins the subscription at the next
 * renewal, and the money settles through the cycle distribution. No signup hop, no
 * separate funnel: the visitor picks here, and the account ceremony that interrupts the
 * buy (a signed-out buyer's) comes back to exactly the pick they had.
 *
 * The retired pick-within-budget give the badges tab used to render came out with this:
 * allocating committed support is the subscription dashboard's work, and the model it
 * served is retired by its own sweep task.
 */
function BadgesTab({
	rungs,
	unlockedBadges,
	heldBadge,
	heldAmount,
	creatorName,
	creatorHandle,
	canBuy,
	authenticated,
	preselectedBadgeId,
	isOwner,
}: {
	rungs: CreatorBadge[];
	unlockedBadges: number[];
	heldBadge: string;
	heldAmount: string;
	creatorName: string;
	creatorHandle: string;
	/** Looking at somebody else's profile — you can't buy your own ladder. */
	canBuy: boolean;
	authenticated: boolean;
	/** A pick carried back across the sign-in detour, as `?badge=`. */
	preselectedBadgeId: number | null;
	/** The creator's own page, where the Badge Maker sits above this ladder. */
	isOwner: boolean;
}) {
	const { hasBadge, add } = useBasket();
	const navigate = useNavigate();
	const { pathname } = useLocation();
	const [pickId, setPickId] = useState<number | null>(preselectedBadgeId);
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [added, setAdded] = useState<number | null>(null);

	// Every rung the ladder holds is this creator's own Badge — there is no `gateType` to
	// filter on, and no cross-issuer rung to exclude.
	const unlockedSet = new Set(unlockedBadges);
	const held = supportAmount(heldAmount);

	// The pick carried back across the detour sticks only to a rung that survives the
	// ratchet — a ladder edited between the click and the return re-picks clean.
	const pick = rungs.find((r) => r.id === pickId && Number(r.threshold) > held) ?? null;

	const pickIt = (rung: CreatorBadge) => {
		setAdded(null);
		setError(null);
		setPickId(Number(rung.threshold) > held ? rung.id : null);
	};

	/**
	 * Add the picked rung by way of the basket — the same add both buttons make, the
	 * scratchpad never seeing a Badge (a signed-out pick goes through the doors below
	 * before anything is held). Buy now is the add plus the trip: the basket page's
	 * embedded Checkout is the one purchase form, and every kind of line pays in it.
	 */
	const addThePick = async (thenBasket: boolean) => {
		if (!pick) return;
		setWorking(true);
		setError(null);
		try {
			const result = await Promise.resolve(
				add({
					kind: "badge",
					badgeId: pick.id,
					title: pick.label,
					price: "",
					recurring: String(pick.threshold),
					creatorHandle: creatorHandle,
				}),
			);
			if (!result.ok) {
				setError(result.error);
				return;
			}
			if (thenBasket) {
				navigate("/basket");
				return;
			}
			setAdded(pick.id);
		} finally {
			setWorking(false);
		}
	};

	// The detour's return trip: back to this page, badges tab, pick carried. The rung's
	// id in the URL is what survives the ceremony (signing in tears the page down — the
	// shell unmounts on the auth flip), and the rung above re-picks it on return.
	const back = `${pathname}?tab=badges&badge=${pick?.id ?? ""}`;

	if (rungs.length === 0) {
		// The owner has the maker above this ladder; its own empty line and add form are
		// the invitation, so a second "hasn't set up any Badges yet" would talk about them
		// in the third person on their own page.
		if (isOwner) return null;
		return (
			<EmptyState
				title="No Badges configured"
				description={`${creatorName} hasn't set up any Badges yet. All content is publicly available.`}
			/>
		);
	}

	return (
		<div className="max-w-2xl space-y-8">
			{/* User's current status */}
			{heldBadge !== "none" && heldBadge !== "free" && (
				<div className="card bg-base-200">
					<div className="card-body py-3 px-4">
						<div className="flex items-center justify-between text-sm">
							<span className="text-base-content/60">Your status with {creatorName}</span>
							<div className="flex items-center gap-2">
								<span className="badge badge-sm badge-outline">{badgeNameFor(heldBadge)}</span>
								{parseFloat(heldAmount) > 0 && (
									<span className="badge badge-sm badge-primary badge-outline">
										{amountLabel(heldAmount)}/mo
									</span>
								)}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* The creator's Badge ladder */}
			<div>
				<h3 className="text-lg font-bold mb-1">Badges</h3>
				<p className="text-sm text-base-content/50 mb-3">
					Badges set by {creatorName}. Pick one and buy it here — it renews monthly until you stop.
				</p>
				<div className="space-y-2">
					{rungs.map((rung) => {
						const unlocked = unlockedSet.has(rung.id);
						const threshold = Number(rung.threshold);
						const heldNow = supportAmount(heldAmount);
						const remaining = Math.max(0, threshold - heldNow);
						// Selectable for every buyer who isn't looking at their own ladder, at
						// or above the ratchet — a rung below what you already give is not a
						// purchase, it's a step down the ladder doesn't offer.
						const selectable = canBuy && threshold > heldNow;
						const selected = selectable && pick?.id === rung.id;
						const inBasket = hasBadge(rung.id);

						return (
							<div
								key={rung.id}
								className={`card border ${unlocked ? "border-success/40 bg-success/5" : "border-base-content/10 bg-base-200"} ${selected ? "border-primary ring-1 ring-primary/40" : ""}`}
							>
								<div className="card-body p-4">
									{/* The pick is a real button — keyboard and screen-reader reachable
									    without composite-widget roles, and the artist credit keeps its
									    link outside the button, inside the card. */}
									<button
										type="button"
										className="flex w-full items-center justify-between gap-2 text-left"
										disabled={!selectable}
										aria-pressed={selectable ? selected : undefined}
										onClick={() => selectable && pickIt(rung)}
									>
										<span className="flex items-center gap-2">
											{unlocked ? (
												<CheckCircleIcon className="w-5 h-5 text-success flex-shrink-0" />
											) : (
												<LockClosedIcon className="w-5 h-5 text-base-content/30 flex-shrink-0" />
											)}
											<span>
												<span className="font-medium">{rung.label}</span>
												<span className="text-base-content/40 ml-2 text-sm">
													{amountLabel(rung.threshold)}/mo
												</span>
											</span>
										</span>
										{unlocked ? (
											<span className="badge badge-sm badge-success">Yours</span>
										) : inBasket ? (
											<span className="badge badge-sm badge-secondary">In your basket</span>
										) : selectable ? (
											<span
												className={
													selected ? "badge badge-sm badge-primary" : "badge badge-sm badge-outline"
												}
											>
												{selected ? "Selected" : "Select"}
											</span>
										) : (
											remaining > 0 && (
												<span className="text-xs text-base-content/40">
													${remaining.toFixed(2)} more to unlock
												</span>
											)
										)}
									</button>
									{rung.description && (
										<p className="text-sm text-base-content/60 mt-1 ml-7">{rung.description}</p>
									)}
									{/* 🚨 THE FLIP — the artist credit a supporter reads on a Badge's
									    back. Every emblem has a named human behind it, and naming them
									    here is the promise made when the library was taken on. It
									    covers uploaded art's credit too when the creator names one. */}
									{rung.artistCredit && (
										<p className="text-xs text-base-content/40 mt-1 ml-7">
											Emblem by{" "}
											{rung.artistCredit.artistPermalink ? (
												<a
													href={rung.artistCredit.artistPermalink}
													target="_blank"
													rel="noopener noreferrer"
													className="underline decoration-dotted underline-offset-2"
												>
													{rung.artistCredit.artistName}
												</a>
											) : (
												rung.artistCredit.artistName
											)}{" "}
											· Noun Project
										</p>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>

			{/*
			 * The picked rung's action card — the whole purchase flow, in place: a signed-out
			 * buyer gets the account doors (both of them, both of them coming back), a
			 * signed-in buyer gets the two actions the Work page's buy row carries. The
			 * signup hop the old upgrade prompt was is gone: the intent's pick happens HERE,
			 * and the ceremony, when one exists, returns to it.
			 */}
			{pick && canBuy && (
				<div className="card bg-base-200" data-testid="badge-pick-actions">
					<div className="card-body py-4 px-5 gap-3">
						{!authenticated ? (
							<>
								<p className="text-sm text-base-content/60 text-center mb-0">
									Log in or make an account to buy {pick.label} — {amountLabel(pick.threshold)}/mo,
									starting with the first Month at the basket.
								</p>
								<div className="flex gap-2 justify-center">
									<Link to={withNextPath("/signup", back)} className="btn btn-primary btn-sm">
										Sign up
									</Link>
									<Link to={withNextPath("/login", back)} className="btn btn-ghost btn-sm">
										Log in
									</Link>
								</div>
							</>
						) : (
							<>
								{error && <p className="text-xs text-error">{error}</p>}
								{added === pick.id && (
									<p className="text-xs text-success">
										In your basket. It charges with everything else you've added — the card fee is
										charged once per purchase.
									</p>
								)}
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-outline btn-sm"
										disabled={working || hasBadge(pick.id)}
										onClick={() => void addThePick(false)}
									>
										{hasBadge(pick.id) ? "In your basket" : working ? "Adding…" : "Add to basket"}
									</button>
									<button
										type="button"
										className="btn btn-primary btn-sm flex-1"
										disabled={working}
										onClick={() => void addThePick(true)}
									>
										<BoltIcon className="w-4 h-4" />
										{working ? "Adding…" : "Buy now"}
									</button>
								</div>
							</>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The Badge sitting exactly at a gate's threshold ($3 = Root … $12 = Blossom).
 *
 * Matches on threshold rather than indexing by it: a gate is any amount, and a Badge need
 * not sit at every amount, so "no Badge at this threshold" is a real answer — and it is
 * now the ORDINARY answer rather than an edge case, since a creator sets their own levels
 * to whatever they like.
 */
function _anthersBadgeForRank(rank: number): Badge | null {
	return (ANTHERS_BADGES.find((b) => b.threshold === rank)?.name as Badge | undefined) ?? null;
}

/**
 * The per-card lock chrome that used to live here is gone with the post-level gate.
 * A Work carries its own access and `WorkCard` renders its own locked state, so there is
 * no wrapper deciding what a *post* card may show.
 */

/* ------------------------------------------------------------------ */
/*  Badges tab                                                          */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

const TABS: Tab[] = ["all", "posts", "games", "videos", "audio", "writing", "badges"];

/** The separator between the tab row's groups — the timeline, the Work types, and the profile's metadata views. */
function TabDivider() {
	return <span aria-hidden="true" className="mx-1 h-5 w-px self-center bg-base-content/20" />;
}

export default function CreatorProfilePage() {
	const { handle: handleParam } = useParams<{ handle: string }>();
	// The route param carries the `@`; everything below this line — the API calls, the
	// ownership check, the printed byline — wants the bare handle. `HandleRoute` has already
	// turned away a segment without one, so in practice this never falls back.
	const handle = handleFromParam(handleParam) ?? undefined;
	const { isAuthenticated, user: currentUser, refreshUser } = useAuth();
	const followPermissionMissing = useInteractionPermissionMissing(isAuthenticated) === true;
	const [searchParams, setSearchParams] = useSearchParams();

	const [creator, setCreator] = useState<PublicUser | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [works, setWorks] = useState<CatalogWork[]>([]);
	usePageTitle(creator?.displayName ?? null);
	// ?tab=badges is a real entry point, not a nicety: a locked post's unlock panel sends the
	// user here to act, and dropping them on the default tab loses the intent they arrived with.
	// ?badge= beside it is the pick carried back across a sign-in detour from the same tab.
	const tabParam = searchParams.get("tab") as Tab | null;
	const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "all";
	const badgeParam = Number.isFinite(Number(searchParams.get("badge")))
		? searchParams.get("badge")
		: null;
	const setTab = (next: Tab) => {
		const params = new URLSearchParams(searchParams);
		if (next === "all") params.delete("tab");
		else params.set("tab", next);
		setSearchParams(params, { replace: true });
	};
	const [loading, setLoading] = useState(true);
	const [isFollowing, setIsFollowing] = useState(false);
	const [followerCount, setFollowerCount] = useState(0);
	const [creatorStatus, setCreatorStatus] = useState<CreatorStatus | null>(null);
	const [reporting, setReporting] = useState(false);
	const [confirmingBlock, setConfirmingBlock] = useState(false);
	const [blocking, setBlocking] = useState(false);
	/** Set once a block succeeds — the profile 404s on reload, so we say so before then. */
	const [blocked, setBlocked] = useState(false);

	const isOwnProfile = currentUser?.handle === handle;

	// A profile is a single-creator shelf — the Catalog and posts render as cards that
	// link out to WorkPage, where consumption actually happens and the Time Pool claim
	// lives. So this records a zero-duration visit (the analytics signal that someone
	// browsed this creator's catalog) and earns nothing, mirroring ProjectPage's pattern.
	useReportVisit({ creatorId: creator?.id ?? null });

	/**
	 * The one writer behind every pencil: a field saves itself, so there is no page-wide
	 * save and no draft outliving the field that opened it. A refusal keeps the field
	 * open with the server's own words in it.
	 */
	const saveProfileField = async (
		patch: Partial<
			Pick<PublicUser, "displayName" | "bio" | "websiteUrl" | "location" | "avatar" | "headerImage">
		>,
	) => {
		const res = await apiFetch("/api/accounts/me", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as {
				error?: string;
				issues?: Array<{ message?: string }>;
			} | null;
			throw new Error(body?.error ?? body?.issues?.[0]?.message ?? "Couldn't save this just now.");
		}
		const { user } = (await res.json()) as { user: PublicUser };
		setCreator((current) => (current ? { ...current, ...user } : current));
		// The account's name and avatar also ride the nav, so the app's copy moves too.
		await refreshUser();
	};

	/**
	 * An image is the one field with no draft: choosing a file uploads it and saves the
	 * URL in the same act, the way a Work's thumbnail and a Project's cover behave.
	 */
	const [imageBusy, setImageBusy] = useState<"avatar" | "header" | null>(null);
	const [imageError, setImageError] = useState<string | null>(null);

	const changeImage = async (kind: "avatar" | "header", file: File) => {
		setImageBusy(kind);
		setImageError(null);
		try {
			const form = new FormData();
			form.append("file", file);
			form.append("mediaType", kind);
			const upload = await apiFetch("/api/content/media-upload/direct", {
				method: "POST",
				body: form,
			});
			if (!upload.ok) {
				const body = (await upload.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "That image didn't upload. Try it again.");
			}
			const { url } = (await upload.json()) as { url: string };
			await saveProfileField(kind === "avatar" ? { avatar: url } : { headerImage: url });
		} catch (err) {
			setImageError(err instanceof Error ? err.message : "That image didn't upload. Try it again.");
		} finally {
			setImageBusy(null);
		}
	};

	/**
	 * The supporter-facing ladder and the account's own status. The Badge Maker edits the
	 * same rows the tab renders below it, so it calls back here after a save — one edit,
	 * one screen — rather than leaving the creator to reload to see what they changed.
	 */
	const loadCreatorStatus = useCallback(async () => {
		if (!handle) return null;
		try {
			const res = await apiFetch(`/api/subscriptions/creator-status/${handle}`, {});
			return res.ok ? ((await res.json()) as CreatorStatus) : null;
		} catch {
			return null;
		}
	}, [handle]);

	const reloadCreatorStatus = () => {
		void loadCreatorStatus().then((status) => {
			if (status) setCreatorStatus(status);
		});
	};

	useEffect(() => {
		if (!handle) return;
		setLoading(true);

		Promise.all([
			client.api.accounts.users[":handle"].$get({ param: { handle } }).then(async (res) => {
				if (!res.ok) throw new Error("Failed to load creator profile.");
				return res.json();
			}),
			client.api.content.projects.$get({ query: { creator: handle } }).then((res) => res.json()),
			(async () => {
				const res = await client.api.content.posts.$get({ query: { creator: handle } });
				return res.ok ? ((await res.json()) as { posts: PostListItem[] }) : { posts: [] };
			})(),
			// A profile has no preview mode, so the catalog resolves in the viewer's real
			// context — the server re-resolves each Work, and the frontend never decides a gate.
			client.api.content.catalog[":handle"]
				.$get({ param: { handle }, query: {} })
				.then(async (res) => (res.ok ? await res.json() : { works: [] })),
			loadCreatorStatus(),
		])
			.then(([creatorData, projectData, postData, catalogData, statusData]) => {
				const userData = creatorData.user;
				setCreator(userData);
				setIsFollowing(userData.isFollowing);
				setFollowerCount(userData.followerCount);
				setProjects(projectData.projects);
				// The creator is this page's join: the catalog route attaches no per-work
				// `creator` and the tiles read one, so the splice PostPage and ProjectPage
				// make on their cards happens here once, over everything the page renders
				// — the avatar and the name in every tile's meta row come from the profile
				// itself.
				const creatorOfPage: Creator = {
					handle: userData.handle,
					displayName: userData.displayName,
					avatar: userData.avatar,
				};
				setPosts(postData.posts.map((p) => ({ ...p, creator: creatorOfPage })));
				setWorks(
					(((catalogData as { works?: CatalogWork[] }).works ?? []) as CatalogWork[]).map((w) => ({
						...w,
						creator: creatorOfPage,
					})),
				);
				if (statusData) setCreatorStatus(statusData as CreatorStatus);
			})
			.catch(console.error)
			.finally(() => setLoading(false));
	}, [handle, loadCreatorStatus]);

	/**
	 * Block this person. Confirmed first, because it is the one control here that
	 * changes what BOTH people can see — and because unblocking, while possible from
	 * Settings, is not reachable from this page once the profile stops resolving.
	 */
	const handleBlock = async () => {
		if (!handle) return;
		setBlocking(true);
		try {
			const res = await apiFetch(`/api/accounts/users/${handle}/block`, { method: "POST" });
			if (!res.ok) return;
			setConfirmingBlock(false);
			setBlocked(true);
			setIsFollowing(false);
		} finally {
			setBlocking(false);
		}
	};

	const handleFollow = async () => {
		if (!isAuthenticated || !handle) return;
		try {
			if (isFollowing) {
				await client.api.accounts.users[":handle"].unfollow.$post({
					param: { handle },
				});
				setIsFollowing(false);
				setFollowerCount((c) => c - 1);
			} else {
				const res = await client.api.accounts.users[":handle"].follow.$post({
					param: { handle },
				});
				// Only a follow that was kept reads as one. A refusal — no permission to write the
				// follow's record, say — would otherwise show "Following" for something that is not.
				if (!res.ok) return;
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

	// The type tabs are views over the CATALOG — they are asking "what has this creator
	// made?", which is a question about Works, not about announcements. A type the
	// creator has never released shows no tab at all rather than a "(0)".
	const gameWorks = works.filter((w) => w.type === "game" || w.type === "software");
	const videoWorks = works.filter((w) => w.type === "video");
	// Music and every other kind of audio share a tab: it is the medium a visitor is asking about.
	const audioWorks = works.filter((w) => isListened(w.type));
	const textWorks = works.filter((w) => w.type === "text");
	const typeTabs = (
		[
			["games", `Games (${gameWorks.length})`, gameWorks.length > 0],
			["videos", `Videos (${videoWorks.length})`, videoWorks.length > 0],
			["audio", `Audio (${audioWorks.length})`, audioWorks.length > 0],
			["writing", `Writing (${textWorks.length})`, textWorks.length > 0],
		] as const
	).filter(([, , nonzero]) => nonzero);

	// The "All" tab is the timeline: everything this creator has put out, Posts included,
	// in the order it first came out. The API already sorts works by the creator-asserted
	// original release date; posts and projects interleave on theirs.
	const allItems: {
		type: "project" | "work" | "post";
		item: Project | CatalogWork | PostListItem;
		date: string;
	}[] = [];
	projects.forEach((p) => {
		allItems.push({ type: "project", item: p, date: p.createdAt });
	});
	works.forEach((w) => {
		allItems.push({
			type: "work",
			item: w,
			date: w.originallyReleased ?? w.releasedAt ?? w.createdAt ?? "",
		});
	});
	posts.forEach((p) => {
		allItems.push({
			type: "post",
			item: p,
			// A post's when is when it was published; `createdAt` is only the fallback for
			// an unpublished straggler, which the creator-scoped listing already filters out.
			date: p.publishedAt ?? p.createdAt,
		});
	});
	allItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

	// The read half of each inline field, shared by the owner's pencil and the visitor's
	// plain rendering: a visitor meets exactly what the creator reads, minus the pencils.
	// The "Add a …" prompts are the owner's, since a visitor has nothing to add.
	const displayNameRead = () => (
		<h1 className="text-2xl font-bold">{creator.displayName || creator.handle}</h1>
	);

	const bioRead = () =>
		creator.bio ? (
			<p className="text-sm max-w-2xl whitespace-pre-line">{creator.bio}</p>
		) : isOwnProfile ? (
			<p className="text-sm italic text-base-content/40">Add a bio</p>
		) : null;

	const websiteRead = () =>
		creator.websiteUrl ? (
			<a
				href={creator.websiteUrl}
				target="_blank"
				rel="noopener noreferrer"
				className="flex items-center gap-1 link link-hover"
			>
				<LinkIcon className="w-4 h-4" />
				{hostLabel(creator.websiteUrl)}
			</a>
		) : isOwnProfile ? (
			<span className="italic text-base-content/40">Add a website</span>
		) : null;

	const locationRead = () =>
		creator.location ? (
			<span className="flex items-center gap-1">
				<MapPinIcon className="w-4 h-4" />
				{creator.location}
			</span>
		) : isOwnProfile ? (
			<span className="italic text-base-content/40">Add a location</span>
		) : null;

	return (
		// `relative z-30` lifts the whole page above the logged-out shell's decorative
		// layer (the side vines and their bee swarm sit at z-20 — see LoggedOutLayout) so
		// the bees read as a background, hidden behind the header image and the cards
		// rather than painted across them. The logged-in layout has no decorative layer.
		<div className="relative z-30">
			{/* Header banner. 🚨 Inside the container's width, at a 3:1 ratio — that is
			    the banner-size convention (Bluesky: 3:1, recommended 1500×500; YouTube
			    similar), and full-bleed read as a second, wider site than the one the
			    rest of this page belongs to. The pencil is the only edit affordance:
			    a creator and a visitor meet the same banner. */}
			<div className="container mx-auto px-4">
				<div className="relative w-full aspect-[3/1] bg-base-300">
					{creator.headerImage && (
						<img src={creator.headerImage} alt="Header" className="w-full h-full object-cover" />
					)}
					{isAuthenticated && isOwnProfile && (
						<label
							className={`btn btn-sm absolute right-2 top-2 bg-base-100/80 backdrop-blur ${
								imageBusy === "header" ? "btn-disabled" : ""
							}`}
							title="Change header image"
						>
							<PencilSquareIcon className="w-4 h-4" />
							<span className="sr-only">Change header image</span>
							<input
								type="file"
								accept="image/*"
								className="hidden"
								disabled={imageBusy !== null}
								onChange={(e) => {
									const file = e.target.files?.[0];
									e.target.value = "";
									if (file) void changeImage("header", file);
								}}
							/>
						</label>
					)}
				</div>
			</div>

			<div className="container mx-auto px-4">
				{/* Profile info. Every editable field is the page's own read rendering with
				    a pencil beside it; there is no separate edit view and no page-wide save. */}
				{imageError && <p className="mt-2 text-xs text-error">{imageError}</p>}
				<div className="flex flex-col sm:flex-row items-start gap-4 -mt-12 mb-6">
					<div className="relative">
						{creator.avatar ? (
							<img
								src={creator.avatar}
								alt={creator.displayName || creator.handle}
								className="w-24 h-24 rounded-full object-cover border-4 border-base-100"
							/>
						) : (
							<div className="w-24 h-24 rounded-full bg-base-300 border-4 border-base-100 flex items-center justify-center text-3xl font-bold text-base-content/40">
								{(creator.displayName || creator.handle).charAt(0).toUpperCase()}
							</div>
						)}
						{isAuthenticated && isOwnProfile && (
							<label
								className={`btn btn-xs btn-circle absolute bottom-0 right-0 ${
									imageBusy === "avatar" ? "btn-disabled" : ""
								}`}
								title="Change profile picture"
							>
								<PencilSquareIcon className="w-3.5 h-3.5" />
								<span className="sr-only">Change profile picture</span>
								<input
									type="file"
									accept="image/*"
									className="hidden"
									disabled={imageBusy !== null}
									onChange={(e) => {
										const file = e.target.files?.[0];
										e.target.value = "";
										if (file) void changeImage("avatar", file);
									}}
								/>
							</label>
						)}
					</div>
					<div className="flex-1 pt-4 sm:pt-14">
						{isOwnProfile ? (
							<InlineField<string>
								label="display name"
								saved={creator.displayName ?? ""}
								renderRead={displayNameRead}
								renderEdit={(draft, setDraft) => (
									<input
										type="text"
										aria-label="Display name"
										className="input input-bordered w-full max-w-md"
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										maxLength={150}
									/>
								)}
								save={(draft) => saveProfileField({ displayName: draft.trim() })}
							/>
						) : (
							displayNameRead()
						)}
						{/* The actions belong to the person named on this line, so they sit on it
						    rather than in a column of their own across the page — a visitor's
						    Follow and more-actions answer "who is this", which is what the handle
						    and follower count are already answering. */}
						<div className="flex flex-wrap items-center gap-3">
							<p className="text-base-content/60">
								@{creator.handle} · {followerCount} followers
							</p>
							{isAuthenticated && !isOwnProfile && (
								<div className="flex items-center gap-2">
									<button
										type="button"
										className={`btn ${isFollowing ? "btn-outline" : "btn-primary"}`}
										onClick={handleFollow}
										// Unfollowing is never blocked; following writes a record.
										disabled={!isFollowing && followPermissionMissing}
										title={
											!isFollowing && followPermissionMissing
												? INTERACTION_PERMISSION_HINT
												: undefined
										}
									>
										{isFollowing ? "Following" : "Follow"}
									</button>

									{/* Block and Report sit together and read differently on purpose.
									    Blocking is yours and takes effect immediately; reporting asks an
									    operator to look. Someone who wants to be left alone should not have
									    to file a report to get it, and someone reporting abuse should not
									    have to keep seeing it while they wait. */}
									<div className="dropdown dropdown-end">
										<button
											type="button"
											tabIndex={0}
											className="btn btn-ghost btn-square"
											aria-label={`More options for ${creator.handle}`}
										>
											<EllipsisHorizontalIcon className="w-5 h-5" />
										</button>
										<ul className="dropdown-content menu z-10 w-56 rounded-box bg-base-200 p-2 shadow">
											<li>
												<button type="button" onClick={() => setConfirmingBlock(true)}>
													<NoSymbolIcon className="w-4 h-4" />
													Block @{creator.handle}
												</button>
											</li>
											<li>
												<button type="button" onClick={() => setReporting(true)}>
													Report @{creator.handle}
												</button>
											</li>
										</ul>
									</div>
								</div>
							)}
						</div>
						{isOwnProfile ? (
							<InlineField<string>
								label="bio"
								saved={creator.bio ?? ""}
								className="mt-2"
								renderRead={bioRead}
								renderEdit={(draft, setDraft) => (
									<textarea
										aria-label="Bio"
										className="textarea textarea-bordered w-full max-w-2xl"
										rows={4}
										value={draft}
										onChange={(e) => setDraft(e.target.value)}
										maxLength={5000}
									/>
								)}
								save={(draft) => saveProfileField({ bio: draft.trim() })}
							/>
						) : (
							creator.bio && <div className="mt-2">{bioRead()}</div>
						)}
						<div className="mt-2 flex flex-wrap items-center gap-4 text-sm text-base-content/60">
							{isOwnProfile ? (
								<InlineField<string>
									label="website"
									saved={creator.websiteUrl ?? ""}
									renderRead={websiteRead}
									renderEdit={(draft, setDraft) => (
										<input
											type="url"
											aria-label="Website URL"
											className="input input-bordered input-sm w-72"
											value={draft}
											onChange={(e) => setDraft(e.target.value)}
											placeholder="https://example.com"
											maxLength={500}
										/>
									)}
									save={(draft) => saveProfileField({ websiteUrl: draft.trim() })}
								/>
							) : (
								websiteRead()
							)}
							{isOwnProfile ? (
								<InlineField<string>
									label="location"
									saved={creator.location ?? ""}
									renderRead={locationRead}
									renderEdit={(draft, setDraft) => (
										<input
											type="text"
											aria-label="Location"
											className="input input-bordered input-sm w-56"
											value={draft}
											onChange={(e) => setDraft(e.target.value)}
											placeholder="City, country"
											maxLength={100}
										/>
									)}
									save={(draft) => saveProfileField({ location: draft.trim() })}
								/>
							) : (
								locationRead()
							)}
							<span className="flex items-center gap-1">
								<CalendarDaysIcon className="w-4 h-4" />
								Member since{" "}
								{new Date(creator.createdAt).toLocaleDateString("en-US", {
									month: "long",
									year: "numeric",
								})}
							</span>
						</div>
					</div>
					{/* The user's Anthers Badge, and the rung held here. A status chip rather than
					    an action, so it keeps the column the buttons have left. */}
					{isAuthenticated && !isOwnProfile && creatorStatus && creatorStatus.badge !== "free" && (
						<div className="flex items-center gap-2 text-xs pt-4 sm:pt-14">
							<span className="badge badge-sm badge-outline">
								{badgeNameFor(creatorStatus.badge)}
							</span>
							{parseFloat(creatorStatus.badgeAmount) > 0 && (
								<span className="badge badge-sm badge-primary badge-outline">
									{amountLabel(creatorStatus.badgeAmount)}/mo
								</span>
							)}
						</div>
					)}
				</div>

				{/* Tabs. One flat row, but grouped: the timeline views (All, Posts), then the
				    Work-type views — only the types the creator has actually released, so a
				    profile with no audio shows no Audio tab rather than "Audio (0)" — then
				    Badges. The dividers sit between the groups, and collapse to a single
				    divider when the middle group is empty. */}
				<div className="tabs tabs-bordered mb-6 overflow-x-auto">
					<button
						type="button"
						className={`tab whitespace-nowrap ${tab === "all" ? "tab-active" : ""}`}
						onClick={() => setTab("all")}
					>
						All
					</button>
					<button
						type="button"
						className={`tab whitespace-nowrap ${tab === "posts" ? "tab-active" : ""}`}
						onClick={() => setTab("posts")}
					>
						Posts
					</button>
					{typeTabs.length > 0 && (
						<>
							<TabDivider />
							{typeTabs.map(([key, label]) => (
								<button
									type="button"
									key={key}
									className={`tab whitespace-nowrap ${tab === key ? "tab-active" : ""}`}
									onClick={() => setTab(key)}
								>
									{label}
								</button>
							))}
							<TabDivider />
						</>
					)}
					<button
						type="button"
						className={`tab whitespace-nowrap ${tab === "badges" ? "tab-active" : ""}`}
						onClick={() => setTab("badges")}
					>
						Badges
					</button>
				</div>

				{/* Tab content */}
				<div className="pb-8">
					{tab === "all" &&
						(allItems.length > 0 ? (
							// The same uniform tile grid the feed renders — every listing
							// surface shares one widget, so a creator's page reads like the
							// feed the creator's releases also ride. Projects keep ProjectCard:
							// a project has no tile shape.
							<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
								{allItems.map((entry) => {
									if (entry.type === "project") {
										return (
											<ProjectCard key={`proj-${entry.item.id}`} project={entry.item as Project} />
										);
									}
									if (entry.type === "post") {
										return (
											<FeedTile
												key={`post-${entry.item.id}`}
												entry={postEntry(entry.item as PostListItem)}
											/>
										);
									}
									return (
										<FeedTile
											key={`work-${(entry.item as CatalogWork).id}`}
											entry={workEntry(entry.item as CatalogWork)}
										/>
									);
								})}
							</div>
						) : (
							<EmptyState
								title="No content yet"
								description={`${creator.displayName || creator.handle} hasn't published anything yet.`}
							/>
						))}

					{tab === "posts" &&
						(posts.length > 0 ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
								{posts.map((p) => (
									<FeedTile key={`post-${p.id}`} entry={postEntry(p)} />
								))}
							</div>
						) : (
							<EmptyState
								title="No posts yet"
								description={`${creator.displayName || creator.handle} hasn't published any posts yet.`}
							/>
						))}

					{tab === "games" &&
						(gameWorks.length > 0 ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
								{gameWorks.map((w) => (
									<FeedTile key={w.id} entry={workEntry(w)} />
								))}
							</div>
						) : (
							<EmptyState
								title="No games yet"
								description={`${creator.displayName || creator.handle} hasn't published any games.`}
							/>
						))}

					{tab === "videos" &&
						(videoWorks.length > 0 ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
								{videoWorks.map((w) => (
									<FeedTile key={w.id} entry={workEntry(w)} />
								))}
							</div>
						) : (
							<EmptyState
								title="No videos yet"
								description={`${creator.displayName || creator.handle} hasn't published any videos.`}
							/>
						))}

					{tab === "audio" &&
						(audioWorks.length > 0 ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
								{audioWorks.map((w) => (
									<FeedTile key={w.id} entry={workEntry(w)} />
								))}
							</div>
						) : (
							<EmptyState
								title="No audio yet"
								description={`${creator.displayName || creator.handle} hasn't published any audio.`}
							/>
						))}

					{tab === "writing" &&
						(textWorks.length > 0 ? (
							<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4 items-stretch">
								{textWorks.map((w) => (
									<FeedTile key={w.id} entry={workEntry(w)} />
								))}
							</div>
						) : (
							<EmptyState
								title="No writing yet"
								description={`${creator.displayName || creator.handle} hasn't published any articles.`}
							/>
						))}

					{tab === "badges" && (
						<div className="max-w-2xl space-y-8">
							{/* The maker and the ladder are one surface: edit a rung here and the
							    supporter-facing row below moves with it. */}
							{isOwnProfile && <BadgeMaker onChanged={reloadCreatorStatus} />}
							<BadgesTab
								rungs={creatorStatus?.badges ?? []}
								unlockedBadges={creatorStatus?.unlockedBadges ?? []}
								heldBadge={creatorStatus?.badge ?? "free"}
								heldAmount={creatorStatus?.badgeAmount ?? "0.00"}
								creatorName={creator.displayName || creator.handle}
								creatorHandle={creator.handle}
								canBuy={!isOwnProfile}
								authenticated={isAuthenticated === true}
								preselectedBadgeId={badgeParam != null ? Number(badgeParam) : null}
								isOwner={isOwnProfile}
							/>
						</div>
					)}

					{blocked && (
						<div className="alert alert-info mb-4">
							<span>
								You've blocked @{creator.handle}. Neither of you will see the other around Anthers,
								and you're no longer following each other. You can undo this in Settings.
							</span>
						</div>
					)}
				</div>
			</div>

			{/* Confirmed, because it changes what BOTH people see and because this page
			    stops resolving afterwards — the undo lives in Settings, so the copy says
			    where it is rather than leaving someone stuck. Deliberately says nothing
			    about the other person being told, because they aren't. */}
			<Modal open={confirmingBlock} label={`Block @${creator.handle}`}>
				<div className="modal-box">
					<h3 className="text-lg font-bold">Block @{creator.handle}?</h3>
					<ul className="list-disc py-3 pl-5 text-sm text-base-content/70 space-y-1">
						<li>Neither of you will see the other's profile, comments or reviews.</li>
						<li>Any follows between you are removed, in both directions.</li>
						<li>Their published work stays where it is — blocking isn't a content filter.</li>
						<li>You can undo this from Settings.</li>
					</ul>
					<div className="modal-action">
						<button
							type="button"
							className="btn btn-ghost"
							onClick={() => setConfirmingBlock(false)}
							disabled={blocking}
						>
							Cancel
						</button>
						<button
							type="button"
							className="btn btn-error"
							onClick={handleBlock}
							disabled={blocking}
						>
							{blocking ? "Blocking…" : "Block"}
						</button>
					</div>
				</div>
				<button
					type="button"
					className="modal-backdrop"
					onClick={() => setConfirmingBlock(false)}
					aria-label="Close"
				/>
			</Modal>

			{reporting && (
				<ReportDialog
					subjectType="user"
					subjectId={creator.id}
					label={displayHandle(creator.handle)}
					onClose={() => setReporting(false)}
				/>
			)}
		</div>
	);
}
