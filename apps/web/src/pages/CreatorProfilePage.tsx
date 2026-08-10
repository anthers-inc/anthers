// SPDX-License-Identifier: AGPL-3.0-or-later

import { ANTHERS_BADGES, badgeLabel, seedCost, thresholdForBadge } from "@anthers/shared/constants";
import { useAuth } from "@anthers/web-shared/auth";
import { SeedStepper } from "@anthers/web-shared/economics/SeedStepper";
import { Link, useParams, useSearchParams } from "@anthers/web-shared/router";
import { apiFetch, client } from "@anthers/web-shared/rpc";
import type {
	Badge,
	CreatorGate,
	CreatorStatus,
	PostListItem,
	Project,
	PublicUser,
	Work,
} from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import FormField from "@anthers/web-shared/ui/FormField";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	CameraIcon,
	CheckCircleIcon,
	EllipsisHorizontalIcon,
	LinkIcon,
	LockClosedIcon,
	LockOpenIcon,
	MapPinIcon,
	NoSymbolIcon,
	PencilIcon,
} from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import PostCard from "../components/cards/PostCard";
import ProjectCard from "../components/cards/ProjectCard";
import WorkCard from "../components/cards/WorkCard";
import ReportDialog from "../components/ui/ReportDialog";
import { useReportVisit } from "../lib/attention";

/** A Work as the public Catalog listing returns it. */
type CatalogWork = Work & {
	creator?: { username: string; displayName?: string | null; avatar?: string | null };
};

type Tab = "all" | "games" | "videos" | "audio" | "writing" | "badges" | "about";

function badgeNameFor(id: string): string {
	if (id === "none" || id === "free" || !id) return "Free";
	return id.charAt(0).toUpperCase() + id.slice(1);
}

/* ------------------------------------------------------------------ */
/*  Give Seeds                                                         */
/* ------------------------------------------------------------------ */

/**
 * Give Seeds to this creator — the entry point where the intent actually forms.
 *
 * The subscription dashboard can only list creators it already knows about (settled pool
 * distributions unioned with existing allocations), so a creator you just followed can't be
 * reached from there at all. This is the door for that case.
 *
 * Two API rules shape the control rather than being discovered as errors:
 *   - allocations RATCHET within a cycle (a decrease is rejected), so the committed amount
 *     is the stepper's floor;
 *   - the total across all creators can't exceed the Seeds you hold, so the
 *     ceiling is what you've already given this creator plus what's still unallocated.
 *
 * `amount` is the creator's new TOTAL, not a delta — the endpoint upserts it.
 */
function GiveSeedsCard({
	creatorId,
	creatorName,
	given,
	onGiven,
}: {
	creatorId: number;
	creatorName: string;
	/** Dollars already given to this creator this cycle (the ratchet floor). */
	given: string;
	onGiven: () => void | Promise<void>;
}) {
	const committed = Math.round(Number(given) || 0);
	const [budget, setBudget] = useState<number | null>(null);
	const [remaining, setRemaining] = useState(0);
	const [pending, setPending] = useState(committed);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	/** The viewer's Seed budget and what's still unallocated across all creators. */
	const loadBudget = useCallback(async () => {
		const res = await client.api.subscriptions.seeds.$get();
		if (!res.ok) return;
		const data = await res.json();
		setBudget(Number(data.budget));
		setRemaining(Number(data.remaining));
	}, []);

	useEffect(() => {
		loadBudget();
	}, [loadBudget]);

	// Re-sync when the committed amount changes underneath us (after a successful give).
	useEffect(() => setPending(committed), [committed]);

	// Only Free carries no Seeds, and the tab's upgrade prompt already makes that
	// case — rendering our own "give Seeds" CTA here would just duplicate it.
	if (budget === null || budget <= 0) return null;

	const max = committed + Math.floor(remaining);
	const dirty = pending !== committed;

	const give = async () => {
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.seeds.$post({
				json: { creatorId, amount: pending.toFixed(2) },
			});
			if (!res.ok) {
				const body = (await res.json()) as { error?: string };
				throw new Error(body.error ?? "Could not give Seeds.");
			}
			// Both halves have to move: `onGiven` re-reads the gate ladder (so a tier flips to
			// Unlocked), and `loadBudget` re-reads what's left to give. Refreshing only the
			// ladder leaves the budget line stating a total the viewer has already spent.
			await Promise.all([onGiven(), loadBudget()]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not give Seeds.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body py-4 px-5 gap-3">
				<div className="flex items-center justify-between gap-4 flex-wrap">
					<div>
						<h4 className="font-medium">Give Seeds to {creatorName}</h4>
						<p className="text-xs text-base-content/50 mt-0.5">
							$3 each, no platform cut — only the at-cost card processing comes out. You have $
							{remaining.toFixed(2)} of ${budget.toFixed(2)} left to give this month.
						</p>
					</div>
					<SeedStepper
						value={pending}
						min={committed}
						max={max}
						onChange={setPending}
						disabled={saving}
					/>
				</div>

				{committed > 0 && (
					<p className="text-xs text-base-content/50">
						You've given {creatorName} ${committed.toFixed(2)} this month. Seeds can be added
						mid-month but not taken back — next month's are yours to redirect.
					</p>
				)}

				{error && <p className="text-xs text-error">{error}</p>}

				<button
					type="button"
					className="btn btn-primary btn-sm w-fit"
					disabled={!dirty || saving}
					onClick={give}
				>
					{saving ? "Giving…" : dirty ? `Give $${(pending - committed).toFixed(2)}` : "Give Seeds"}
				</button>
			</div>
		</div>
	);
}

/**
 * The Badge sitting at an Anthers Gate's threshold (1 = Root … 4 = Blossom).
 *
 * Matches on threshold rather than indexing by it: a gate is any whole-Seed level, and a
 * Badge need not sit at every level, so "no Badge at this threshold" is a real answer.
 */
function anthersBadgeForRank(rank: number): Badge | null {
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

function BadgesTab({
	gates,
	unlockedGates,
	heldBadge,
	userSeed,
	creatorName,
	creatorId,
	canGiveSeeds,
	onGiven,
}: {
	gates: CreatorGate[];
	unlockedGates: number[];
	heldBadge: string;
	userSeed: string;
	creatorName: string;
	creatorId: number;
	/** Signed in, and not looking at your own profile — you can't give Seeds to yourself. */
	canGiveSeeds: boolean;
	onGiven: () => void | Promise<void>;
}) {
	const anthersBadgeGates = gates.filter((g) => g.gateType === "anthers_badge");
	const seedGates = gates.filter((g) => g.gateType === "seed");
	const unlockedSet = new Set(unlockedGates);

	if (gates.length === 0) {
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
								{parseFloat(userSeed) > 0 && (
									<span className="badge badge-sm badge-primary badge-outline">
										${userSeed} in Seeds
									</span>
								)}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Anthers Badges */}
			{anthersBadgeGates.length > 0 && (
				<div>
					<h3 className="text-lg font-bold mb-1">Anthers Badges</h3>
					<p className="text-sm text-base-content/50 mb-3">
						Platform-wide access, unlocked by the Anthers Badge you hold.
					</p>
					<div className="space-y-2">
						{anthersBadgeGates.map((gate) => {
							const unlocked = unlockedSet.has(gate.id);
							const gateBadge = anthersBadgeForRank(Number(gate.threshold));
							const gateBadgeView = gateBadge
								? { price: seedCost(thresholdForBadge(gateBadge)) }
								: null;
							return (
								<div
									key={gate.id}
									className={`card border ${unlocked ? "border-success/40 bg-success/5" : "border-base-content/10 bg-base-200"}`}
								>
									<div className="card-body p-4">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-2">
												{unlocked ? (
													<CheckCircleIcon className="w-5 h-5 text-success flex-shrink-0" />
												) : (
													<LockClosedIcon className="w-5 h-5 text-base-content/30 flex-shrink-0" />
												)}
												<div>
													<span className="font-medium">
														{gateBadge ? badgeLabel(gateBadge) : gate.label}
													</span>
													{gateBadgeView && (
														<span className="text-base-content/40 ml-2 text-sm">
															${gateBadgeView.price}/mo
														</span>
													)}
												</div>
											</div>
											{unlocked && <span className="badge badge-sm badge-success">Unlocked</span>}
										</div>
										{gate.description && (
											<p className="text-sm text-base-content/60 mt-1 ml-7">{gate.description}</p>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Seed Badges */}
			{seedGates.length > 0 && (
				<div>
					<h3 className="text-lg font-bold mb-1">Seed Badges</h3>
					<p className="text-sm text-base-content/50 mb-3">
						Badges set by {creatorName}. Give them Seeds to unlock.
					</p>
					{canGiveSeeds && (
						<div className="mb-3">
							<GiveSeedsCard
								creatorId={creatorId}
								creatorName={creatorName}
								given={userSeed}
								onGiven={onGiven}
							/>
						</div>
					)}
					<div className="space-y-2">
						{seedGates.map((gate) => {
							const unlocked = unlockedSet.has(gate.id);
							const currentSeed = parseFloat(userSeed);
							const threshold = parseFloat(gate.threshold);
							const remaining = Math.max(0, threshold - currentSeed);
							return (
								<div
									key={gate.id}
									className={`card border ${unlocked ? "border-success/40 bg-success/5" : "border-base-content/10 bg-base-200"}`}
								>
									<div className="card-body p-4">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-2">
												{unlocked ? (
													<CheckCircleIcon className="w-5 h-5 text-success flex-shrink-0" />
												) : (
													<LockClosedIcon className="w-5 h-5 text-base-content/30 flex-shrink-0" />
												)}
												<div>
													<span className="font-medium">{gate.label}</span>
													<span className="text-base-content/40 ml-2 text-sm">
														${gate.threshold} in Seeds
													</span>
												</div>
											</div>
											{unlocked ? (
												<span className="badge badge-sm badge-success">Unlocked</span>
											) : (
												remaining > 0 && (
													<span className="text-xs text-base-content/40">
														${remaining.toFixed(2)} more to unlock
													</span>
												)
											)}
										</div>
										{gate.description && (
											<p className="text-sm text-base-content/60 mt-1 ml-7">{gate.description}</p>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</div>
			)}

			{/* Upgrade prompt */}
			{(heldBadge === "none" || heldBadge === "free") && (
				<div className="card bg-base-200">
					<div className="card-body text-center">
						<p className="text-sm text-base-content/60 mb-2">
							Give Seeds to Anthers to start unlocking Badges, and to {creatorName} to support them
							directly.
						</p>
						<Link to="/subscribe" className="btn btn-primary btn-sm mx-auto">
							Get Started
						</Link>
					</div>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

const TABS: Tab[] = ["all", "games", "videos", "audio", "writing", "badges", "about"];

export default function CreatorProfilePage() {
	const { username } = useParams<{ username: string }>();
	const { isAuthenticated, user: currentUser, refreshUser } = useAuth();
	const [searchParams, setSearchParams] = useSearchParams();

	const [creator, setCreator] = useState<PublicUser | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [works, setWorks] = useState<CatalogWork[]>([]);
	// ?tab=badges is a real entry point, not a nicety: a locked post's unlock panel sends the
	// viewer here to act, and dropping them on the default tab loses the intent they arrived with.
	const tabParam = searchParams.get("tab") as Tab | null;
	const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : "all";
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

	const isOwnProfile = currentUser?.username === username;

	// A profile is a single-creator shelf — the Catalog and posts render as cards that
	// link out to WorkPage, where consumption actually happens and the Time Pool claim
	// lives. So this records a zero-duration visit (the analytics signal that someone
	// browsed this creator's catalog) and earns nothing, mirroring ProjectPage's pattern.
	useReportVisit({ creatorId: creator?.id ?? null });

	/**
	 * Re-read the viewer's standing with this creator. Giving Seeds changes which gates are
	 * unlocked, and the whole point of the control is watching a tier flip to Unlocked — so
	 * the ladder has to reflect it without a reload.
	 */
	const refreshCreatorStatus = useCallback(async () => {
		if (!username) return;
		const res = await apiFetch(`/api/subscriptions/creator-status/${username}`, {});
		if (!res.ok) return;
		setCreatorStatus((await res.json()) as CreatorStatus);
	}, [username]);

	// Edit mode state
	const [editing, setEditing] = useState(false);
	const [editDisplayName, setEditDisplayName] = useState("");
	const [editBio, setEditBio] = useState("");
	const [editWebsiteUrl, setEditWebsiteUrl] = useState("");
	const [editLocation, setEditLocation] = useState("");
	const [avatarFile, setAvatarFile] = useState<File | null>(null);
	const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
	const [headerFile, setHeaderFile] = useState<File | null>(null);
	const [headerPreview, setHeaderPreview] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [editError, setEditError] = useState<string | null>(null);
	const [editErrors, setEditErrors] = useState<Record<string, string>>({});

	const startEditing = () => {
		if (!creator) return;
		setEditDisplayName(creator.displayName || "");
		setEditBio(creator.bio || "");
		setEditWebsiteUrl(creator.websiteUrl || "");
		setEditLocation(creator.location || "");
		setAvatarFile(null);
		setAvatarPreview(creator.avatar || null);
		setHeaderFile(null);
		setHeaderPreview(creator.headerImage || null);
		setEditError(null);
		setEditErrors({});
		setEditing(true);
	};

	const cancelEditing = () => {
		setEditing(false);
		setEditError(null);
		setEditErrors({});
	};

	const handleSaveProfile = async (e: React.FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setEditError(null);
		setEditErrors({});

		try {
			// Upload files first if changed, then patch profile with URLs
			let avatarUrl: string | undefined;
			let headerUrl: string | undefined;

			if (avatarFile) {
				const uploadData = new FormData();
				uploadData.append("file", avatarFile);
				uploadData.append("mediaType", "avatar");
				const uploadRes = await apiFetch("/api/content/media-upload/direct", {
					method: "POST",
					body: uploadData,
				});
				if (!uploadRes.ok) throw new Error("Failed to upload avatar.");
				const uploadJson = (await uploadRes.json()) as { url: string };
				avatarUrl = uploadJson.url;
			}

			if (headerFile) {
				const uploadData = new FormData();
				uploadData.append("file", headerFile);
				uploadData.append("mediaType", "header");
				const uploadRes = await apiFetch("/api/content/media-upload/direct", {
					method: "POST",
					body: uploadData,
				});
				if (!uploadRes.ok) throw new Error("Failed to upload header image.");
				const uploadJson = (await uploadRes.json()) as { url: string };
				headerUrl = uploadJson.url;
			}

			const payload: Record<string, string> = {
				displayName: editDisplayName,
				bio: editBio,
				websiteUrl: editWebsiteUrl,
				location: editLocation,
			};
			if (avatarUrl) payload.avatar = avatarUrl;
			if (headerUrl) payload.headerImage = headerUrl;

			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});

			if (!res.ok) {
				const data = await res.json();
				if (data && typeof data === "object") {
					const fieldErrors: Record<string, string> = {};
					for (const [key, val] of Object.entries(data as Record<string, string[]>)) {
						fieldErrors[key] = Array.isArray(val) ? val[0] : String(val);
					}
					setEditErrors(fieldErrors);
					return;
				}
				throw new Error("Failed to save profile.");
			}

			await refreshUser();

			// Re-fetch the profile data to reflect changes
			const creatorRes = await client.api.accounts.users[":username"].$get({
				param: { username: username! },
			});
			if (creatorRes.ok) {
				const { user } = await creatorRes.json();
				setCreator(user);
			}
			setEditing(false);
		} catch (err) {
			if (Object.keys(editErrors).length === 0) {
				setEditError(err instanceof Error ? err.message : "Failed to save profile.");
			}
		} finally {
			setSaving(false);
		}
	};

	useEffect(() => {
		if (!username) return;
		setLoading(true);

		Promise.all([
			client.api.accounts.users[":username"].$get({ param: { username } }).then(async (res) => {
				if (!res.ok) throw new Error("Failed to load creator profile.");
				return res.json();
			}),
			client.api.content.projects.$get({ query: { creator: username } }).then((res) => res.json()),
			client.api.content.posts.$get({ query: { creator: username } }).then((res) => res.json()),
			client.api.content.catalog[":username"]
				.$get({ param: { username } })
				.then(async (res) => (res.ok ? await res.json() : { works: [] })),
			apiFetch(`/api/subscriptions/creator-status/${username}`, {})
				.then((res) => (res.ok ? res.json() : null))
				.catch(() => null),
		])
			.then(([creatorData, projectData, postData, catalogData, statusData]) => {
				const userData = creatorData.user;
				setCreator(userData);
				setIsFollowing(userData.isFollowing);
				setFollowerCount(userData.followerCount);
				setProjects(projectData.projects);
				setPosts(postData.posts);
				setWorks(((catalogData as { works?: CatalogWork[] }).works ?? []) as CatalogWork[]);
				if (statusData) setCreatorStatus(statusData as CreatorStatus);
			})
			.catch(console.error)
			.finally(() => setLoading(false));
	}, [username]);

	/**
	 * Block this person. Confirmed first, because it is the one control here that
	 * changes what BOTH people can see — and because unblocking, while possible from
	 * Settings, is not reachable from this page once the profile stops resolving.
	 */
	const handleBlock = async () => {
		if (!username) return;
		setBlocking(true);
		try {
			const res = await apiFetch(`/api/accounts/users/${username}/block`, { method: "POST" });
			if (!res.ok) return;
			setConfirmingBlock(false);
			setBlocked(true);
			setIsFollowing(false);
		} finally {
			setBlocking(false);
		}
	};

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

	// The type tabs are views over the CATALOG — they are asking "what has this creator
	// made?", which is a question about Works, not about announcements.
	const gameWorks = works.filter((w) => w.type === "game" || w.type === "software");
	const videoWorks = works.filter((w) => w.type === "video");
	const audioWorks = works.filter((w) => w.type === "audio");
	const textWorks = works.filter((w) => w.type === "text");

	// The "All" tab is the Catalog timeline: everything this creator has made, in the order
	// they made it. The API already sorts by the creator-asserted Created date; projects
	// interleave on their own dates.
	const allItems: { type: "project" | "work"; item: Project | CatalogWork; date: string }[] = [];
	projects.forEach((p) => {
		allItems.push({ type: "project", item: p, date: p.createdAt });
	});
	works.forEach((w) => {
		allItems.push({
			type: "work",
			item: w,
			date: w.authoredAt ?? w.releasedAt ?? w.createdAt ?? "",
		});
	});
	allItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

	return (
		<div>
			{/* Header banner */}
			{editing ? (
				<div className="relative w-full h-48 md:h-64 bg-base-300 group">
					{headerPreview ? (
						<img src={headerPreview} alt="Header" className="w-full h-full object-cover" />
					) : (
						<div className="w-full h-full bg-base-300" />
					)}
					<label className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
						<div className="flex items-center gap-2 text-white text-sm font-medium">
							<CameraIcon className="w-5 h-5" />
							Change header
						</div>
						<input
							type="file"
							accept="image/*"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) {
									setHeaderFile(file);
									setHeaderPreview(URL.createObjectURL(file));
								}
							}}
						/>
					</label>
				</div>
			) : (
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
			)}

			<div className="container mx-auto px-4">
				{/* Profile info */}
				{editing ? (
					<form onSubmit={handleSaveProfile} className="mb-6">
						{/* Avatar with overlay */}
						<div className="flex flex-col sm:flex-row items-start gap-4 -mt-12 mb-4">
							<div className="relative group">
								{avatarPreview ? (
									<img
										src={avatarPreview}
										alt="Avatar"
										className="w-24 h-24 rounded-full object-cover border-4 border-base-100"
									/>
								) : (
									<div className="w-24 h-24 rounded-full bg-base-300 border-4 border-base-100 flex items-center justify-center text-3xl font-bold text-base-content/40">
										{(editDisplayName || creator.username).charAt(0).toUpperCase()}
									</div>
								)}
								<label className="absolute inset-0 flex items-center justify-center rounded-full bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer">
									<CameraIcon className="w-6 h-6 text-white" />
									<input
										type="file"
										accept="image/*"
										className="hidden"
										onChange={(e) => {
											const file = e.target.files?.[0];
											if (file) {
												setAvatarFile(file);
												setAvatarPreview(URL.createObjectURL(file));
											}
										}}
									/>
								</label>
							</div>
							<div className="flex-1 pt-4 w-full">
								<p className="text-base-content/60 mb-3">@{creator.username}</p>
							</div>
						</div>

						{editError && (
							<div className="alert alert-error mb-4">
								<span>{editError}</span>
							</div>
						)}

						<div className="flex flex-col gap-4 max-w-lg">
							<FormField label="Display Name" error={editErrors.displayName}>
								<input
									type="text"
									className="input input-bordered w-full"
									value={editDisplayName}
									onChange={(e) => setEditDisplayName(e.target.value)}
									maxLength={150}
								/>
							</FormField>

							<FormField label="Bio" error={editErrors.bio}>
								<textarea
									className="textarea textarea-bordered w-full"
									rows={3}
									value={editBio}
									onChange={(e) => setEditBio(e.target.value)}
								/>
							</FormField>

							<FormField label="Website URL" error={editErrors.websiteUrl}>
								<input
									type="url"
									className="input input-bordered w-full"
									value={editWebsiteUrl}
									onChange={(e) => setEditWebsiteUrl(e.target.value)}
									placeholder="https://example.com"
								/>
							</FormField>

							<FormField label="Location" error={editErrors.location}>
								<input
									type="text"
									className="input input-bordered w-full"
									value={editLocation}
									onChange={(e) => setEditLocation(e.target.value)}
									maxLength={100}
								/>
							</FormField>

							<div className="flex gap-2 mt-2">
								<button
									type="submit"
									className={`btn btn-primary btn-sm ${saving ? "btn-disabled" : ""}`}
									disabled={saving}
								>
									{saving ? "Saving..." : "Save Profile"}
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-sm"
									onClick={cancelEditing}
									disabled={saving}
								>
									Cancel
								</button>
							</div>
						</div>
					</form>
				) : (
					<div className="flex flex-col sm:flex-row items-start gap-4 -mt-12 mb-6">
						{creator.avatar ? (
							<img
								src={creator.avatar}
								alt={creator.displayName || creator.username}
								className="w-24 h-24 rounded-full object-cover border-4 border-base-100"
							/>
						) : (
							<div className="w-24 h-24 rounded-full bg-base-300 border-4 border-base-100 flex items-center justify-center text-3xl font-bold text-base-content/40">
								{(creator.displayName || creator.username).charAt(0).toUpperCase()}
							</div>
						)}
						<div className="flex-1 pt-4">
							<h1 className="text-2xl font-bold">{creator.displayName || creator.username}</h1>
							<p className="text-base-content/60">
								@{creator.username} · {followerCount} followers
							</p>
							{creator.bio && <p className="mt-2 text-sm max-w-2xl">{creator.bio}</p>}
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
						{isAuthenticated && isOwnProfile && (
							<button
								type="button"
								className="btn btn-ghost btn-sm mt-4 sm:mt-12"
								onClick={startEditing}
							>
								<PencilIcon className="w-4 h-4" />
								Edit Profile
							</button>
						)}
						{isAuthenticated && !isOwnProfile && (
							<div className="flex flex-col items-end gap-2 mt-4 sm:mt-12">
								<div className="flex items-center gap-2">
									<button
										type="button"
										className={`btn ${isFollowing ? "btn-outline" : "btn-primary"}`}
										onClick={handleFollow}
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
											aria-label={`More options for ${creator.username}`}
										>
											<EllipsisHorizontalIcon className="w-5 h-5" />
										</button>
										<ul className="dropdown-content menu z-10 w-56 rounded-box bg-base-200 p-2 shadow">
											<li>
												<button type="button" onClick={() => setConfirmingBlock(true)}>
													<NoSymbolIcon className="w-4 h-4" />
													Block @{creator.username}
												</button>
											</li>
											<li>
												<button type="button" onClick={() => setReporting(true)}>
													Report @{creator.username}
												</button>
											</li>
										</ul>
									</div>
								</div>
								{/* Badge/seed badges */}
								{creatorStatus && creatorStatus.badge !== "free" && (
									<div className="flex items-center gap-2 text-xs">
										<span className="badge badge-sm badge-outline">
											{badgeNameFor(creatorStatus.badge)}
										</span>
										{parseFloat(creatorStatus.seedAmount) > 0 && (
											<span className="badge badge-sm badge-primary badge-outline">
												${creatorStatus.seedAmount} in Seeds
											</span>
										)}
									</div>
								)}
							</div>
						)}
					</div>
				)}

				{/* Tabs */}
				<div className="tabs tabs-bordered mb-6 overflow-x-auto">
					{(
						[
							["all", "All"],
							["games", `Games (${gameWorks.length})`],
							["videos", `Videos (${videoWorks.length})`],
							["audio", `Audio (${audioWorks.length})`],
							["writing", `Writing (${textWorks.length})`],
							["badges", "Badges"],
							["about", "About"],
						] as const
					).map(([key, label]) => (
						<button
							type="button"
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
					{tab === "all" &&
						(allItems.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{allItems.map((entry) => {
									if (entry.type === "project") {
										return (
											<ProjectCard key={`proj-${entry.item.id}`} project={entry.item as Project} />
										);
									}
									const work = entry.item as CatalogWork;
									return <WorkCard key={`work-${work.id}`} work={work} />;
								})}
							</div>
						) : (
							<EmptyState
								title="No content yet"
								description={`${creator.displayName || creator.username} hasn't published anything yet.`}
							/>
						))}

					{tab === "games" &&
						(projects.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{gameWorks.map((w) => (
									<WorkCard key={w.id} work={w} />
								))}
							</div>
						) : (
							<EmptyState
								title="No games yet"
								description={`${creator.displayName || creator.username} hasn't published any games.`}
							/>
						))}

					{tab === "videos" &&
						(videoWorks.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{videoWorks.map((w) => (
									<WorkCard key={w.id} work={w} />
								))}
							</div>
						) : (
							<EmptyState
								title="No videos yet"
								description={`${creator.displayName || creator.username} hasn't published any videos.`}
							/>
						))}

					{tab === "audio" &&
						(audioWorks.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{audioWorks.map((w) => (
									<WorkCard key={w.id} work={w} />
								))}
							</div>
						) : (
							<EmptyState
								title="No audio yet"
								description={`${creator.displayName || creator.username} hasn't published any audio.`}
							/>
						))}

					{tab === "writing" &&
						(textWorks.length > 0 ? (
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-7xl">
								{textWorks.map((w) => (
									<WorkCard key={w.id} work={w} />
								))}
							</div>
						) : (
							<EmptyState
								title="No writing yet"
								description={`${creator.displayName || creator.username} hasn't published any articles.`}
							/>
						))}

					{tab === "badges" && (
						<BadgesTab
							gates={creatorStatus?.gates ?? []}
							unlockedGates={creatorStatus?.unlockedGates ?? []}
							heldBadge={creatorStatus?.badge ?? "free"}
							userSeed={creatorStatus?.seedAmount ?? "0.00"}
							creatorName={creator.displayName || creator.username}
							creatorId={creator.id}
							canGiveSeeds={isAuthenticated && !isOwnProfile}
							onGiven={refreshCreatorStatus}
						/>
					)}

					{blocked && (
						<div className="alert alert-info mb-4">
							<span>
								You've blocked @{creator.username}. Neither of you will see the other around
								Anthers, and you're no longer following each other. You can undo this in Settings.
							</span>
						</div>
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

			{/* Confirmed, because it changes what BOTH people see and because this page
			    stops resolving afterwards — the undo lives in Settings, so the copy says
			    where it is rather than leaving someone stuck. Deliberately says nothing
			    about the other person being told, because they aren't. */}
			{confirmingBlock && (
				<div className="modal modal-open">
					<div className="modal-box">
						<h3 className="text-lg font-bold">Block @{creator.username}?</h3>
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
				</div>
			)}

			{reporting && (
				<ReportDialog
					subjectType="user"
					subjectId={creator.id}
					label={`@${creator.username}`}
					onClose={() => setReporting(false)}
				/>
			)}
		</div>
	);
}
