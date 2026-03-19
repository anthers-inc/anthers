import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { client } from "../lib/rpc";
import type { PublicUser, Project, PostListItem } from "../lib/types";
import { useAuth } from "../lib/auth";
import ProjectCard from "../components/cards/ProjectCard";
import ContentCard from "../components/cards/ContentCard";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import EmptyState from "../components/ui/EmptyState";
import FileUpload from "../components/ui/FileUpload";
import FormField from "../components/ui/FormField";
import { LinkIcon, MapPinIcon, PencilIcon, CameraIcon } from "@heroicons/react/24/outline";

const apiBase =
	window.location.hostname === "localhost" ||
	window.location.hostname === "127.0.0.1"
		? "http://localhost:8000"
		: "";

type Tab = "all" | "games" | "videos" | "audio" | "writing" | "about";

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
				const uploadJson = await uploadRes.json() as { url: string };
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
				const uploadJson = await uploadRes.json() as { url: string };
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
					for (const [key, val] of Object.entries(
						data as Record<string, string[]>,
					)) {
						fieldErrors[key] = Array.isArray(val) ? val[0] : String(val);
					}
					setEditErrors(fieldErrors);
					return;
				}
				throw new Error("Failed to save profile.");
			}

			await refreshUser();

			// Re-fetch the profile data to reflect changes
			const creatorRes = await client.api.accounts.users[":username"]
				.$get({ param: { username: username! } })
				.then((r) => r.json());
			const userData = (creatorRes as { user: PublicUser }).user;
			setCreator(userData);
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
			client.api.accounts.users[":username"]
				.$get({ param: { username } })
				.then((res) => res.json()),
			fetch(apiBase + "/api/content/projects?creator=" + username, {
				credentials: "include",
			}).then((res) => res.json()),
			fetch(apiBase + "/api/content/posts?creator=" + username, {
				credentials: "include",
			}).then((res) => res.json()),
		])
			.then(([creatorData, projectData, postData]) => {
				const userData = (creatorData as { user: PublicUser }).user;
				setCreator(userData);
				setIsFollowing(userData.isFollowing);
				setFollowerCount(userData.followerCount);
				setProjects(projectData.projects);
				setPosts(postData.posts);
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
	projects.forEach((p) => allItems.push({ type: "project", item: p, date: p.createdAt }));
	posts.forEach((p) => allItems.push({ type: "post", item: p, date: p.createdAt }));
	allItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

	return (
		<div>
			{/* Header banner */}
			{editing ? (
				<div className="relative w-full h-48 md:h-64 bg-base-300 group">
					{headerPreview ? (
						<img
							src={headerPreview}
							alt="Header"
							className="w-full h-full object-cover"
						/>
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
										{(editDisplayName || creator.username)
											.charAt(0)
											.toUpperCase()}
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
								<p className="text-base-content/60 mb-3">
									@{creator.username}
								</p>
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
								{(creator.displayName || creator.username)
									.charAt(0)
									.toUpperCase()}
							</div>
						)}
						<div className="flex-1 pt-4">
							<h1 className="text-2xl font-bold">
								{creator.displayName || creator.username}
							</h1>
							<p className="text-base-content/60">
								@{creator.username} · {followerCount} followers
							</p>
							{creator.bio && (
								<p className="mt-2 text-sm max-w-2xl">{creator.bio}</p>
							)}
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
								className="btn btn-ghost btn-sm mt-4 sm:mt-12"
								onClick={startEditing}
							>
								<PencilIcon className="w-4 h-4" />
								Edit Profile
							</button>
						)}
						{isAuthenticated && !isOwnProfile && (
							<button
								className={`btn mt-4 sm:mt-12 ${isFollowing ? "btn-outline" : "btn-primary"}`}
								onClick={handleFollow}
							>
								{isFollowing ? "Following" : "Follow"}
							</button>
						)}
					</div>
				)}

				{/* Tabs */}
				<div className="tabs tabs-bordered mb-6 overflow-x-auto">
					{([
						["all", "All"],
						["games", `Games (${projects.length})`],
						["videos", `Videos (${videoPosts.length})`],
						["audio", `Audio (${audioPosts.length})`],
						["writing", `Writing (${textPosts.length})`],
						["about", "About"],
					] as const).map(([key, label]) => (
						<button
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
					{tab === "all" && (
						allItems.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{allItems.map((entry) =>
									entry.type === "project" ? (
										<ProjectCard key={`proj-${entry.item.id}`} project={entry.item as Project} />
									) : (
										<ContentCard key={`post-${entry.item.id}`} post={entry.item as PostListItem} />
									)
								)}
							</div>
						) : (
							<EmptyState
								title="No content yet"
								description={`${creator.displayName || creator.username} hasn't published anything yet.`}
							/>
						)
					)}

					{tab === "games" && (
						projects.length > 0 ? (
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
						)
					)}

					{tab === "videos" && (
						videoPosts.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{videoPosts.map((post) => (
									<ContentCard key={post.id} post={post} />
								))}
							</div>
						) : (
							<EmptyState
								title="No videos yet"
								description={`${creator.displayName || creator.username} hasn't published any videos.`}
							/>
						)
					)}

					{tab === "audio" && (
						audioPosts.length > 0 ? (
							<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
								{audioPosts.map((post) => (
									<ContentCard key={post.id} post={post} />
								))}
							</div>
						) : (
							<EmptyState
								title="No audio yet"
								description={`${creator.displayName || creator.username} hasn't published any audio.`}
							/>
						)
					)}

					{tab === "writing" && (
						textPosts.length > 0 ? (
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-7xl">
								{textPosts.map((post) => (
									<ContentCard key={post.id} post={post} />
								))}
							</div>
						) : (
							<EmptyState
								title="No writing yet"
								description={`${creator.displayName || creator.username} hasn't published any articles.`}
							/>
						)
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
