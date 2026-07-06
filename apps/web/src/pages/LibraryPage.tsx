// SPDX-License-Identifier: AGPL-3.0-or-later

import { postUrl } from "@anthers/web-shared/postUrl";
import { client } from "@anthers/web-shared/rpc";
import type { Purchase } from "@anthers/web-shared/types";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import {
	MusicalNoteIcon,
	PencilSquareIcon,
	PlayIcon,
	PuzzlePieceIcon,
	RectangleStackIcon,
	VideoCameraIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

const MEDIA_TABS = [
	{ id: "", label: "All", icon: RectangleStackIcon },
	{ id: "game", label: "Games", icon: PuzzlePieceIcon },
	{ id: "audio", label: "Music", icon: MusicalNoteIcon },
	{ id: "video", label: "Video", icon: VideoCameraIcon },
	{ id: "text", label: "Writing", icon: PencilSquareIcon },
] as const;

export default function LibraryPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const [purchases, setPurchases] = useState<Purchase[]>([]);
	const [loading, setLoading] = useState(true);

	const activeTab = searchParams.get("type") ?? "";

	useEffect(() => {
		client.api.payments.purchases
			.$get()
			.then((res) => res.json())
			.then((data) => setPurchases((data as { purchases: Purchase[] }).purchases))
			.catch(() => {})
			.finally(() => setLoading(false));
	}, []);

	const setTab = (id: string) => {
		if (id) {
			setSearchParams({ type: id }, { replace: true });
		} else {
			setSearchParams({}, { replace: true });
		}
	};

	// Filter purchases by the purchased post's content type.
	const filteredPurchases = activeTab
		? purchases.filter((p) => p.post?.contentType === activeTab)
		: purchases;

	if (loading) {
		return (
			<div className="flex justify-center items-center min-h-[60vh]">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-2">Library</h1>
			<p className="text-base-content/60 text-sm mb-6">
				Your purchased projects and saved content, organized by media type.
			</p>

			{/* Media type tabs */}
			<div className="tabs tabs-boxed mb-6 w-fit">
				{MEDIA_TABS.map((tab) => (
					<button
						key={tab.id}
						type="button"
						className={`tab tab-sm gap-1.5 ${activeTab === tab.id ? "tab-active" : ""}`}
						onClick={() => setTab(tab.id)}
					>
						<tab.icon className="w-4 h-4" />
						{tab.label}
						{tab.id === "" && purchases.length > 0 && (
							<span className="badge badge-xs">{purchases.length}</span>
						)}
					</button>
				))}
			</div>

			{/* Tab-specific scaffolding */}
			{activeTab === "audio" && filteredPurchases.length > 0 && (
				<div className="bg-base-200/50 rounded-lg p-4 mb-6 flex items-center gap-3">
					<PlayIcon className="w-5 h-5 text-primary" />
					<p className="text-sm text-base-content/60">
						Music player integration coming soon. You'll be able to queue and play your music
						library directly from here.
					</p>
				</div>
			)}

			{activeTab === "game" && filteredPurchases.length > 0 && (
				<div className="bg-base-200/50 rounded-lg p-4 mb-6 flex items-center gap-3">
					<PuzzlePieceIcon className="w-5 h-5 text-primary" />
					<p className="text-sm text-base-content/60">
						Install tracking and download management coming soon.
					</p>
				</div>
			)}

			{/* Content */}
			{filteredPurchases.length === 0 ? (
				<EmptyState
					title={
						activeTab
							? `No ${MEDIA_TABS.find((t) => t.id === activeTab)?.label.toLowerCase()} in your library`
							: "Your library is empty"
					}
					description={
						activeTab
							? `You haven't purchased any ${MEDIA_TABS.find((t) => t.id === activeTab)?.label.toLowerCase()} yet.`
							: "Purchase or save content to build your library."
					}
					action={
						<Link to="/discover" className="btn btn-primary btn-sm">
							Discover Content
						</Link>
					}
				/>
			) : (
				<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
					{filteredPurchases.map((purchase) => (
						<Link
							key={purchase.id}
							to={
								purchase.post?.publicId != null
									? postUrl({ slug: purchase.post.slug, publicId: purchase.post.publicId })
									: `/posts/${purchase.post?.slug}`
							}
							className="card bg-base-200 hover:shadow-lg transition-shadow"
						>
							{purchase.post?.coverImage ? (
								<figure>
									<img
										src={purchase.post.coverImage}
										alt={purchase.post?.title ?? ""}
										className="w-full h-40 object-cover"
									/>
								</figure>
							) : (
								<div className="w-full h-40 bg-base-300 flex items-center justify-center">
									<span className="text-base-content/30 text-sm">No cover</span>
								</div>
							)}
							<div className="card-body p-4">
								<h2 className="card-title text-sm">{purchase.post?.title}</h2>
								<p className="text-xs text-base-content/60">
									Purchased {new Date(purchase.createdAt).toLocaleDateString()}
								</p>
							</div>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
