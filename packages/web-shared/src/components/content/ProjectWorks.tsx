// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Works on a Project's shelf, as an ordered, reorderable list.
 *
 * Deliberately NOT modeled on `PostWorkLinks`, which looks like the same component and
 * isn't. That one holds form state and saves with the post; membership here has its own
 * endpoints and **persists immediately**, the way the builds section of `WorkEditor` does.
 * The reason is the Project form: a creator adding twelve tracks should not lose them to a
 * failed save on an unrelated field, and a list that persists per-action can't.
 *
 * 🚨 **Edit-only, because every endpoint is keyed on the Project's slug.** There is no
 * Project to attach anything to until it has been created, which is the same shape as
 * "create the Work first, then add downloadable builds".
 *
 * A Project is a shelf: adding a Work here changes nothing about who can open it, and
 * removing it never touches the Work — it stays in the Catalog, released, with its gates.
 */
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { Project, ProjectWork, Work } from "../../lib/types";
import LoadingSpinner from "../ui/LoadingSpinner";
import WorkPicker from "./WorkPicker";
import { itemPreviewUrl, ProcessingBadge, TypeBadge, TypeIcon } from "./works";

export default function ProjectWorks({ projectSlug }: { projectSlug: string }) {
	const [works, setWorks] = useState<ProjectWork[]>([]);
	const [loading, setLoading] = useState(true);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		client.api.content.projects[":slug"]
			.$get({ param: { slug: projectSlug } })
			.then(async (res) => {
				if (!res.ok) return;
				const { project } = (await res.json()) as unknown as { project: Project };
				if (live) setWorks(project.works ?? []);
			})
			.catch(() => {})
			.finally(() => live && setLoading(false));
		return () => {
			live = false;
		};
	}, [projectSlug]);

	const add = async (work: Work) => {
		setPicking(false);
		if (works.some((w) => w.id === work.id)) return; // one membership per Work
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].works.$post({
				param: { slug: projectSlug },
				json: { workId: work.id },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error || "Couldn't add that Work.");
				return;
			}
			// The server assigns the position (max + 1), so mirror that rather than guessing.
			setWorks((prev) => [...prev, { ...(work as ProjectWork), sortOrder: prev.length }]);
		} catch {
			setError("Couldn't add that Work.");
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id: number) => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].works[":workId"].$delete({
				param: { slug: projectSlug, workId: String(id) },
			});
			if (!res.ok) {
				setError("Couldn't remove that Work.");
				return;
			}
			setWorks((prev) => prev.filter((w) => w.id !== id));
		} catch {
			setError("Couldn't remove that Work.");
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Move one Work up or down, persisting the whole order.
	 *
	 * Optimistic, and reverted on failure — the alternative is a list that visibly reorders
	 * and then silently isn't saved, which is the worst of both. The server takes the
	 * complete order rather than a delta, so this sends every id: a partial list would let
	 * an unlisted member keep a position that now collides with an assigned one.
	 */
	const move = async (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= works.length) return;
		const before = works;
		const next = [...works];
		[next[index], next[target]] = [next[target], next[index]];
		setWorks(next.map((w, i) => ({ ...w, sortOrder: i })));
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.content.projects[":slug"].works.reorder.$post({
				param: { slug: projectSlug },
				json: { workIds: next.map((w) => w.id) },
			});
			if (!res.ok) {
				setWorks(before);
				setError("Couldn't save the new order.");
			}
		} catch {
			setWorks(before);
			setError("Couldn't save the new order.");
		} finally {
			setBusy(false);
		}
	};

	if (loading) {
		return (
			<div className="flex justify-center py-6">
				<LoadingSpinner size="sm" />
			</div>
		);
	}

	return (
		<div className="space-y-3">
			{error && (
				<div className="alert alert-error text-sm">
					<span>{error}</span>
				</div>
			)}

			{works.length === 0 && (
				<p className="text-sm text-base-content/60">
					No Works yet. A Project is a shelf — put the album's tracks, the game's builds or the
					chapters of a book on it, and they keep whatever access you already gave them.
				</p>
			)}

			<ul className="space-y-2">
				{works.map((work, i) => {
					const preview = itemPreviewUrl(work);
					return (
						<li
							key={work.id}
							className="flex items-center gap-3 rounded-lg border border-base-300 bg-base-100 p-2"
						>
							<div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-base-200 flex items-center justify-center">
								{preview ? (
									<img src={preview} alt="" className="h-full w-full object-cover" />
								) : (
									<TypeIcon type={work.type} className="w-5 h-5 text-base-content/30" />
								)}
							</div>
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm font-medium">{work.title || "Untitled"}</p>
								<div className="mt-1 flex flex-wrap items-center gap-1">
									<TypeBadge type={work.type} />
									{/*
									 * Visibility only — deliberately NOT the Catalog's `AccessBadge`.
									 *
									 * 🚨 That badge reads `seedAccess`, and this list comes from the
									 * *viewer-facing* serializer, which withholds the creator's access table
									 * on purpose. Using it here reported **"Nobody can open"** for three
									 * Works that were plainly Public Access — a confident, entirely wrong
									 * label, and one no error would ever have surfaced.
									 *
									 * Visibility is the field this endpoint genuinely provides, and it is
									 * also the one that matters while arranging a shelf: a private member is
									 * invisible to everyone but its creator. Gates belong to the Work and
									 * are edited in the Catalog.
									 */}
									{work.visibility !== "released" && (
										<span
											className="badge badge-sm badge-neutral"
											title="Private — nobody but you sees this on the shelf"
										>
											Private
										</span>
									)}
									<ProcessingBadge item={work} />
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => move(i, -1)}
									disabled={busy || i === 0}
									aria-label={`Move ${work.title || "Untitled"} up`}
								>
									<ArrowUpIcon className="w-4 h-4" />
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => move(i, 1)}
									disabled={busy || i === works.length - 1}
									aria-label={`Move ${work.title || "Untitled"} down`}
								>
									<ArrowDownIcon className="w-4 h-4" />
								</button>
								<button
									type="button"
									className="btn btn-ghost btn-xs text-error"
									onClick={() => remove(work.id)}
									disabled={busy}
									aria-label={`Remove ${work.title || "Untitled"}`}
								>
									<XMarkIcon className="w-4 h-4" />
								</button>
							</div>
						</li>
					);
				})}
			</ul>

			<button
				type="button"
				className="btn btn-outline btn-sm"
				onClick={() => setPicking(true)}
				disabled={busy}
			>
				<PlusIcon className="w-4 h-4" /> Add a Work
			</button>

			<p className="text-xs text-base-content/50">
				Changes here save immediately, separately from the rest of this form.
			</p>

			{picking && <WorkPicker onSelect={add} onClose={() => setPicking(false)} />}
		</div>
	);
}
