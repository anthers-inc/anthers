// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The creator's content library: a grid of their reusable content items (video, audio,
 * image, game, software, physical, service). Each item OWNS its media, downloadable
 * builds, and transcodes; posts reference items rather than owning media. From here a
 * creator uploads new content, edits an item (title/description/thumbnail + builds), and
 * deletes items. Processing state is derived from each item's latest transcode and polled
 * while anything is still encoding.
 */
import { PlusIcon, RectangleStackIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import ContentItemCard from "../components/content/ContentItemCard";
import ContentItemEditor from "../components/content/ContentItemEditor";
import { processingState } from "../components/content/contentItems";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { client } from "../lib/rpc";
import type { ContentItem } from "../lib/types";

export default function ContentLibraryPage() {
	const [items, setItems] = useState<ContentItem[]>([]);
	const [loading, setLoading] = useState(true);

	// Editor: null = closed; { item: null } = create; { item } = edit.
	const [editor, setEditor] = useState<{ item: ContentItem | null } | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<ContentItem | null>(null);
	const [deleting, setDeleting] = useState(false);

	const fetchItems = () =>
		client.api.content["content-items"]
			.$get({ query: { mine: "true" } })
			.then(async (res) => {
				if (!res.ok) return { items: [] as ContentItem[] };
				return (await res.json()) as unknown as { items: ContentItem[] };
			})
			.then((data) => setItems(data.items))
			.catch(() => setItems([]));

	useEffect(() => {
		fetchItems().finally(() => setLoading(false));
	}, []);

	// Poll while any item is still processing so its badge/players settle without a refresh.
	const anyProcessing = items.some((i) => processingState(i) === "processing");
	useEffect(() => {
		if (!anyProcessing) return;
		const interval = setInterval(fetchItems, 4000);
		return () => clearInterval(interval);
	}, [anyProcessing]);

	const upsert = (item: ContentItem) =>
		setItems((prev) =>
			prev.some((i) => i.id === item.id)
				? prev.map((i) => (i.id === item.id ? item : i))
				: [item, ...prev],
		);

	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setDeleting(true);
		try {
			const res = await client.api.content["content-items"][":id"].$delete({
				param: { id: String(deleteTarget.id) },
			});
			if (res.ok) setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
		} finally {
			setDeleting(false);
			setDeleteTarget(null);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-16">
				<LoadingSpinner size="lg" />
			</div>
		);
	}

	return (
		<div className="max-w-7xl mx-auto px-4 py-8">
			<div className="flex items-center justify-between mb-8">
				<h1 className="text-2xl font-bold">Content Library</h1>
				<button
					type="button"
					className="btn btn-primary btn-sm"
					onClick={() => setEditor({ item: null })}
				>
					<PlusIcon className="w-4 h-4" /> Upload content
				</button>
			</div>

			{items.length === 0 ? (
				<EmptyState
					icon={<RectangleStackIcon className="w-12 h-12" />}
					title="Your library is empty"
					description="Upload video, audio, images, games, software, or list physical goods and services. Then reference them from your posts."
					action={
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => setEditor({ item: null })}
						>
							<PlusIcon className="w-4 h-4" /> Upload content
						</button>
					}
				/>
			) : (
				<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
					{items.map((item) => (
						<ContentItemCard
							key={item.id}
							item={item}
							onEdit={(it) => setEditor({ item: it })}
							onDelete={(it) => setDeleteTarget(it)}
						/>
					))}
				</div>
			)}

			{editor && (
				<ContentItemEditor
					item={editor.item}
					onClose={() => setEditor(null)}
					onSaved={(item) => {
						upsert(item);
						setEditor(null);
					}}
				/>
			)}

			{deleteTarget && (
				<div className="modal modal-open" role="dialog">
					<div className="modal-box">
						<h3 className="font-bold text-lg">Delete content?</h3>
						<p className="py-3 text-sm text-base-content/70">
							"{deleteTarget.title || "Untitled"}" and its media, builds, and transcodes will be
							permanently removed. Posts that reference it will lose this content.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setDeleteTarget(null)}
								disabled={deleting}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDelete}
								disabled={deleting}
							>
								{deleting ? "Deleting…" : "Delete"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setDeleteTarget(null)}
						aria-label="Close"
					>
						close
					</button>
				</div>
			)}
		</div>
	);
}
