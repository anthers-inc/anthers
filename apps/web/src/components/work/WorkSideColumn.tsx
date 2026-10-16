// SPDX-License-Identifier: Apache-2.0
/**
 * The Work page's **side column** — Reviews and Showings, one tab group
 * (Parker, 2026-10-13). Reviews is the default tab: a verdict on the work is what the
 * column has always been about, and Showings starts here as its stub — the places this
 * Work can be found, beginning with the creator's profile and any Project carrying it,
 * with the wider machinery (channels, collections, collaborations) stated as to-come
 * rather than promised.
 *
 * 🚨 Same tabs for owner and user, like the Info tabs: the shell does not know who is
 * looking; the contents do.
 */

import { postUrl } from "@anthers/web-shared/postUrl";
import { creatorProjectUrl, profileUrl } from "@anthers/web-shared/profile";
import { Link } from "@anthers/web-shared/router";
import { MegaphoneIcon } from "@heroicons/react/24/outline";
import { type ReactNode, useRef, useState } from "react";
import { keepScroll } from "./scrollKeeper";
import type { WorkDetail } from "./WorkLayout";

export interface SideTab {
	key: string;
	label: string;
	content: ReactNode;
}

export default function WorkSideColumn({ tabs, work }: { tabs: SideTab[]; work: WorkDetail }) {
	const [active, setActive] = useState(tabs[0]?.key ?? "");
	const current = tabs.find((t) => t.key === active) ?? tabs[0];
	/** The group's root, the anchor `keepScroll` measures the page's scroller from. */
	const rootRef = useRef<HTMLElement | null>(null);
	if (!current) return null;

	return (
		<aside ref={rootRef} aria-label="Reviews and showings" className="flex flex-col gap-4">
			<div
				role="tablist"
				aria-label="Reviews and showings"
				className="join rounded-box shadow-[0_2px_6px_0_rgba(0,0,0,0.25)]"
			>
				{tabs.map((tab) => (
					<button
						key={tab.key}
						type="button"
						role="tab"
						aria-selected={tab.key === current.key}
						aria-controls={`work-side-${tab.key}`}
						id={`work-side-button-${tab.key}`}
						className={`btn btn-xs sm:btn-sm join-item flex-1 ${tab.key === current.key ? "btn-active" : ""}`}
						onClick={() => keepScroll(rootRef.current, () => setActive(tab.key))}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id={`work-side-${current.key}`}
				aria-labelledby={`work-side-button-${current.key}`}
			>
				{current.content}
			</div>
			{work.postedIn && work.postedIn.length > 0 && <PostedAbout work={work} />}
		</aside>
	);
}

/**
 * Where this Work has been announced — the posts about it. It lives at the column's foot
 * so announcements never push the reviews a reader came for upward.
 */
function PostedAbout({ work }: { work: WorkDetail }) {
	return (
		<section className="border-t border-base-300 pt-4">
			<h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
				<MegaphoneIcon className="size-4" />
				Posted about
			</h2>
			<ul className="space-y-1.5">
				{work.postedIn
					?.filter((p) => p.isPublished)
					.map((p) => (
						<li key={p.slug}>
							<Link to={postUrl({ slug: p.slug, publicId: 0 })} className="link link-hover text-sm">
								{p.title || p.slug}
							</Link>
						</li>
					))}
			</ul>
		</section>
	);
}

/**
 * The Showings stub body, assembled by the pages that have the facts. Kept beside the
 * shell because its copy is the panel's one voice until the real machinery ships.
 */
export function ShowingsStub({ work }: { work: WorkDetail }) {
	const creator = work.creator;
	const projects = work.shownOn?.projects ?? [];
	return (
		<div className="flex flex-col gap-3">
			{creator && (
				<Link to={profileUrl(creator.handle)} className="link-hover block">
					<Card
						title={creator.displayName || creator.handle || "the creator"}
						subtitle="Creator's profile"
					/>
				</Link>
			)}
			{projects.map((p) => (
				<Link
					key={p.slug}
					to={creatorProjectUrl(creator?.handle ?? "", p.slug)}
					className="link-hover block"
				>
					<Card title={p.title} subtitle="Project" />
				</Link>
			))}
			<p className="text-xs text-base-content/60">
				More Showings are on their way — Anthers TV channels, collections, and the places a Work is
				curated. The places it can already be found are here.
			</p>
		</div>
	);
}

function Card({ title, subtitle }: { title: string; subtitle: string }) {
	return (
		<div className="rounded-box border border-base-300 bg-base-200/40 px-3 py-2.5">
			<p className="text-xs text-base-content/50">{subtitle}</p>
			<p className="text-sm font-medium">{title}</p>
		</div>
	);
}
