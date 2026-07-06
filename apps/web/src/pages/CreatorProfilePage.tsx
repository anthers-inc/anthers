// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { client } from "@anthers/web-shared/rpc";
import type {
	CreatorGate,
	CreatorStatus,
	PostListItem,
	Project,
	PublicUser,
} from "@anthers/web-shared/types";
import FormField from "@anthers/web-shared/ui/FormField";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	CameraIcon,
	CheckCircleIcon,
	LinkIcon,
	LockClosedIcon,
	LockOpenIcon,
	MapPinIcon,
	PencilIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import ContentCard from "../components/cards/ContentCard";
import ProjectCard from "../components/cards/ProjectCard";
import EmptyState from "../components/ui/EmptyState";

const apiBase =
	window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

type Tab = "all" | "games" | "videos" | "audio" | "writing" | "tiers" | "about";

const TIER_THRESHOLDS: { id: string; name: string; price: number }[] = [
	{ id: "root", name: "Root", price: 3 },
	{ id: "sprout", name: "Sprout", price: 7 },
	{ id: "petal", name: "Petal", price: 15 },
	{ id: "bloom", name: "Bloom", price: 30 },
];

function tierNameFor(id: string): string {
	return id.charAt(0).toUpperCase() + id.slice(1) || "Free";
}

/** Resolve display access for a post from its per-viewer AccessResult. */
function isPostAccessible(
	post: PostListItem,
	isOwnProfile: boolean,
): { accessible: boolean; reason: string } {
	if (isOwnProfile) return { accessible: true, reason: "creator" };
	const access = post.access;
	if (!access || access.canAccess) return { accessible: true, reason: access?.reason ?? "free" };
	return {
		accessible: false,
		reason: access.requiresPurchase ? "payment_required" : "gate_locked",
	};
}

/* ------------------------------------------------------------------ */
/*  Gated content wrapper                                              */
/* ------------------------------------------------------------------ */

function GatedContentWrapper({
	children,
	post,
	access,
}: {
	children: React.ReactNode;
	post: PostListItem;
	access: { accessible: boolean; reason: string };
}) {
	const isLocked = !access.accessible;
	const isFree = post.access?.isFree ?? true;

	// Freely accessible content renders without any lock chrome.
	if (!isLocked && isFree) return <>{children}</>;

	let lockLabel = "";
	if (isLocked) {
		lockLabel =
			post.access?.requiresPurchase && post.access.price ? `$${post.access.price}` : "Gated";
	}

	return (
		<div className="relative group">
			{/* Content (blurred if locked) */}
			<div className={isLocked ? "blur-[2px] opacity-60 pointer-events-none select-none" : ""}>
				{children}
			</div>

			{/* Badge overlay */}
			<div className="absolute top-2 right-2 z-10">
				{isLocked ? (
					<div className="badge badge-sm gap-1 bg-base-300/90 border-base-content/20">
						<LockClosedIcon className="w-3 h-3" />
						{lockLabel || "Locked"}
					</div>
				) : (
					<div className="badge badge-sm gap-1 bg-success/20 border-success/40 text-success">
						<LockOpenIcon className="w-3 h-3" />
						Unlocked
					</div>
				)}
			</div>

			{/* Click-through overlay for locked content */}
			{isLocked && (
				<div className="absolute inset-0 flex items-center justify-center z-10 cursor-default">
					<div className="bg-base-300/90 rounded-lg px-4 py-2 text-center">
						<LockClosedIcon className="w-5 h-5 mx-auto mb-1 text-base-content/50" />
						<p className="text-xs text-base-content/60">{lockLabel || "Locked content"}</p>
					</div>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Tiers tab                                                          */
/* ------------------------------------------------------------------ */

function TiersTab({
	gates,
	unlockedGates,
	userTier,
	userBoost,
	creatorName,
}: {
	gates: CreatorGate[];
	unlockedGates: number[];
	userTier: string;
	userBoost: string;
	creatorName: string;
}) {
	const anthersTierGates = gates.filter((g) => g.gateType === "anthers_tier");
	const boostGates = gates.filter((g) => g.gateType === "boost");
	const unlockedSet = new Set(unlockedGates);

	if (gates.length === 0) {
		return (
			<EmptyState
				title="No tiers configured"
				description={`${creatorName} hasn't set up any content tiers yet. All content is publicly available.`}
			/>
		);
	}

	return (
		<div className="max-w-2xl space-y-8">
			{/* User's current status */}
			{userTier !== "free" && (
				<div className="card bg-base-200">
					<div className="card-body py-3 px-4">
						<div className="flex items-center justify-between text-sm">
							<span className="text-base-content/60">Your status with {creatorName}</span>
							<div className="flex items-center gap-2">
								<span className="badge badge-sm badge-outline">{tierNameFor(userTier)}</span>
								{parseFloat(userBoost) > 0 && (
									<span className="badge badge-sm badge-primary badge-outline">
										${userBoost} boost
									</span>
								)}
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Anthers Tiers */}
			{anthersTierGates.length > 0 && (
				<div>
					<h3 className="text-lg font-bold mb-1">Anthers Tiers</h3>
					<p className="text-sm text-base-content/50 mb-3">
						Platform-wide tiers based on your Anthers subscription level.
					</p>
					<div className="space-y-2">
						{anthersTierGates.map((gate) => {
							const unlocked = unlockedSet.has(gate.id);
							const tierInfo = TIER_THRESHOLDS.find(
								(t) => Number(t.price) === Number(gate.threshold),
							);
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
													<span className="font-medium">{tierInfo?.name ?? gate.label}</span>
													<span className="text-base-content/40 ml-2 text-sm">
														${gate.threshold}/mo
													</span>
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

			{/* Boost Tiers */}
			{boostGates.length > 0 && (
				<div>
					<h3 className="text-lg font-bold mb-1">Boost Tiers</h3>
					<p className="text-sm text-base-content/50 mb-3">
						Custom tiers set by {creatorName}. Boost this creator to unlock.
					</p>
					<div className="space-y-2">
						{boostGates.map((gate) => {
							const unlocked = unlockedSet.has(gate.id);
							const currentBoost = parseFloat(userBoost);
							const threshold = parseFloat(gate.threshold);
							const remaining = Math.max(0, threshold - currentBoost);
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
														${gate.threshold}/mo boost
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
			{userTier === "free" && (
				<div className="card bg-base-200">
					<div className="card-body text-center">
						<p className="text-sm text-base-content/60 mb-2">
							Subscribe to Anthers to start unlocking tiers and supporting {creatorName}.
						</p>
						<Link to="/subscribe" className="btn btn-primary btn-sm mx-auto">
							Choose a Plan
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

export default function CreatorProfilePage() {
	const { username } = useParams<{ username: string }>();
	const { isAuthenticated, user: currentUser, refreshUser } = useAuth();

	const [creator, setCreator] = useState<PublicUser | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [posts, setPosts] = useState<PostListItem[]>([]);
	const [tab, setTab] = useState<Tab>("all");
	const [loading, setLoading] = useState(true);
	const [isFollowing, setIsFollowing] = useState(false);
	const [followerCount, setFollowerCount] = useState(0);
	const [creatorStatus, setCreatorStatus] = useState<CreatorStatus | null>(null);

	const isOwnProfile = currentUser?.username === username;

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
				const uploadRes = await fetch(`${apiBase}/api/content/media-upload/direct`, {
					method: "POST",
					credentials: "include",
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
				const uploadRes = await fetch(`${apiBase}/api/content/media-upload/direct`, {
					method: "POST",
					credentials: "include",
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

			const res = await fetch(`${apiBase}/api/accounts/me`, {
				method: "PATCH",
				credentials: "include",
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
			fetch(`${apiBase}/api/subscriptions/creator-status/${username}`, {
				credentials: "include",
			})
				.then((res) => (res.ok ? res.json() : null))
				.catch(() => null),
		])
			.then(([creatorData, projectData, postData, statusData]) => {
				const userData = creatorData.user;
				setCreator(userData);
				setIsFollowing(userData.isFollowing);
				setFollowerCount(userData.followerCount);
				setProjects(projectData.projects);
				setPosts(postData.posts);
				if (statusData) setCreatorStatus(statusData as CreatorStatus);
			})
			.catch(console.error)
			.finally(() => setLoading(false));
	}, [username]);

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

	// Filter content by tab
	const videoPosts = posts.filter((p) => p.contentType === "video");
	const audioPosts = posts.filter((p) => p.contentType === "audio");
	const textPosts = posts.filter((p) => p.contentType === "text");

	// All tab: interleave projects and posts by date
	const allItems: { type: "project" | "post"; item: Project | PostListItem; date: string }[] = [];
	projects.forEach((p) => {
		allItems.push({ type: "project", item: p, date: p.createdAt });
	});
	posts.forEach((p) => {
		allItems.push({ type: "post", item: p, date: p.createdAt });
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
								<button
									type="button"
									className={`btn ${isFollowing ? "btn-outline" : "btn-primary"}`}
									onClick={handleFollow}
								>
									{isFollowing ? "Following" : "Follow"}
								</button>
								{/* Tier/boost badges */}
								{creatorStatus && creatorStatus.anthersTier !== "free" && (
									<div className="flex items-center gap-2 text-xs">
										<span className="badge badge-sm badge-outline">
											{tierNameFor(creatorStatus.anthersTier)}
										</span>
										{parseFloat(creatorStatus.boostAmount) > 0 && (
											<span className="badge badge-sm badge-primary badge-outline">
												${creatorStatus.boostAmount} boost
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
							["games", `Games (${projects.length})`],
							["videos", `Videos (${videoPosts.length})`],
							["audio", `Audio (${audioPosts.length})`],
							["writing", `Writing (${textPosts.length})`],
							["tiers", "Tiers"],
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
									const post = entry.item as PostListItem;
									const access = isPostAccessible(post, isOwnProfile);
									return (
										<GatedContentWrapper key={`post-${post.id}`} post={post} access={access}>
											<ContentCard post={post} />
										</GatedContentWrapper>
									);
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
								{projects.map((project) => (
									<ProjectCard key={project.id} project={project} />
								))}
							</div>
						) : (
							<EmptyState
								title="No games yet"
								description={`${creator.displayName || creator.username} hasn't published any games.`}
							/>
						))}

					{tab === "videos" &&
						(videoPosts.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{videoPosts.map((post) => {
									const access = isPostAccessible(post, isOwnProfile);
									return (
										<GatedContentWrapper key={post.id} post={post} access={access}>
											<ContentCard post={post} />
										</GatedContentWrapper>
									);
								})}
							</div>
						) : (
							<EmptyState
								title="No videos yet"
								description={`${creator.displayName || creator.username} hasn't published any videos.`}
							/>
						))}

					{tab === "audio" &&
						(audioPosts.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{audioPosts.map((post) => {
									const access = isPostAccessible(post, isOwnProfile);
									return (
										<GatedContentWrapper key={post.id} post={post} access={access}>
											<ContentCard post={post} />
										</GatedContentWrapper>
									);
								})}
							</div>
						) : (
							<EmptyState
								title="No audio yet"
								description={`${creator.displayName || creator.username} hasn't published any audio.`}
							/>
						))}

					{tab === "writing" &&
						(textPosts.length > 0 ? (
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-7xl">
								{textPosts.map((post) => {
									const access = isPostAccessible(post, isOwnProfile);
									return (
										<GatedContentWrapper key={post.id} post={post} access={access}>
											<ContentCard post={post} />
										</GatedContentWrapper>
									);
								})}
							</div>
						) : (
							<EmptyState
								title="No writing yet"
								description={`${creator.displayName || creator.username} hasn't published any articles.`}
							/>
						))}

					{tab === "tiers" && (
						<TiersTab
							gates={creatorStatus?.gates ?? []}
							unlockedGates={creatorStatus?.unlockedGates ?? []}
							userTier={creatorStatus?.anthersTier ?? "free"}
							userBoost={creatorStatus?.boostAmount ?? "0.00"}
							creatorName={creator.displayName || creator.username}
						/>
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
		</div>
	);
}
