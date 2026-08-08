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
import WorkCard from "../components/content/WorkCard";
import WorkEditor from "../components/content/WorkEditor";
import { processingState } from "../components/content/works";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { client } from "../lib/rpc";
import type { Work } from "../lib/types";

/** A post referencing a library item, as returned by the 409 `work_in_use` body. */
interface UsingPost {
	slug: string;
	title: string | null;
	isPublished: boolean;
}

export default function CatalogPage() {
	const [items, setItems] = useState<Work[]>([]);
	const [loading, setLoading] = useState(true);

	// Editor: null = closed; { item: null } = create; { item } = edit.
	const [editor, setEditor] = useState<{ item: Work | null } | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<Work | null>(null);
	const [deleting, setDeleting] = useState(false);
	/** Posts blocking an unflagged delete — non-null once the server has named them. */
	const [inUse, setInUse] = useState<UsingPost[] | null>(null);
	/** Completed purchases of this Work; null until the preflight answers. */
	const [sold, setSold] = useState<number | null>(null);

	const fetchItems = () =>
		client.api.content.works
			.$get()
			.then(async (res) => {
				if (!res.ok) return { works: [] as Work[] };
				return (await res.json()) as unknown as { works: Work[] };
			})
			.then((data) => setItems(data.works))
			.catch(() => setItems([]));

	useEffect(() => {
		fetchItems().finally(() => setLoading(false));
	}, []);

	// Catch up whenever the tab comes back into view — cheap, and it covers the case
	// where processing finished while the creator was looking at something else.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchItems only closes over setItems
	useEffect(() => {
		const onVisible = () => {
			if (!document.hidden) fetchItems();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, []);

	// Poll while any item is still processing so its badge/players settle without a
	// refresh. Ticks are skipped while the tab is hidden — the visibility listener above
	// catches up on return, so nothing is missed and a backgrounded tab isn't polling.
	const anyProcessing = items.some((i) => processingState(i) === "processing");
	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchItems only closes over setItems
	useEffect(() => {
		if (!anyProcessing) return;
		const interval = setInterval(() => {
			if (!document.hidden) fetchItems();
		}, 4000);
		return () => clearInterval(interval);
	}, [anyProcessing]);

	const upsert = (item: Work) =>
		setItems((prev) =>
			prev.some((i) => i.id === item.id)
				? prev.map((i) => (i.id === item.id ? item : i))
				: [item, ...prev],
		);

	/**
	 * Open the delete dialog, asking the server which posts use this item FIRST so the
	 * warning arrives before the decision rather than after it. Best-effort: if the
	 * preview call fails the dialog still opens, and the server's 409 remains the
	 * backstop that makes the destructive path impossible to take blind.
	 */
	const openDelete = async (item: Work) => {
		setDeleteTarget(item);
		setInUse(null);
		setSold(null);
		try {
			const res = await client.api.content.works[":id"].usage.$get({
				param: { id: String(item.id) },
			});
			if (res.ok) {
				const body = (await res.json()) as { posts: UsingPost[]; purchaseCount?: number };
				setInUse(body.posts ?? []);
				setSold(body.purchaseCount ?? 0);
			}
		} catch {
			// Preview is best-effort — the 409 still catches it on submit.
		}
	};

	/**
	 * Delete, forcing only once the creator has been shown what it costs.
	 *
	 * Two things can block an unflagged delete — posts referencing the Work, and people
	 * having bought it — and `force` overrides both, so it may only be sent when the
	 * dialog is actually displaying the corresponding warning.
	 */
	const confirmDelete = async () => {
		if (!deleteTarget) return;
		setDeleting(true);
		try {
			// Force once the dialog is actually SHOWING a warning — either one. Keyed on the
			// warnings being non-empty rather than merely fetched, because the preflight
			// populates both with "nothing here" for a clean item, and treating that as
			// confirmation would send `force` on every delete and defeat the server guard.
			const warned = (inUse && inUse.length > 0) || (sold !== null && sold > 0);
			const res = await client.api.content.works[":id"].$delete({
				param: { id: String(deleteTarget.id) },
				query: warned ? { force: "1" } : {},
			});
			if (res.ok) {
				// 204 = deleted, so drop it. 200 = WITHDRAWN, which means the Work is still
				// there in a different state — refetch rather than remove, or the row would
				// reappear on the next load and read as a delete that failed.
				if (res.status === 204) {
					setItems((prev) => prev.filter((i) => i.id !== deleteTarget.id));
				} else {
					await fetchItems();
				}
				setDeleteTarget(null);
				setInUse(null);
				setSold(null);
				return;
			}
			if (res.status === 409) {
				const body = (await res.json()) as {
					code?: string;
					posts?: UsingPost[];
					purchaseCount?: number;
				};
				// `work_in_use`, not `item_in_use` — the server renamed this code with the
				// Catalog rename and this branch was never updated, so the in-use 409 fell
				// through to the silent close below and the dialog just vanished.
				if (body.code === "work_in_use") {
					setInUse(body.posts ?? []);
					return;
				}
				if (body.code === "work_purchased") {
					setSold(body.purchaseCount ?? 0);
					return;
				}
			}
			setDeleteTarget(null);
		} finally {
			setDeleting(false);
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
						<WorkCard
							key={item.id}
							item={item}
							onEdit={(it) => setEditor({ item: it })}
							onDelete={(it) => openDelete(it)}
						/>
					))}
				</div>
			)}

			{editor && (
				<WorkEditor
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
						<h3 className="font-bold text-lg">
							{sold !== null && sold > 0 ? "Withdraw this work?" : "Delete content?"}
						</h3>
						<p className="py-3 text-sm text-base-content/70">
							{sold !== null && sold > 0
								? `"${deleteTarget.title || "Untitled"}" will be taken out of public circulation.`
								: `"${deleteTarget.title || "Untitled"}" and its media, builds, and transcodes will be permanently removed.`}
						</p>
						{sold !== null && sold > 0 && (
							<div className="alert alert-warning text-sm mb-2">
								<div>
									<p className="font-medium">
										{sold} {sold === 1 ? "person has" : "people have"} bought this.
									</p>
									<p className="mt-1">
										It leaves your Catalog and public view and can no longer be bought.{" "}
										{sold === 1 ? "The person who" : "People who"} already paid keep access to it.
									</p>
								</div>
							</div>
						)}
						{inUse && inUse.length > 0 && (
							<div className="alert alert-warning text-sm">
								<div>
									<p className="font-medium">
										Used by {inUse.length} post{inUse.length === 1 ? "" : "s"} — deleting it removes
										this content from {inUse.length === 1 ? "it" : "them"}:
									</p>
									<ul className="list-disc list-inside mt-1">
										{inUse.map((p) => (
											<li key={p.slug}>
												{p.title || "Untitled"}
												{p.isPublished ? " (published)" : " (draft)"}
											</li>
										))}
									</ul>
								</div>
							</div>
						)}
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => {
									setDeleteTarget(null);
									setInUse(null);
									setSold(null);
								}}
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
								{deleting
									? sold !== null && sold > 0
										? "Withdrawing…"
										: "Deleting…"
									: (inUse && inUse.length > 0) || (sold !== null && sold > 0)
										? sold !== null && sold > 0
											? "Withdraw"
											: "Delete anyway"
										: "Delete"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => {
							setDeleteTarget(null);
							setInUse(null);
							setSold(null);
						}}
						aria-label="Close"
					>
						close
					</button>
				</div>
			)}
		</div>
	);
}
