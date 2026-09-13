// SPDX-License-Identifier: Apache-2.0
/**
 * The Dashboard's standing panels, and the control that arranges them.
 *
 * 🚨 **Everything here is optional by construction, and that is the line.** The Dashboard's
 * worklist sits above these and is composed by the system: payout setup blocks every release
 * a creator will ever attempt, and a released-but-locked Work is invisible from their own
 * side of the glass, so a warning a creator can remove is one that will be removed by exactly
 * the person it was for. **If a panel ever needs to say something is WRONG, it belongs in
 * `buildWorklist` instead.**
 *
 * ⚠️ **Show/hide and reorder, deliberately — not a grid.** No layout engine, no collision or
 * resize handling, no responsive reflow rules, and no migration story when a panel is
 * retired. What a creator actually wants from a customizable dashboard is to hide the thing
 * they do not care about and put theirs first, and that is a list with toggles and arrows.
 */

import { hiddenStudioPanels, STUDIO_PANELS, type StudioPanel } from "@anthers/shared/studio-panels";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XMarkIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { postUrl } from "../../lib/postUrl";
import { Link } from "../../lib/router";
import { studioUrl } from "../../lib/studio";
import type { CreatorEarnings, PostListItem, Project, Work } from "../../lib/types";
import { accessState } from "./work-state";

export const PANEL_LABELS: Record<StudioPanel, string> = {
	earnings: "Earnings",
	catalog: "Catalog",
	projects: "Projects",
	posts: "Posts",
};

export interface PanelData {
	earnings: CreatorEarnings | null;
	works: Work[];
	projects: Project[];
	posts: PostListItem[];
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="rounded-lg border border-base-300 bg-base-100 p-4">
			<h2 className="mb-3 text-sm font-semibold">{title}</h2>
			{children}
		</section>
	);
}

/** A number with its own label, for the count grids below. */
function Stat({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div>
			<div className="text-xs uppercase text-base-content/50">{label}</div>
			<div className="text-xl font-bold">{value}</div>
		</div>
	);
}

export function StudioPanelBody({ panel, data }: { panel: StudioPanel; data: PanelData }) {
	switch (panel) {
		case "earnings":
			return (
				<Panel title="Earnings">
					{data.earnings && parseFloat(data.earnings.total) > 0 ? (
						<>
							<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
								<Stat label="Pool Income" value={`$${data.earnings.poolTotal}`} />
								<Stat label="Support Income" value={`$${data.earnings.seedTotal}`} />
								<Stat label="Total" value={`$${data.earnings.total}`} />
								<Stat label="Supporters" value={data.earnings.subscriberCount} />
							</div>
							{data.earnings.cycle && (
								<p className="mt-2 text-xs text-base-content/50">
									Cycle:{" "}
									{new Date(data.earnings.cycle).toLocaleDateString("en-US", {
										month: "long",
										year: "numeric",
									})}
								</p>
							)}
						</>
					) : (
						<p className="text-sm text-base-content/60">
							Nothing has come in yet. Earnings appear here once somebody supports you or spends
							time with a Public Access Work.
						</p>
					)}
				</Panel>
			);

		case "catalog": {
			const released = data.works.filter((w) => w.visibility === "released");
			const publicAccess = released.filter((w) => accessState(w) === "public-access");
			return (
				<Panel title="Catalog">
					<div className="grid grid-cols-3 gap-4">
						<Stat label="Works" value={data.works.length} />
						<Stat label="Released" value={released.length} />
						<Stat label="Public Access" value={publicAccess.length} />
					</div>
					<Link to={studioUrl("/catalog")} className="link link-primary mt-3 inline-block text-sm">
						Open your Catalog
					</Link>
				</Panel>
			);
		}

		case "projects":
			return (
				<Panel title="Projects">
					{data.projects.length === 0 ? (
						<p className="text-sm text-base-content/60">
							No Projects yet. A Project is a shelf — an album and its tracks, a game and its
							devlogs.
						</p>
					) : (
						<ul className="flex flex-col gap-1 text-sm">
							{data.projects.slice(0, 5).map((p) => (
								<li key={p.id} className="flex items-center justify-between gap-2">
									<Link
										to={studioUrl(`/projects/${p.slug}/edit`)}
										className="link link-hover truncate"
									>
										{p.title}
									</Link>
									<span
										className={`badge badge-xs ${p.isPublished ? "badge-success" : "badge-warning"}`}
									>
										{p.isPublished ? "Published" : "Draft"}
									</span>
								</li>
							))}
						</ul>
					)}
				</Panel>
			);

		case "posts": {
			const drafts = data.posts.filter((p) => !p.isPublished);
			return (
				<Panel title="Posts">
					{data.posts.length === 0 ? (
						<p className="text-sm text-base-content/60">
							No posts yet. A post announces — it carries no access of its own.
						</p>
					) : (
						<>
							<div className="grid grid-cols-2 gap-4">
								<Stat label="Published" value={data.posts.length - drafts.length} />
								<Stat label="Unpublished" value={drafts.length} />
							</div>
							<ul className="mt-3 flex flex-col gap-1 text-sm">
								{data.posts.slice(0, 3).map((p) => (
									<li key={p.id} className="truncate">
										<Link to={postUrl(p)} className="link link-hover">
											{p.title || "Untitled"}
										</Link>
									</li>
								))}
							</ul>
						</>
					)}
				</Panel>
			);
		}
	}
}

interface ArrangeProps {
	shown: StudioPanel[];
	onChange: (next: StudioPanel[]) => void;
	onDone: () => void;
}

/**
 * The arrange control: one row per shown panel with up, down and remove, plus a menu of the
 * ones that are off.
 *
 * ⚠️ **The menu is in canonical order rather than the order they were removed in**, so two
 * creators who hid the same panels see the same menu. `hiddenStudioPanels` owns that.
 */
export function ArrangePanels({ shown, onChange, onDone }: ArrangeProps) {
	const hidden = hiddenStudioPanels(shown);

	const move = (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= shown.length) return;
		const next = [...shown];
		[next[index], next[target]] = [next[target], next[index]];
		onChange(next);
	};

	return (
		<div className="rounded-lg border border-base-300 bg-base-200/40 p-4">
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-sm font-semibold">Arrange your Dashboard</h2>
				<button type="button" className="btn btn-ghost btn-xs" onClick={onDone}>
					Done
				</button>
			</div>

			{shown.length === 0 ? (
				<p className="mb-3 text-sm text-base-content/60">
					Every panel is off. What needs your attention still shows above — that part is always
					here.
				</p>
			) : (
				<ul className="mb-3 flex flex-col gap-1">
					{shown.map((panel, i) => (
						<li
							key={panel}
							className="flex items-center gap-2 rounded border border-base-300 bg-base-100 px-3 py-1.5"
						>
							<span className="flex-1 text-sm">{PANEL_LABELS[panel]}</span>
							<button
								type="button"
								className="btn btn-ghost btn-xs btn-square"
								onClick={() => move(i, -1)}
								disabled={i === 0}
								aria-label={`Move ${PANEL_LABELS[panel]} up`}
							>
								<ArrowUpIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs btn-square"
								onClick={() => move(i, 1)}
								disabled={i === shown.length - 1}
								aria-label={`Move ${PANEL_LABELS[panel]} down`}
							>
								<ArrowDownIcon className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs btn-square text-error"
								onClick={() => onChange(shown.filter((p) => p !== panel))}
								aria-label={`Remove ${PANEL_LABELS[panel]}`}
							>
								<XMarkIcon className="h-4 w-4" />
							</button>
						</li>
					))}
				</ul>
			)}

			{hidden.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-xs text-base-content/50">Add:</span>
					{hidden.map((panel) => (
						<button
							key={panel}
							type="button"
							className="btn btn-outline btn-xs"
							onClick={() => onChange([...shown, panel])}
						>
							<PlusIcon className="h-3 w-3" />
							{PANEL_LABELS[panel]}
						</button>
					))}
				</div>
			)}

			{hidden.length === 0 && shown.length === STUDIO_PANELS.length && (
				<p className="text-xs text-base-content/50">Every panel is on.</p>
			)}
		</div>
	);
}
