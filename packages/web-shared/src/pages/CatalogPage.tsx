// SPDX-License-Identifier: Apache-2.0
/**
 * The creator's **Catalog** — where Projects and Works are managed and created.
 *
 * A **Work** OWNS its media, downloadable builds and transcodes, plus its own visibility,
 * dates, delivery switches and access gates; posts merely reference Works. A **Project** is
 * a shelf that groups them and carries no files, prices or gates of its own. Both live here
 * as of 2026-09-11, because the Studio's tabs now divide along Anthers' three objects and
 * Projects had no tab at all — they were a table on the Dashboard, reachable from one
 * button.
 *
 * Processing state is derived from each Work's latest transcode and polled while anything is
 * still encoding.
 *
 * 🚨 **Catalog, not "Library".** Library is a bound term meaning the *user's* own owned
 * content — see the wiki's *How Anthers Talks About Itself*. This page said "Content Library" until 2026-08-13.
 */
import {
	PencilSquareIcon,
	PlusIcon,
	RectangleStackIcon,
	TrashIcon,
} from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import WorkCard from "../components/content/WorkCard";
import { processingState } from "../components/content/works";
import EmptyState from "../components/ui/EmptyState";
import LoadingSpinner from "../components/ui/LoadingSpinner";
import { useAuth } from "../lib/auth";
import { creatorProjectUrl } from "../lib/profile";
import { Link } from "../lib/router";
import { client } from "../lib/rpc";
import { studioEditProjectUrl, studioNewProjectUrl, studioNewWorkUrl } from "../lib/studio";
import type { Project, Work } from "../lib/types";

/** A post referencing a library item, as returned by the 409 `work_in_use` body. */
interface UsingPost {
	slug: string;
	title: string | null;
	isPublished: boolean;
}

export default function CatalogPage() {
	const { user } = useAuth();
	const [items, setItems] = useState<Work[]>([]);
	const [projects, setProjects] = useState<Project[]>([]);
	const [loading, setLoading] = useState(true);

	/**
	 * Project pending deletion. Milder than deleting a Work: `project_posts.projectId`
	 * cascades, so only the MEMBERSHIP rows go and every post and Work inside survives on the
	 * creator's profile. There is nothing to purge, so offering a media checkbox here would
	 * imply a destructiveness this action does not have.
	 */
	const [projectDeleteTarget, setProjectDeleteTarget] = useState<Project | null>(null);
	const [deletingProject, setDeletingProject] = useState(false);

	const [deleteTarget, setDeleteTarget] = useState<Work | null>(null);
	const [deleting, setDeleting] = useState(false);
	/** Posts blocking an unflagged delete — non-null once the server has named them. */
	const [inUse, setInUse] = useState<UsingPost[] | null>(null);
	/** Completed purchases of this Work; null until the preflight answers. */
	const [sold, setSold] = useState<number | null>(null);
	/** Work id whose visibility flip is in flight, so only its own button disables. */
	const [releasing, setReleasing] = useState<number | null>(null);
	/** A refused release, kept beside the grid — the server's reason, not a generic one. */
	const [releaseError, setReleaseError] = useState<string | null>(null);

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
		let live = true;
		client.api.content.projects
			.$get({ query: { mine: "true" } })
			.then((res) => res.json())
			.then((data) => {
				if (live) setProjects((data as { projects: Project[] }).projects ?? []);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		fetchItems().finally(() => setLoading(false));
	}, []);

	const confirmDeleteProject = async () => {
		if (!projectDeleteTarget) return;
		setDeletingProject(true);
		try {
			const res = await client.api.content.projects[":slug"].$delete({
				param: { slug: projectDeleteTarget.slug },
			});
			if (res.status === 204 || res.ok) {
				setProjects((prev) => prev.filter((p) => p.id !== projectDeleteTarget.id));
				setProjectDeleteTarget(null);
			}
		} finally {
			setDeletingProject(false);
		}
	};

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
	 * Flip a Work between private and released, from the card.
	 *
	 * The server owns the preconditions — media finished encoding, at least one delivery
	 * switch on — and refuses with a specific message when they aren't met. Show that
	 * message: "can't release yet, the media is still processing" is something the creator
	 * can wait out, and a generic failure is not.
	 */
	const setVisibility = async (work: Work, visibility: "private" | "released") => {
		setReleasing(work.id);
		setReleaseError(null);
		try {
			const res = await client.api.content.works[":id"].$patch({
				param: { id: String(work.id) },
				json: { visibility },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setReleaseError(body?.error || "Couldn't change this Work's visibility.");
				return;
			}
			const { work: updated } = (await res.json()) as unknown as { work: Work };
			upsert(updated);
		} catch {
			setReleaseError("Couldn't change this Work's visibility.");
		} finally {
			setReleasing(null);
		}
	};

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
			<div className="flex flex-wrap items-center justify-between gap-2 mb-8">
				<h1 className="text-2xl font-bold">Catalog</h1>
				<div className="flex gap-2">
					<Link to={studioNewProjectUrl()} className="btn btn-outline btn-sm">
						<PlusIcon className="w-4 h-4" /> New Project
					</Link>
					<Link to={studioNewWorkUrl()} className="btn btn-primary btn-sm">
						<PlusIcon className="w-4 h-4" /> New Work
					</Link>
				</div>
			</div>

			{/* Projects first, because a Project is the shelf the Works below sit on — and
			    because there are always fewer of them, so the grid stays the page's substance. */}
			{projects.length > 0 && (
				<section className="mb-10">
					<h2 className="text-lg font-semibold mb-3">Projects</h2>
					<div className="overflow-x-auto">
						<table className="table table-sm">
							<thead>
								<tr>
									<th>Title</th>
									<th>Status</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{projects.map((project) => (
									<tr key={project.id}>
										<td>
											<Link
												to={creatorProjectUrl(user?.username ?? "", project.slug)}
												className="link link-hover font-medium"
											>
												{project.title}
											</Link>
										</td>
										<td>
											<span
												className={`badge badge-sm ${project.isPublished ? "badge-success" : "badge-warning"}`}
											>
												{project.isPublished ? "Published" : "Draft"}
											</span>
										</td>
										<td className="flex gap-1">
											<Link
												to={studioEditProjectUrl(project.slug)}
												className="btn btn-ghost btn-xs"
												title="Edit"
											>
												<PencilSquareIcon className="w-4 h-4" />
											</Link>
											<button
												type="button"
												className="btn btn-ghost btn-xs text-error"
												title="Delete"
												onClick={() => setProjectDeleteTarget(project)}
											>
												<TrashIcon className="w-4 h-4" />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			)}

			{projects.length > 0 && <h2 className="text-lg font-semibold mb-3">Works</h2>}

			{releaseError && (
				<div className="alert alert-error text-sm mb-4">
					<span>{releaseError}</span>
				</div>
			)}

			{items.length === 0 ? (
				<EmptyState
					icon={<RectangleStackIcon className="w-12 h-12" />}
					title="Your Catalog is empty"
					description="Upload video, audio, images, games, software, or list physical goods and services. Each one is a Work you can release, gate or sell on its own — with or without ever writing a post about it."
					action={
						<div className="flex flex-wrap justify-center gap-2">
							<Link to={studioNewWorkUrl()} className="btn btn-primary btn-sm">
								<PlusIcon className="w-4 h-4" /> New Work
							</Link>
							{projects.length === 0 && (
								<Link to={studioNewProjectUrl()} className="btn btn-ghost btn-sm">
									or start a Project
								</Link>
							)}
						</div>
					}
				/>
			) : (
				<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
					{items.map((item) => (
						<WorkCard
							key={item.id}
							item={item}
							onDelete={(it) => openDelete(it)}
							onSetVisibility={setVisibility}
							busy={releasing === item.id}
						/>
					))}
				</div>
			)}

			{/* Deleting a Project. Says plainly that its contents survive — the whole reason
				this dialog is milder than the Work one below it. */}
			{projectDeleteTarget && (
				<div className="modal modal-open" role="dialog">
					<div className="modal-box">
						<h3 className="text-lg font-bold">
							Delete "{projectDeleteTarget.title || "Untitled"}"?
						</h3>
						<p className="py-3 text-sm text-base-content/70">
							This removes the Project and its ordering.{" "}
							<strong>Nothing inside it is deleted</strong> — the Works stay in your Catalog with
							their access, and the posts stay on your profile. They just stop being grouped here.
							It can't be undone.
						</p>
						<div className="modal-action">
							<button
								type="button"
								className="btn btn-ghost"
								onClick={() => setProjectDeleteTarget(null)}
								disabled={deletingProject}
							>
								Cancel
							</button>
							<button
								type="button"
								className="btn btn-error"
								onClick={confirmDeleteProject}
								disabled={deletingProject}
							>
								{deletingProject ? "Deleting..." : "Delete project"}
							</button>
						</div>
					</div>
					<button
						type="button"
						className="modal-backdrop"
						onClick={() => setProjectDeleteTarget(null)}
						aria-label="Close"
					/>
				</div>
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
