// SPDX-License-Identifier: Apache-2.0
/**
 * The **Noun emblem picker** — the search-and-place surface inside the Badge Maker.
 *
 * 🚨 **PREVIEW FROM THE SEARCH THUMBNAIL; THE VENDOR'S DOWNLOAD IS TOUCHED ONLY ON SAVE.**
 * Noun Project thumbnails are black-on-transparent, so the picker recolors one client-side
 * with `mask-image` over `background-color` — the same technique `iconDataUri` and
 * `BrandGlyph` already use — and sizes and places it with ordinary CSS. A creator can try
 * two hundred emblems in any color, at any size and position, for the price of the
 * searches that found them. Fetching the real asset on preview would make a browsing
 * creator as expensive as a committing one, and there is no preview-time endpoint to do
 * it with anyway: composing is a save-time, whole-Badge operation.
 *
 * 🚨 **Search results are not cached anywhere** — every search here is a live call, and
 * the debounce (fire on a pause, never per keystroke) and the creator's daily budget are
 * what bound a session. Thumbnails live on the vendor's CDN behind expiring URLs and are
 * **session-only**: they resolve for this authoring session and must never be persisted.
 *
 * ⭐ **The artist credit rides beside every emblem image** — name and link, small subtext,
 * because naming the artist is the decent thing to do and because the credit keeps a
 * creator's Badge usable under CC BY 3.0 independently of Anthers' own license.
 */

import { BADGE_EMBLEM_COLORS, BADGE_PLACEMENT_LIMITS } from "@anthers/shared/badge-art";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/rpc";

/** What the search proxyhands back about one icon. */
export interface NounSearchIcon {
	id: string;
	term: string;
	thumbnailUrl: string | null;
	artistName: string;
	artistPermalink: string | null;
	licenseDescription: string;
	attribution: string;
}

interface SearchResponse {
	icons: NounSearchIcon[];
	nextPage: string | null;
	refused?: boolean;
}

export interface EmblemPlacement {
	nounIcon: NounSearchIcon;
	/** The emblem's injected color, as hex — from the swatch palette. */
	emblemColor: string;
	/** The emblem's size as a fraction of the shape's emblemBox. */
	scale: number;
	/** Offsets as a fraction of the emblem box. */
	offsetX: number;
	offsetY: number;
}

const SEARCH_DEBOUNCE_MS = 450;

/**
 * Render a search thumbnail recolored to `color`, black-on-transparent masked over the
 * color — the technique the whole cost model rests on.
 */
function Thumb({
	icon,
	color,
	className,
	style,
}: {
	icon: NounSearchIcon;
	color: string;
	className?: string;
	style?: React.CSSProperties;
}) {
	if (!icon.thumbnailUrl) return null;
	return (
		<span
			className={`inline-block ${className ?? ""}`}
			style={{
				backgroundColor: color,
				maskImage: `url(${icon.thumbnailUrl})`,
				maskSize: "contain",
				maskRepeat: "no-repeat",
				maskPosition: "center",
				WebkitMaskImage: `url(${icon.thumbnailUrl})`,
				WebkitMaskSize: "contain",
				WebkitMaskRepeat: "no-repeat",
				WebkitMaskPosition: "center",
				...style,
			}}
			aria-hidden="true"
		/>
	);
}

/** The artist byline under an emblem — name, linked when the vendor carries a permalink. */
function Byline({ icon }: { icon: NounSearchIcon }) {
	const name = icon.artistPermalink ? (
		<a
			href={icon.artistPermalink}
			target="_blank"
			rel="noopener noreferrer"
			className="underline decoration-dotted underline-offset-2"
		>
			{icon.artistName}
		</a>
	) : (
		icon.artistName
	);
	return <span className="text-[10px] text-base-content/50">{name} · Noun Project</span>;
}

export function NounEmblemPicker({
	initial,
	onSave,
	onCancel,
	busy,
}: {
	/** The placement already on this rung, when it is being re-edited. */
	initial?: EmblemPlacement | null;
	onSave: (placement: EmblemPlacement) => void;
	onCancel: () => void;
	busy: boolean;
}) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<NounSearchIcon[] | null>(null);
	const [page, setPage] = useState<string | null>(null);
	const [searching, setSearching] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [held, setHeld] = useState<EmblemPlacement | null>(initial ?? null);
	const holdRef = useRef(held);
	holdRef.current = held;

	/**
	 * The debounced live search. 🚨 Fired on a pause, never per keystroke — typing
	 * "wildflower" undebounced is ten service calls instead of one.
	 */
	const runSearch = useCallback(async (q: string, nextPage?: string) => {
		if (!q.trim()) {
			setResults(null);
			setPage(null);
			return;
		}
		setSearching(true);
		setNotice(null);
		try {
			const path = nextPage
				? `/api/noun/search?q=${encodeURIComponent(q)}&page=${encodeURIComponent(nextPage)}`
				: `/api/noun/search?q=${encodeURIComponent(q)}`;
			const res = await apiFetch(path);
			if (res.status === 429) {
				const detail = (await res.json().catch(() => null)) as { code?: string } | null;
				setNotice(
					detail?.code === "vendor_rate_limited"
						? "The icon catalog is busy right now — try again in a moment."
						: "You've reached today's icon-catalog budget. Your saved Badges are unaffected — try again tomorrow.",
				);
				return;
			}
			if (!res.ok) {
				setNotice("The catalog didn't answer — try that search again.");
				return;
			}
			const body = (await res.json()) as SearchResponse;
			if (body.refused) {
				setNotice("That search isn't available here.");
				setResults([]);
				return;
			}
			setResults(body.icons ?? []);
			setPage(body.nextPage ?? null);
		} catch {
			setNotice("The catalog didn't answer — try that search again.");
		} finally {
			setSearching(false);
		}
	}, []);

	// Debounce: reset the timer on every keystroke, fire on the pause.
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [query, runSearch]);

	const moreLikeThis = async (icon: NounSearchIcon) => {
		setSearching(true);
		setNotice(null);
		try {
			const res = await apiFetch(`/api/noun/icons/${icon.id}/similar`);
			if (res.status === 429) {
				setNotice("You've reached today's icon-catalog budget. Your saved Badges are unaffected.");
				return;
			}
			if (!res.ok) {
				setNotice("Couldn't find matches for that one.");
				return;
			}
			const body = (await res.json()) as { icons: NounSearchIcon[] };
			setResults(body.icons ?? []);
			setPage(null);
			// State the feature rather than leaving the context switch unexplained.
			setNotice(`Showing emblems drawn like "${icon.term || "that one"}".`);
		} catch {
			setNotice("Couldn't find matches for that one.");
		} finally {
			setSearching(false);
		}
	};

	const within = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

	const nudge = (dx: number, dy: number) => {
		setHeld((h) =>
			h
				? {
						...h,
						offsetX: within(
							h.offsetX + dx,
							-BADGE_PLACEMENT_LIMITS.offsetMax,
							BADGE_PLACEMENT_LIMITS.offsetMax,
						),
						offsetY: within(
							h.offsetY + dy,
							-BADGE_PLACEMENT_LIMITS.offsetMax,
							BADGE_PLACEMENT_LIMITS.offsetMax,
						),
					}
				: h,
		);
	};

	const zoom = (factor: number) => {
		setHeld((h) =>
			h
				? {
						...h,
						scale: within(
							h.scale * factor,
							BADGE_PLACEMENT_LIMITS.scaleMin,
							BADGE_PLACEMENT_LIMITS.scaleMax,
						),
					}
				: h,
		);
	};

	return (
		<div className="rounded-lg border border-base-300 bg-base-100 p-3">
			<div className="flex gap-2 items-center">
				<input
					type="search"
					className="input input-bordered input-sm flex-1"
					placeholder="Search nearly ten million icons — try “bee”, “wildflower”, “sword”…"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					disabled={busy}
				/>
				{searching && <span className="loading loading-spinner loading-sm" />}
			</div>

			{notice && <p className="mt-2 text-xs text-base-content/70">{notice}</p>}

			{results && results.length > 0 && (
				<div className="mt-2 max-h-64 overflow-y-auto">
					<div className="grid grid-cols-6 gap-2">
						{results.map((icon) => (
							<div key={icon.id} className="flex flex-col items-center gap-0.5">
								<button
									type="button"
									className={`btn btn-sm btn-square ${held?.nounIcon.id === icon.id ? "btn-primary" : "btn-ghost"}`}
									title={`${icon.term} by ${icon.artistName}`}
									onClick={() =>
										setHeld({
											nounIcon: icon,
											emblemColor: held?.emblemColor ?? "#ffffff",
											scale: 1,
											offsetX: 0,
											offsetY: 0,
										})
									}
									disabled={busy}
								>
									<Thumb icon={icon} color="#ffffff" className="h-6 w-6" />
								</button>
								<button
									type="button"
									className="text-[9px] text-base-content/40 hover:text-base-content/70"
									title={`Find emblems drawn like this one`}
									onClick={() => void moreLikeThis(icon)}
									disabled={busy || searching}
								>
									like this
								</button>
							</div>
						))}
					</div>
					{page && (
						<button
							type="button"
							className="btn btn-ghost btn-xs mt-2"
							onClick={() => void runSearch(query, page)}
							disabled={busy || searching}
						>
							More like this search
						</button>
					)}
				</div>
			)}
			{results && results.length === 0 && !searching && !notice && (
				<p className="mt-2 text-xs text-base-content/50">Nothing found for that search.</p>
			)}

			{held && (
				<div className="mt-3 border-t border-base-300 pt-3">
					<div className="mb-2">
						<div className="mb-1 text-xs font-medium text-base-content/60">Emblem color</div>
						<div className="flex flex-wrap items-center gap-1">
							{BADGE_EMBLEM_COLORS.map((c) => (
								<button
									key={c}
									type="button"
									aria-label={`Emblem color ${c}`}
									aria-pressed={held.emblemColor === c}
									className={`h-5 w-5 rounded-full border ${held.emblemColor === c ? "border-primary" : "border-base-300"}`}
									style={{ backgroundColor: c }}
									onClick={() => setHeld({ ...held, emblemColor: c })}
									disabled={busy}
								/>
							))}
						</div>
					</div>
					<div className="mb-2 flex items-center gap-2">
						<div className="text-xs font-medium text-base-content/60">Size and position</div>
						<div className="flex items-center gap-1">
							<button
								type="button"
								className="btn btn-xs"
								onClick={() => zoom(0.9)}
								disabled={busy}
							>
								Smaller
							</button>
							<button
								type="button"
								className="btn btn-xs"
								onClick={() => zoom(1.1)}
								disabled={busy}
							>
								Larger
							</button>
							<button
								type="button"
								className="btn btn-xs btn-square"
								onClick={() => nudge(-0.05, 0)}
								disabled={busy}
								aria-label="Move left"
							>
								←
							</button>
							<button
								type="button"
								className="btn btn-xs btn-square"
								onClick={() => nudge(0.05, 0)}
								disabled={busy}
								aria-label="Move right"
							>
								→
							</button>
							<button
								type="button"
								className="btn btn-xs btn-square"
								onClick={() => nudge(0, -0.05)}
								disabled={busy}
								aria-label="Move up"
							>
								↑
							</button>
							<button
								type="button"
								className="btn btn-xs btn-square"
								onClick={() => nudge(0, 0.05)}
								disabled={busy}
								aria-label="Move down"
							>
								↓
							</button>
						</div>
					</div>
					<Byline icon={held.nounIcon} />
					<div className="mt-2 flex gap-2">
						<button
							type="button"
							className="btn btn-primary btn-xs"
							onClick={() => onSave(held)}
							disabled={busy}
						>
							Use this emblem
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={onCancel}
							disabled={busy}
						>
							Cancel
						</button>
					</div>
					<p className="mt-1 text-[11px] text-base-content/50">
						Your emblem is drawn onto your Badge — the icon file itself is never downloadable here.
					</p>
				</div>
			)}
		</div>
	);
}
