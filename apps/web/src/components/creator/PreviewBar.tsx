// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * **Creator preview** — see your own gating the way a reader does.
 *
 * A creator sees everything of theirs unlocked, which is right and also means they have
 * no way to check what they actually built. The alternative, before this, was juggling a
 * second account mid-demo.
 *
 * 🚨 **The state lives in the URL, not in this component**, and that is deliberate: a
 * preview survives a refresh, can be linked to, and — the reason that matters — is
 * *visible*. A hidden mode that quietly changes what a creator sees is how somebody ends
 * up debugging a gate that was never broken.
 *
 * ⚠️ The dial spans **dollars a month**, with the creator's named Badges marked on it —
 * not a list of Badges. A Badge is identified by its threshold and never by its position
 * in a list, and **a gate needn't sit on a Badge at all**: a creator with Badges at $6 and
 * $12 may legally gate a Work at $9, and a picker offering only named rungs could not
 * preview it. (The retired `badgeRank = indexOf` made exactly that mistake in the
 * resolver, and failed toward over-granting.)
 *
 * 🚨 The dial alone is **no longer sufficient**, which is why the rungs became buttons.
 * Thresholds were whole Seeds until 2026-08-16, so every rung was an integer and a
 * whole-step dial reached all of them. In dollars a rung can sit at $9.50, which no step
 * of the dial lands on — so the marks have to be jumpable, not just readable.
 *
 * Nothing here computes access. The server re-resolves with a substituted context through
 * the same `resolveAccessSync` everything else uses, because a preview that reimplemented
 * gate logic would drift and start lying in the one situation it exists to clarify.
 */

import { amountLabel } from "@anthers/shared/constants";
import { useSearchParams } from "@anthers/web-shared/router";
import { EyeIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";

/** One rung of the creator's own ladder, for marking the dial. */
export interface PreviewBadge {
	threshold: number;
	label: string;
}

/**
 * How far the dial goes when a creator has no gates worth speaking of.
 *
 * ⚠️ **Dollars a month, never a count** — a unit change here once turned $18 into $6 without
 * anyone touching the number, when thresholds were re-denominated on 2026-08-16. $12 is
 * the top Anthers Badge, a reasonable reach for a ladder with nothing on it.
 */
const DEFAULT_MAX_SUPPORT = 12;

/**
 * Read the preview out of the URL. Exported so pages can pass it to the API without
 * each one re-deriving the parameter names.
 */
export function usePreviewQuery(): Record<string, string> {
	const [params] = useSearchParams();
	const as = params.get("previewAs");
	const owned = params.get("previewOwned");
	// Memoized on the VALUES, so the object is stable while they are. Returning a fresh
	// literal each render would churn the identity of every `useCallback` that closes over
	// it, and a data-fetching effect downstream would re-run on every render — which is the
	// kind of thing that is invisible until it is a loop.
	return useMemo(() => {
		if (!as) return {};
		return { previewAs: as, ...(owned === "1" ? { previewOwned: "1" } : {}) };
	}, [as, owned]);
}

export default function PreviewBar({ badges = [] }: { badges?: PreviewBadge[] }) {
	const [params, setParams] = useSearchParams();
	const as = params.get("previewAs");
	const owned = params.get("previewOwned") === "1";
	const active = !!as;

	// One rung past the highest Badge, so a creator can always see what sits *above* their
	// top gate as well as on it.
	const maxSupport = Math.max(DEFAULT_MAX_SUPPORT, ...badges.map((b) => b.threshold + 1));
	const support = as && as !== "out" ? Number(as) : 0;
	/** What the slider is showing mid-drag, before it is committed to the URL. */
	const [draft, setDraft] = useState(support);
	// Follow the URL when it changes from anywhere else — a link, the back button, the
	// signed-out/signed-in switch above.
	useEffect(() => setDraft(support), [support]);

	const set = (next: Record<string, string | null>) => {
		const p = new URLSearchParams(params);
		for (const [k, v] of Object.entries(next)) {
			if (v === null) p.delete(k);
			else p.set(k, v);
		}
		setParams(p, { replace: true });
	};

	if (!active) {
		return (
			<button
				type="button"
				onClick={() => set({ previewAs: "out" })}
				className="btn btn-outline btn-sm gap-1.5"
			>
				<EyeIcon className="size-4" />
				Preview as a reader
			</button>
		);
	}

	return (
		<div
			// `status`, not `alert`: it is a persistent mode indicator rather than an
			// interruption, and a screen reader should meet it in reading order.
			role="status"
			className="rounded-box border border-warning/40 bg-warning/10 px-4 py-3"
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
				<span className="flex items-center gap-1.5 text-sm font-semibold">
					<EyeIcon className="size-4" />
					Previewing as a reader
				</span>

				<div className="join">
					<button
						type="button"
						className={`btn btn-xs join-item ${as === "out" ? "btn-active" : ""}`}
						onClick={() => set({ previewAs: "out", previewOwned: null })}
					>
						Signed out
					</button>
					<button
						type="button"
						className={`btn btn-xs join-item ${as !== "out" ? "btn-active" : ""}`}
						onClick={() => set({ previewAs: "0" })}
					>
						Signed in
					</button>
				</div>

				{as !== "out" && (
					<>
						<label className="flex items-center gap-2 text-sm">
							<span className="whitespace-nowrap">{amountLabel(draft)} a month given to you</span>
							{/*
							 * ⚠️ The value is COMMITTED on release, not on every change. A range
							 * input fires `change` on each intermediate value while dragging, and
							 * committing there means a history entry and a server round-trip per
							 * pixel — a request storm behind a control that looks like a slider.
							 * The label tracks the drag so it still feels live.
							 */}
							<input
								type="range"
								min={0}
								max={maxSupport}
								step={1}
								value={draft}
								onChange={(e) => setDraft(Number(e.target.value))}
								onPointerUp={() => set({ previewAs: String(draft) })}
								onKeyUp={() => set({ previewAs: String(draft) })}
								onBlur={() => set({ previewAs: String(draft) })}
								className="range range-xs w-32"
								aria-label="Monthly support given to you"
							/>
						</label>

						{/* The named rungs, as JUMP TARGETS rather than as the dial itself, so a rung
						    the dial cannot land on is still reachable. They were plain text until
						    2026-08-16, beside a comment claiming they made such a rung reachable —
						    true while every threshold was a whole Seed and `step={1}` hit them all,
						    and false the moment thresholds became dollars: $9.50 is on no whole-dollar
						    step, so a creator could not preview their own gate. */}
						{badges.length > 0 && (
							<span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-base-content/60">
								{badges
									.slice()
									.sort((a, b) => a.threshold - b.threshold)
									.map((b) => (
										<button
											type="button"
											key={`${b.label}-${b.threshold}`}
											className="link link-hover"
											onClick={() => {
												setDraft(b.threshold);
												set({ previewAs: String(b.threshold) });
											}}
										>
											{b.label} at {amountLabel(b.threshold)}
										</button>
									))}
							</span>
						)}

						<label className="flex cursor-pointer items-center gap-2 text-sm">
							<input
								type="checkbox"
								className="toggle toggle-sm"
								checked={owned}
								onChange={(e) => set({ previewOwned: e.target.checked ? "1" : null })}
							/>
							Has bought it
						</label>
					</>
				)}

				<button
					type="button"
					onClick={() => set({ previewAs: null, previewOwned: null })}
					className="btn btn-ghost btn-xs ml-auto gap-1"
				>
					<XMarkIcon className="size-3.5" />
					Stop previewing
				</button>
			</div>
		</div>
	);
}
