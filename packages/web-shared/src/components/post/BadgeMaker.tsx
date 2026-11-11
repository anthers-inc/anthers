// SPDX-License-Identifier: Apache-2.0
/**
 * The **Badge Maker** — the editor for one Badge, opened from the pencil on that Badge's
 * card in a creator's Badges tab. A Badge is edited one at a time, so this is not a list
 * of every rung: the grid behind it is the list, and this is what its pencil opens.
 *
 * 🚨 **Naming a rung, setting its monthly amount, describing it, and designing its art
 * are one tool's four jobs** (Parker, 2026-09-13). The creator meets their ladder as the
 * same tall cards a supporter does — the read/edit rule the profile's own fields follow —
 * and the editor is the only thing the pencil reveals, rather than a second list of the
 * same rungs standing above the first.
 *
 * ⭐ **Four tabs, because the jobs outgrew one view** (Parker, 2026-10-26, and a fourth on
 * 2026-10-27): Basics (name, short description, monthly amount), Emblem (shape, background,
 * and the emblem itself), Perks (what a supporter gets), and Unlocks (the Works this Badge
 * opens). The art editor used to sit above the fields as one long column, which made the
 * dialog scroll for reasons a creator could not see and put the perks table below the fold;
 * the Works list then sat under the perks table, where it was the one thing on the tab that
 * the creator did not type.
 *
 * ⭐ **A rung may be saved with nothing in its perks table and no Work unlocked.** It is
 * then a support payment, which is what an empty rung has always meant to a supporter;
 * `taxCodeForBadge` falls back to `SUPPORT_TAX_CODE` for it. The editor used to refuse
 * that save, and a more nuanced rule is intended once the tax codes and the gating
 * behavior have settled.
 *
 * 🚨 **Every art change is a draft until Save.** The first cut wrote shape, color, uploads
 * and compositions to the server the moment they were clicked, so Cancel still saved the
 * emblem a creator had just decided against. The dialog now owns the draft and applies it
 * in `saveArt` on the one Save button, which is the same rule the name and perks follow.
 * Only a *new* Badge still gets its art after it exists, because every art route is keyed
 * by the Badge's id.
 *
 * 🚨 **There are no standard creator Badges any more.** A creator's Badge art is built
 * from the Noun Project catalog here or uploaded as their own file, and nothing else. **A
 * rung with no art of its own falls back to Anthers' own Badge designs by ladder position**
 * (`index % 4`); that is a fallback and a start, not a design to settle for.
 *
 * ⭐ **Composition happens at save, and an unchanged save is free** — the server dedupes
 * on the composition fingerprint before it spends anything, so a creator pressing save
 * repeatedly costs the platform nothing. **A shape or background change on a composed
 * Badge is a recomposition**: the server fetches the same icon again and rebuilds the PNG
 * from the stored placement and emblem color, which is why the preview stays on the saved
 * art until Save lands.
 */

import {
	BADGE_COLORS,
	BADGE_EDGE_COLORS,
	BADGE_EMBLEM_COLORS,
	BADGE_PERK_KINDS,
	BADGE_SHAPES,
	type BadgePerkKind,
	badgeEdgeColor,
	DEFAULT_BADGE_EDGE,
	DEFAULT_BADGE_SHAPE,
	defaultEmblemColor,
} from "@anthers/shared/badge-art";
import { BADGE_ART_MAX_BYTES, STRIPE_MIN_CHARGE, supportAmount } from "@anthers/shared/constants";
import { ArrowUpTrayIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { apiFetch, client } from "../../lib/rpc";
import { studioUrl } from "../../lib/studio";
import type { CreatorBadge, Work } from "../../lib/types";
import WorkPicker from "../content/WorkPicker";
import { TypeIcon } from "../content/works";
import { BadgeMark } from "../economics/BadgeMark";
import { CreatorBadgeMark, fallbackBadgeDesign } from "../economics/CreatorBadgeMark";
import { TakeHome } from "../economics/TakeHome";
import { type EmblemPlacement, NounEmblemPicker } from "./NounEmblemPicker";

/** Coerce to a monthly amount above zero — thresholds are dollars, cents included. */
function rungAmount(v: string): string {
	// ⚠️ **Never floor this.** Flooring a DOLLAR amount silently
	// turns a creator's $2.50 rung into $2 — the granularity the unit retirement removed,
	// reintroduced by a coercion nobody would look at twice.
	const n = supportAmount(v);
	return (n > 0 ? n : 1).toFixed(2);
}

/** The dialog's own order: the things a creator usually edits first, then the art, then what the Badge carries. */
const TABS = [
	{ id: "basics", label: "Basics" },
	{ id: "emblem", label: "Emblem" },
	{ id: "perks", label: "Perks" },
	{ id: "unlocks", label: "Unlocks" },
] as const;

type Tab = (typeof TABS)[number]["id"];
type EmblemMode = "upload" | "find" | null;

/** A file the creator chose, held locally until Save. */
type StagedUpload = {
	file: File;
	previewUrl: string;
};

/** The types the upload route accepts; an empty `type` is left for the server to judge. */
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/** Read a server refusal's own words, falling back to a sentence of our own. */
async function responseError(res: Response, fallback: string): Promise<string> {
	const detail = (await res.json().catch(() => null)) as { error?: string } | null;
	return detail?.error ?? fallback;
}

/**
 * The file chooser and drop target for a creator's own art.
 *
 * ⭐ **The input itself lives in the Emblem panel, outside this mode.** A browser walk can
 * hand it a file without first opening the drop area, and a creator who changes their mind
 * keeps the same click target when they come back to Upload. The visible surface is the
 * drop area; the input is the fallback.
 */
function UploadEmblem({
	upload,
	onChoose,
	onClear,
	busy,
	error,
	input,
}: {
	upload: StagedUpload | null;
	onChoose: (file: File | null | undefined) => void;
	onClear: () => void;
	busy: boolean;
	error: string | null;
	input: React.RefObject<HTMLInputElement | null>;
}) {
	const [dragging, setDragging] = useState(false);

	return (
		<fieldset
			aria-label="Upload an emblem"
			className={`flex h-full flex-col rounded-box border-2 border-dashed p-3 transition-colors ${
				dragging ? "border-primary bg-primary/5" : "border-base-300 bg-base-100"
			}`}
			onDragOver={(e) => {
				e.preventDefault();
				setDragging(true);
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				onChoose(e.dataTransfer.files?.[0]);
			}}
		>
			{upload ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-base-200/50">
						<img
							src={upload.previewUrl}
							alt="The emblem you chose"
							className="h-full w-full object-contain"
						/>
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<button
							type="button"
							className="btn btn-xs"
							onClick={() => input.current?.click()}
							disabled={busy}
						>
							Choose another file
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-xs text-error"
							onClick={onClear}
							disabled={busy}
						>
							Remove
						</button>
						<span className="truncate text-[11px] text-base-content/50">{upload.file.name}</span>
					</div>
				</div>
			) : (
				<button
					type="button"
					className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg p-6 text-center"
					onClick={() => input.current?.click()}
					disabled={busy}
				>
					<ArrowUpTrayIcon className="h-8 w-8 text-base-content/30" />
					<span className="font-medium">Click to choose a file, or drag one here</span>
					<span className="text-xs text-base-content/50">
						PNG, JPEG or WebP. Your art sits on the background you picked.
					</span>
				</button>
			)}
			{error && <p className="mt-2 text-xs text-error">{error}</p>}
		</fieldset>
	);
}

/** One labeled row of swatch buttons (shape, background, emblem color). */
function PickerRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mb-2">
			<div className="mb-1 text-xs font-medium text-base-content/60">{label}</div>
			<div className="flex flex-wrap items-center gap-1">{children}</div>
		</div>
	);
}

/**
 * The perks table for one Badge — one fixed row per perk tax-code type.
 *
 * ⭐ **The table is tax coding, not a product description** (Parker, 2026-11-06). The
 * free-form rows it replaced let a creator add several of one type and left the type
 * looking like the only decision; a fixed row makes the question "does this Badge
 * include this kind?" and the memo says what it is. Every kind carries its Stripe tax
 * code already, and `taxCodeForBadge` reads this array.
 *
 * ⭐ **A gated Work makes its kind a fact.** A Badge that opens a digital Work includes a
 * digital good whether or not the creator ticked the row, so that row is checked and
 * locked until the Work leaves the Unlocks tab. A physical Work does the same for the
 * Physical row. The rule lives in one place below, so the table and the save agree.
 *
 * The memo is required for a checked row — the route stores a non-empty label — and it is
 * never shown to a supporter. Rows start unchecked; checking one enables its memo.
 */
function PerkEditor({
	perks,
	onChange,
	lockedKinds,
}: {
	perks: PerkDraft[];
	onChange: (perks: PerkDraft[]) => void;
	/** The kinds the Badge's gated Works make a fact rather than a claim. */
	lockedKinds: ReadonlySet<BadgePerkKind>;
}) {
	const byKind = new Map(perks.map((perk) => [perk.kind, perk]));

	/** Keep the stored array in the catalog's order, one entry per kind. */
	const ordered = (next: Map<BadgePerkKind, PerkDraft>) =>
		BADGE_PERK_KINDS.flatMap((kind) => {
			const perk = next.get(kind.id);
			return perk ? [perk] : [];
		});

	const setKind = (kind: BadgePerkKind, included: boolean) => {
		const next = new Map(byKind);
		if (included) {
			if (!next.has(kind)) next.set(kind, { kind, label: "" });
		} else {
			next.delete(kind);
		}
		onChange(ordered(next));
	};

	const setMemo = (kind: BadgePerkKind, label: string) => {
		if (!byKind.has(kind)) return;
		onChange(perks.map((perk) => (perk.kind === kind ? { ...perk, label } : perk)));
	};

	return (
		<div className="rounded-lg border border-base-300">
			<div className="border-b border-base-300 px-3 py-2">
				<div className="text-sm font-medium">Perks</div>
				<p className="text-xs text-base-content/50">
					Let us know what types of perks are included in this badge for tax purposes. This is not
					something the user sees.
				</p>
			</div>
			<div className="overflow-x-auto">
				<table className="table table-sm">
					<thead>
						<tr>
							<th className="w-10" aria-label="Included" />
							<th>Perk type</th>
							<th>What it is</th>
						</tr>
					</thead>
					<tbody>
						{BADGE_PERK_KINDS.map((kind) => {
							const perk = byKind.get(kind.id);
							const included = perk != null;
							const locked = lockedKinds.has(kind.id);
							return (
								<tr key={kind.id} className={included ? undefined : "text-base-content/50"}>
									<td>
										<input
											type="checkbox"
											className="checkbox checkbox-sm checkbox-primary"
											checked={included}
											disabled={locked}
											aria-label={`Include ${kind.label} perks`}
											onChange={(event) => setKind(kind.id, event.target.checked)}
										/>
									</td>
									<th scope="row" className="font-medium">
										<span className="flex flex-wrap items-center gap-1.5">
											{kind.label}
											{locked && (
												<span
													className="badge badge-xs badge-ghost"
													title="One of the Works this Badge opens is this kind, so the type is a fact rather than a claim. Remove the Work from Unlocks to change it."
												>
													From Unlocks
												</span>
											)}
										</span>
										<span className="mt-0.5 block text-[11px] font-normal text-base-content/50">
											{kind.examples}
										</span>
									</th>
									<td>
										<input
											type="text"
											className="input input-bordered input-xs w-full min-w-36"
											value={perk?.label ?? ""}
											disabled={!included}
											placeholder={included ? "What's included" : "Check the type first"}
											aria-label={`${kind.label} perk description`}
											onChange={(event) => setMemo(kind.id, event.target.value)}
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<p className="border-t border-base-300 px-3 py-2 text-[11px] text-base-content/50">
				Leave every type unchecked if this Badge offers nothing beyond access. The memo is tax
				coding only; supporters never see it.
			</p>
		</div>
	);
}

type PerkDraft = {
	kind: BadgePerkKind;
	label: string;
};

/** The Works this Badge opens, read from the Works' own Access tables. */
interface GatedWork {
	id: number;
	publicId: string;
	title: string;
	type: string;
	visibility: string;
	/** A resolved image URL, or empty for a Work with none. */
	thumbnail: string;
	imageAlt: string;
}

/**
 * The perk kinds a Badge's gated Works prove it includes. Every Work kind is a digital
 * good except a physical one — the split the tax codes use — and a Badge may open both,
 * so the set can hold both kinds. The table locks these rows and the save keeps them.
 */
function perkKindsForGatedWorks(works: readonly GatedWork[]): Set<BadgePerkKind> {
	const kinds = new Set<BadgePerkKind>();
	for (const work of works) {
		kinds.add(work.type === "physical" ? "physical_good" : "digital_good");
	}
	return kinds;
}

/**
 * The Works one Badge opens, as a list the dialog can also read.
 *
 * ⚠️ **The load lives in `BadgeMaker`, not here**, because Save refuses a rung that names
 * no kind and opens no Work: the guard has to know whether the list is empty, and a failed
 * read must not look like one. This component renders whatever the dialog hands it.
 */
function GatedWorks({
	works,
	error,
	busyId,
	onAdd,
	onRetry,
	onUngate,
}: {
	works: GatedWork[] | null;
	error: string | null;
	busyId: number | null;
	onAdd: () => void;
	onRetry: () => void;
	onUngate: (work: GatedWork) => void;
}) {
	const failure = (
		<div className="px-3 py-4">
			<p className="text-xs text-base-content/60">
				Couldn't load the Works this Badge opens, so nothing here has been changed.
			</p>
			<button type="button" className="btn btn-outline btn-xs mt-2" onClick={onRetry}>
				Try again
			</button>
		</div>
	);

	let body: React.ReactNode;
	if (works === null) {
		body = error ? (
			failure
		) : (
			<p className="px-3 py-4 text-xs text-base-content/50">Loading Works…</p>
		);
	} else if (works.length === 0) {
		body = error ? (
			failure
		) : (
			<p className="px-3 py-4 text-xs text-base-content/50">
				No Works are gated at this Badge yet. Add some here, or tick this level in a Work's Access
				table.
			</p>
		);
	} else {
		body = (
			<ul className="divide-y divide-base-300">
				{works.map((work) => (
					<li key={work.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
						{/* The thumbnail is the door to the Work, in the place the "Open in Studio"
						    button stood. A Work with no image keeps the same door around its own
						    type's icon, so the row never loses the way in. */}
						<a
							href={studioUrl(`/works/${work.publicId}/edit`)}
							className="h-10 w-10 shrink-0 overflow-hidden rounded border border-base-300"
							target="_blank"
							rel="noreferrer"
							title={`Open ${work.title} in Studio`}
							aria-label={`Open ${work.title} in Studio`}
						>
							{work.thumbnail ? (
								<img
									src={work.thumbnail}
									alt={work.imageAlt}
									className="h-full w-full object-cover"
								/>
							) : (
								<div className="flex h-full w-full items-center justify-center bg-base-200 text-base-content/40">
									<TypeIcon type={work.type} className="h-4 w-4" />
								</div>
							)}
						</a>
						<div className="min-w-0 flex-1">
							<div className="truncate text-sm font-medium">{work.title}</div>
							<div className="text-[11px] text-base-content/50">
								{work.type} · {work.visibility === "released" ? "Released" : "Not released"}
							</div>
						</div>
						<button
							type="button"
							className="btn btn-ghost btn-xs text-error"
							onClick={() => onUngate(work)}
							disabled={busyId === work.id}
						>
							{busyId === work.id ? "Removing…" : "Remove from Badge"}
						</button>
					</li>
				))}
			</ul>
		);
	}

	return (
		<div className="rounded-lg border border-base-300">
			<div className="flex flex-wrap items-start justify-between gap-2 border-b border-base-300 px-3 py-2">
				<div>
					<div className="text-sm font-medium">Works this Badge opens</div>
					<p className="text-xs text-base-content/50">
						Add a Work here, or tick this level in a Work's Access table. Removing one here closes
						it for this Badge.
					</p>
				</div>
				<button type="button" className="btn btn-outline btn-xs" onClick={onAdd}>
					Add Works
				</button>
			</div>

			{body}

			{/* An ungate that failed keeps the list and says so beneath it; a failed load is the
			    failure box above, because an empty list there would read as "nothing is gated". */}
			{error && works !== null && works.length > 0 && (
				<p className="border-t border-base-300 px-3 py-2 text-xs text-error">{error}</p>
			)}
		</div>
	);
}

export default function BadgeMaker({
	badge,
	index,
	onChanged,
	onClose,
}: {
	/** The Badge this editor opens on; null when the creator is adding one. */
	badge: CreatorBadge | null;
	/** The rung's position on the ladder, for the fallback art. */
	index: number;
	/** A save or delete lands; the grid behind the dialog refetches its rows. */
	onChanged?: () => void;
	onClose: () => void;
}) {
	// The dialog starts on the row it was opened for, or on nothing for a new Badge. A
	// successful add swaps in the created row rather than closing: the creator lands on the
	// full editor, with the tabs, for the Badge they just made.
	const [saved, setSaved] = useState<CreatorBadge | null>(null);
	const current = saved ?? badge;
	const creating = current === null;
	const badgeId = current?.id ?? null;
	const fallback = fallbackBadgeDesign(index);

	const [tab, setTab] = useState<Tab>("basics");
	const [label, setLabel] = useState(badge?.label ?? "");
	const [threshold, setThreshold] = useState(badge?.threshold ?? "");
	const [description, setDescription] = useState(badge?.description ?? "");
	const [perks, setPerks] = useState<PerkDraft[]>([]);
	/** Whether the stored perks were read; a failed read must not become an empty replace. */
	const [perksLoaded, setPerksLoaded] = useState(creating);
	const [loadingPerks, setLoadingPerks] = useState(!creating);
	const [perksError, setPerksError] = useState(false);
	const [perksReload, setPerksReload] = useState(0);

	// The Works this Badge opens, loaded here because Save reads the list as well as
	// rendering it: a rung that names no kind and opens no Work is unfinished.
	const [gatedWorks, setGatedWorks] = useState<GatedWork[] | null>(null);
	const [gatedError, setGatedError] = useState<string | null>(null);
	const [gatedBusyId, setGatedBusyId] = useState<number | null>(null);
	const [gatedReload, setGatedReload] = useState(0);
	const [pickingWorks, setPickingWorks] = useState(false);
	const lockedPerkKinds = perkKindsForGatedWorks(gatedWorks ?? []);

	// The art draft. Shape and color start from what the rung stored, and from the fallback
	// design's own color when the rung has never chosen one — otherwise the preview would
	// show the fallback's color and the saved composition would use a different one.
	const initialShape = badge?.artShape ?? DEFAULT_BADGE_SHAPE;
	const initialColor = badge?.artColor ?? fallback.color;
	const initialEdge = badge?.artEdgeColor ?? DEFAULT_BADGE_EDGE;
	const [shape, setShape] = useState(initialShape);
	const [color, setColor] = useState(initialColor);
	const [edge, setEdge] = useState(initialEdge);
	// "Find an Emblem" is the default mode, so the picker opens on the catalog rather than
	// on a placeholder that asks the creator to choose a mode first.
	const [emblemMode, setEmblemMode] = useState<EmblemMode>("find");
	const [upload, setUpload] = useState<StagedUpload | null>(null);
	const [selection, setSelection] = useState<EmblemPlacement | null>(null);
	const [removed, setRemoved] = useState(false);
	const [emblemColor, setEmblemColor] = useState(() => defaultEmblemColor(initialColor));
	const [emblemColorTouched, setEmblemColorTouched] = useState(false);
	const [artError, setArtError] = useState<string | null>(null);

	const [saving, setSaving] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const fileInput = useRef<HTMLInputElement>(null);

	// A composed Badge is a finished image of the whole badge, shape and field included, so a
	// new shape or background only reaches the art through a recomposition. The server can
	// rebuild it from the stored icon and emblem color when it still has that color; a row it
	// cannot rebuild keeps the old refusal instead of writing a shape the PNG does not carry.
	const composedArt = Boolean(current?.hasComposedArt);
	const artChoiceChanged = shape !== initialShape || color !== initialColor || edge !== initialEdge;
	const canRecomposeArt = composedArt && Boolean(current?.canRecompose);
	const needsNewEmblemForChoice =
		composedArt && artChoiceChanged && !canRecomposeArt && !selection && !upload && !removed;
	// The save that changes nothing but the background and keeps the emblem: the server
	// fetches the vector again and rebuilds the PNG, so the preview stays on the saved art
	// until the save lands.
	const willRecompose =
		composedArt && artChoiceChanged && canRecomposeArt && !selection && !upload && !removed;
	// The checked rows are the Badge's claimed types; the memo names each one.
	const checkedPerkCount = perks.length;

	// Perks are stored rows; load them into the fixed table — one row per kind, in the
	// catalog's order, with a duplicate or an unknown legacy kind dropped. The editor stays
	// mounted when a save refetches the ladder, so this reads once per Badge.
	useEffect(() => {
		if (badgeId === null) return;
		// A retry bumps this counter; reading it is what makes the dependency honest.
		void perksReload;
		let live = true;
		setLoadingPerks(true);
		apiFetch(`/api/subscriptions/badges/${badgeId}/perks`)
			.then(async (res) => {
				if (!live) return;
				if (!res.ok) {
					setPerksError(true);
					return;
				}
				const body = (await res.json()) as { perks: PerkDraft[] };
				setPerks(
					BADGE_PERK_KINDS.flatMap((kind) => {
						const row = (body.perks ?? []).find((p) => p.kind === kind.id);
						return row ? [{ kind: kind.id, label: row.label }] : [];
					}),
				);
				setPerksLoaded(true);
			})
			.catch(() => {
				if (live) setPerksError(true);
			})
			.finally(() => {
				if (live) setLoadingPerks(false);
			});
		return () => {
			live = false;
		};
	}, [badgeId, perksReload]);

	// Revoke a staged file's object URL when it is replaced or the dialog closes.
	useEffect(() => {
		if (!upload) return;
		return () => URL.revokeObjectURL(upload.previewUrl);
	}, [upload]);

	// The Works list, read once per Badge and after a retry. A failure leaves `null` behind
	// an error rather than an empty list, so the save guard below can tell the two apart.
	useEffect(() => {
		if (badgeId === null) return;
		void gatedReload;
		let live = true;
		setGatedWorks(null);
		setGatedError(null);
		apiFetch(`/api/content/badge-gates/${badgeId}`)
			.then(async (res) => {
				if (!live) return;
				if (!res.ok) {
					setGatedError("Couldn't load the Works this Badge opens.");
					return;
				}
				const body = (await res.json()) as { works: GatedWork[] };
				setGatedWorks(body.works ?? []);
			})
			.catch(() => {
				if (live) setGatedError("Couldn't load the Works this Badge opens.");
			});
		return () => {
			live = false;
		};
	}, [badgeId, gatedReload]);

	// A gated Work makes its kind a fact, so the row is checked even before the creator
	// touches the table. This runs after both reads land, so the perks load cannot
	// overwrite it; a kind the Works no longer require stays checked as a claim.
	useEffect(() => {
		if (!gatedWorks || !perksLoaded) return;
		const locked = perkKindsForGatedWorks(gatedWorks);
		if (locked.size === 0) return;
		setPerks((current) => {
			if ([...locked].every((kind) => current.some((p) => p.kind === kind))) return current;
			return BADGE_PERK_KINDS.flatMap((kind) => {
				const existing = current.find((p) => p.kind === kind.id);
				if (existing) return [existing];
				if (!locked.has(kind.id)) return [];
				// The memo is required by the route, so the fact arrives described; the
				// creator can reword it, and the checkbox stays locked.
				return [
					{
						kind: kind.id,
						label:
							kind.id === "physical_good"
								? "The physical goods this Badge opens"
								: "Access to the digital Works this Badge opens",
					},
				];
			});
		});
	}, [gatedWorks, perksLoaded]);

	/**
	 * Give this Badge the Works picked from the catalog.
	 *
	 * The picker excludes what the list already holds, but a Work can join between the
	 * modal opening and the add, so the fresh filter runs again here. Each add is the
	 * badge-side door that writes the Work's own Access row; the list is re-read after,
	 * because the server normalizes the table and the row's shape is not ours to guess.
	 */
	const addGatedWorks = async (picked: Work[]) => {
		if (badgeId === null) return;
		const fresh = picked.filter((work) => !(gatedWorks ?? []).some((w) => w.id === work.id));
		if (fresh.length === 0) return;
		setGatedError(null);
		const failures: string[] = [];
		for (const work of fresh) {
			try {
				const res = await apiFetch(`/api/content/badge-gates/${badgeId}`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ workId: work.id }),
				});
				if (!res.ok) {
					failures.push(await responseError(res, `Couldn't add ${work.title}.`));
				}
			} catch {
				failures.push(`Couldn't add ${work.title}.`);
			}
		}
		if (failures.length > 0) setGatedError(failures.join(" "));
		setGatedReload((n) => n + 1);
	};

	const ungateWork = async (work: GatedWork) => {
		if (badgeId === null) return;
		setGatedBusyId(work.id);
		setGatedError(null);
		try {
			const res = await apiFetch(`/api/content/badge-gates/${badgeId}/${work.id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				setGatedError(await responseError(res, "Couldn't stop this Badge opening that Work."));
				return;
			}
			setGatedWorks((prev) => (prev ?? []).filter((w) => w.id !== work.id));
		} catch {
			setGatedError("Couldn't stop this Badge opening that Work.");
		} finally {
			setGatedBusyId(null);
		}
	};

	// Follow the background color until the creator picks an emblem color of their own, so
	// a light field never starts with a white icon on it.
	useEffect(() => {
		if (!emblemColorTouched) setEmblemColor(defaultEmblemColor(color));
	}, [color, emblemColorTouched]);

	const chooseFile = (file: File | null | undefined) => {
		setArtError(null);
		if (!file) return;
		if (file.type && !ACCEPTED_IMAGE_TYPES.includes(file.type)) {
			setArtError("That file is not an image we can read. PNG, JPEG or WebP.");
			return;
		}
		if (file.size > BADGE_ART_MAX_BYTES) {
			setArtError("That image is too large — 4 MB at most.");
			return;
		}
		setUpload({ file, previewUrl: URL.createObjectURL(file) });
		setSelection(null);
		setRemoved(false);
		setEmblemMode("upload");
	};

	const chooseEmblem = (next: EmblemPlacement | null) => {
		setArtError(null);
		setSelection(next);
		if (next) {
			setUpload(null);
			setRemoved(false);
			setEmblemMode("find");
		}
	};

	const removeArt = () => {
		setUpload(null);
		setSelection(null);
		setRemoved(true);
		setEmblemMode(null);
	};

	const previewMark = (() => {
		const previewLabel = label.trim() ? `${label.trim()} badge` : "New Badge";
		const common = {
			shape,
			color,
			edgeColor: badgeEdgeColor(edge).fill,
			label: previewLabel,
			clipId: "badge-maker-preview",
			size: "h-16 w-16",
		};
		if (upload) {
			return <BadgeMark {...common} imageSrc={upload.previewUrl} />;
		}
		if (selection) {
			return (
				<BadgeMark
					{...common}
					maskSrc={selection.nounIcon.thumbnailUrl}
					maskColor={emblemColor}
					maskScale={selection.scale}
					maskOffsetX={selection.offsetX}
					maskOffsetY={selection.offsetY}
				/>
			);
		}
		if (current?.hasArt && !removed) {
			return (
				<CreatorBadgeMark
					badgeId={current.id}
					index={index}
					label={previewLabel}
					art={{ ...current, artShape: shape, artColor: color, artEdgeColor: edge }}
					size="h-16 w-16"
				/>
			);
		}
		return <BadgeMark {...common} emblem={fallback.emblem} />;
	})();

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!label.trim() || !threshold.trim()) return;
		setSaving(true);
		setError(null);
		try {
			// Validate the whole form before the first write, so a refusal does not leave the
			// name or the amount saved while the art or a perk is what stopped the save.
			if (!creating && needsNewEmblemForChoice) {
				throw new Error(
					"This Badge's emblem is a finished image, so a new shape or background needs a new emblem. Find or upload one below.",
				);
			}
			if (!creating && perksLoaded && perks.some((p) => !p.label.trim())) {
				throw new Error("Say what each checked perk is.");
			}

			if (creating) {
				const res = await client.api.subscriptions.badges.$post({
					json: {
						threshold: rungAmount(threshold),
						label: label.trim(),
						description: description.trim(),
					},
				});
				if (!res.ok) throw new Error("Couldn't add this Badge.");
				const { badge: created } = (await res.json()) as { badge: CreatorBadge };
				// The rung exists; the dialog stays open as its editor rather than closing on
				// the basics-only modal. `onChanged` refreshes the grid behind it.
				setSaved(created);
				setTab("emblem");
				onChanged?.();
				return;
			}

			const stored = current;
			if (!stored) return;
			const res = await client.api.subscriptions.badges[":id"].$patch({
				param: { id: String(stored.id) },
				json: {
					threshold: rungAmount(threshold),
					label: label.trim(),
					description: description.trim(),
				},
			});
			if (!res.ok) throw new Error("Couldn't save this Badge.");

			await saveArt(stored);

			// A failed read leaves the stored perks alone rather than replacing them with the
			// empty list the creator saw. The whole-list route makes an absent read destructive.
			if (perksLoaded) {
				const perksRes = await apiFetch(`/api/subscriptions/badges/${stored.id}/perks`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						perks: perks.map((p) => ({ kind: p.kind, label: p.label.trim() })),
					}),
				});
				if (!perksRes.ok) throw new Error("Couldn't save the perks.");
			}

			onChanged?.();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't save this Badge.");
		} finally {
			setSaving(false);
		}
	};

	/**
	 * Apply the staged art, in the order the routes expect.
	 *
	 * 🚨 **Compose and recompose write shape and color themselves**, so each runs alone.
	 * Upload and removal do not, so the shape/color choice is patched first and the file (or
	 * the removal) follows. A compose that fails leaves the previous art untouched, which is
	 * the server's own rule.
	 */
	const saveArt = async (stored: CreatorBadge) => {
		if (needsNewEmblemForChoice) {
			throw new Error(
				"This Badge's emblem is a finished image, so a new shape or background needs a new emblem. Find or upload one below.",
			);
		}
		const choiceChanged = artChoiceChanged;

		if (willRecompose) {
			const res = await apiFetch(`/api/subscriptions/badges/${stored.id}/recompose`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ shape, fieldColor: color, edgeColor: edge }),
			});
			if (!res.ok) throw new Error(await responseError(res, "Couldn't rebuild that emblem."));
			return;
		}

		if (selection) {
			const res = await apiFetch(`/api/subscriptions/badges/${stored.id}/compose`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					noun: { id: selection.nounIcon.id },
					placement: {
						shape,
						fieldColor: color,
						edgeColor: edge,
						emblemColor,
						scale: selection.scale,
						offsetX: selection.offsetX,
						offsetY: selection.offsetY,
					},
				}),
			});
			if (!res.ok) throw new Error(await responseError(res, "Couldn't compose that emblem."));
			return;
		}

		if (choiceChanged) {
			const res = await apiFetch(`/api/subscriptions/badges/${stored.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ artShape: shape, artColor: color, artEdgeColor: edge }),
			});
			if (!res.ok) throw new Error("Couldn't save that choice.");
		}

		if (upload) {
			const body = new FormData();
			body.append("file", upload.file);
			const res = await apiFetch(`/api/subscriptions/badges/${stored.id}/art`, {
				method: "POST",
				body,
			});
			if (!res.ok) throw new Error(await responseError(res, "That art didn't go through."));
			return;
		}

		if (removed && stored.hasArt) {
			const res = await apiFetch(`/api/subscriptions/badges/${stored.id}/art`, {
				method: "DELETE",
			});
			if (!res.ok) throw new Error("Couldn't remove that art.");
		}
	};

	const handleDelete = async () => {
		if (!current) return;
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.badges[":id"].$delete({
				param: { id: String(current.id) },
			});
			if (!res.ok) {
				// The refusal that matters is a rung a Work still gates on (409): the server's
				// sentence names how many, and a generic "couldn't delete" would hide the fix.
				const body = (await res.json().catch(() => null)) as unknown as {
					error?: string;
				} | null;
				throw new Error(body?.error ?? "Couldn't delete this Badge.");
			}
			onChanged?.();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't delete this Badge.");
		} finally {
			setSaving(false);
		}
	};

	const basicsPanel = (
		<div className="flex flex-col gap-3">
			<label className="form-control">
				<span className="label-text mb-1 text-xs font-medium text-base-content/60">Name</span>
				<input
					type="text"
					className="input input-bordered input-sm w-full"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Label (e.g. Supporter)"
				/>
			</label>

			<label className="form-control">
				<span className="label-text mb-1 text-xs font-medium text-base-content/60">
					Short Description
				</span>
				<textarea
					className="textarea textarea-bordered textarea-sm w-full"
					rows={3}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="What this level gives, in a sentence or two (optional)"
				/>
			</label>

			<div className="flex flex-wrap items-start gap-3">
				<label className="form-control w-36 shrink-0">
					<span className="label-text mb-1 text-xs font-medium text-base-content/60">
						Monthly Amount
					</span>
					<input
						type="number"
						aria-label="Monthly Amount"
						className="input input-bordered input-sm w-full"
						value={threshold}
						onChange={(e) => setThreshold(e.target.value)}
						min={STRIPE_MIN_CHARGE}
						step="0.01"
						placeholder="$/mo"
					/>
				</label>
				<div className="min-w-0 flex-1">
					<TakeHome amount={Number(threshold) || 0} kind="badge" />
				</div>
			</div>
		</div>
	);

	const emblemPanel = (
		<div className="flex h-full flex-col gap-3" data-testid="badge-art-control">
			{/* ⭐ Shape and background share one line (Parker, 2026-10-27). Each is a short row of
			    swatches, so stacking them left most of the dialog's width empty. */}
			<div className="flex flex-wrap items-start gap-x-8 gap-y-1">
				<PickerRow label="Badge Shape">
					{BADGE_SHAPES.map((s) => (
						<button
							key={s.id}
							type="button"
							aria-label={s.label}
							aria-pressed={shape === s.id}
							className={`btn btn-xs btn-square ${shape === s.id ? "btn-primary" : "btn-ghost"}`}
							onClick={() => setShape(s.id)}
							disabled={saving}
						>
							<svg viewBox="0 0 100 100" className="h-4 w-4" aria-hidden="true">
								<path d={s.path} fill="currentColor" />
							</svg>
						</button>
					))}
				</PickerRow>

				<PickerRow label="Edge Color">
					{BADGE_EDGE_COLORS.map((choice) => (
						<button
							key={choice.id}
							type="button"
							aria-label={`Edge ${choice.label}`}
							aria-pressed={edge === choice.id}
							className={`h-5 w-5 rounded-full border-2 ${
								edge === choice.id
									? "border-primary ring-2 ring-primary/40 ring-offset-2 ring-offset-base-100"
									: "border-base-300"
							}`}
							style={{ backgroundColor: choice.fill }}
							onClick={() => setEdge(choice.id)}
							disabled={saving}
						/>
					))}
				</PickerRow>

				<PickerRow label="Background Color">
					{BADGE_COLORS.map((col) => (
						<button
							key={col.id}
							type="button"
							aria-label={`Background ${col.label}`}
							aria-pressed={color === col.id}
							className={`h-5 w-5 rounded-full border-2 ${
								color === col.id
									? "border-primary ring-2 ring-primary/40 ring-offset-2 ring-offset-base-100"
									: "border-base-300"
							}`}
							style={{ backgroundColor: col.fill }}
							onClick={() => setColor(col.id)}
							disabled={saving}
						/>
					))}
				</PickerRow>
			</div>

			{needsNewEmblemForChoice && (
				<p className="rounded-box bg-warning/10 px-3 py-2 text-xs text-warning-content">
					This Badge's emblem is a finished image. A new shape or background needs a new emblem —
					find or upload one below.
				</p>
			)}
			{willRecompose && (
				<p className="rounded-box bg-base-200 px-3 py-2 text-xs text-base-content/70">
					Saving rebuilds this emblem on the new shape and background.
				</p>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-base-content/60">Emblem</span>
				<div className="join">
					<button
						type="button"
						className={`btn btn-xs join-item ${emblemMode === "find" ? "btn-primary" : "btn-outline"}`}
						aria-pressed={emblemMode === "find"}
						onClick={() => setEmblemMode("find")}
					>
						Find an Emblem
					</button>
					<button
						type="button"
						className={`btn btn-xs join-item ${emblemMode === "upload" ? "btn-primary" : "btn-outline"}`}
						aria-pressed={emblemMode === "upload"}
						onClick={() => setEmblemMode("upload")}
					>
						Upload an Emblem
					</button>
				</div>
				{current?.hasArt && !removed && !upload && !selection && (
					<button
						type="button"
						className="btn btn-ghost btn-xs ml-auto text-error"
						onClick={removeArt}
						disabled={saving}
					>
						Remove this emblem
					</button>
				)}
				{removed && (
					<button
						type="button"
						className="btn btn-ghost btn-xs ml-auto"
						onClick={() => setRemoved(false)}
						disabled={saving}
					>
						Keep the current emblem
					</button>
				)}
			</div>

			{/* 🚨 One panel that fills the tab's remaining height for both modes, so switching
			    Upload/Find does not move the dialog's edge and the search box does not appear
			    only after a query. The form has a definite height, which is what lets this
			    fill rather than guess at a pixel value. */}
			<div className="min-h-0 flex-1">
				{emblemMode === "upload" ? (
					<UploadEmblem
						upload={upload}
						onChoose={chooseFile}
						onClear={() => setUpload(null)}
						busy={saving}
						error={artError}
						input={fileInput}
					/>
				) : emblemMode === "find" ? (
					<div className="flex h-full flex-col rounded-box border border-base-300 bg-base-100 p-2">
						<div className="mb-2 flex flex-wrap items-center gap-1">
							<span className="mr-1 text-xs font-medium text-base-content/60">Emblem Color</span>
							{BADGE_EMBLEM_COLORS.map((c) => (
								<button
									key={c}
									type="button"
									aria-label={`Emblem color ${c}`}
									aria-pressed={emblemColor === c}
									className={`h-5 w-5 rounded-full border-2 ${
										emblemColor === c
											? "border-primary ring-2 ring-primary/40 ring-offset-2 ring-offset-base-100"
											: "border-base-300"
									}`}
									style={{ backgroundColor: c }}
									onClick={() => {
										setEmblemColor(c);
										setEmblemColorTouched(true);
									}}
									disabled={saving}
								/>
							))}
						</div>
						<div className="min-h-0 flex-1">
							<NounEmblemPicker
								emblemColor={emblemColor}
								selection={selection}
								onSelectionChange={chooseEmblem}
								busy={saving}
							/>
						</div>
					</div>
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-2 rounded-box border border-dashed border-base-300 bg-base-100 p-6 text-center">
						<span className="font-medium">Choose how to make this emblem</span>
						<span className="text-xs text-base-content/50">
							Upload your own art, or find one in the Noun Project catalog.
						</span>
					</div>
				)}
			</div>
			<input
				ref={fileInput}
				type="file"
				accept={ACCEPTED_IMAGE_TYPES.join(",")}
				className="hidden"
				onChange={(e) => {
					chooseFile(e.target.files?.[0]);
					// Let the same file be chosen again after a remove.
					e.currentTarget.value = "";
				}}
			/>
			{artError && emblemMode !== "upload" && <p className="text-xs text-error">{artError}</p>}
		</div>
	);

	const perksPanel = (
		<div className="flex flex-col">
			{loadingPerks ? (
				<p className="text-xs text-base-content/50">Loading perks…</p>
			) : perksError ? (
				<div className="rounded-box border border-base-300 px-3 py-4">
					<p className="text-xs text-base-content/60">
						Couldn't load this Badge's perks, so nothing here has been changed.
					</p>
					<button
						type="button"
						className="btn btn-outline btn-xs mt-2"
						onClick={() => {
							setPerksError(false);
							setPerksReload((n) => n + 1);
						}}
					>
						Try again
					</button>
				</div>
			) : (
				<PerkEditor perks={perks} onChange={setPerks} lockedKinds={lockedPerkKinds} />
			)}
		</div>
	);

	// The Works list moved off Perks onto its own tab (Parker, 2026-10-27): it is the one
	// thing on the tab a creator did not type, and it is where an access question is
	// answered rather than where a perk is described.
	const unlocksPanel =
		badgeId === null ? null : (
			<>
				<GatedWorks
					works={gatedWorks}
					error={gatedError}
					busyId={gatedBusyId}
					onAdd={() => setPickingWorks(true)}
					onRetry={() => setGatedReload((n) => n + 1)}
					onUngate={(work) => void ungateWork(work)}
				/>
				<WorkPicker
					open={pickingWorks}
					excludeIds={(gatedWorks ?? []).map((work) => work.id)}
					onSelect={(picked) => void addGatedWorks(picked)}
					onClose={() => setPickingWorks(false)}
				/>
			</>
		);

	return (
		<form onSubmit={handleSave} className="flex h-[min(85vh,760px)] flex-col">
			<div className="flex items-start justify-between gap-3 px-5 pt-4">
				<div className="flex min-w-0 items-start gap-3">
					<div className="shrink-0" data-testid="badge-maker-preview">
						{previewMark}
					</div>
					<div className="min-w-0">
						<h3 className="text-lg font-bold">{creating ? "Add a Badge" : "Edit Badge"}</h3>
						{creating ? (
							<p className="text-sm text-base-content/60">
								A Badge is a monthly level supporters can give at. You design its emblem after the
								first save.
							</p>
						) : (
							<p className="truncate text-sm text-base-content/60">
								{label.trim() || "Untitled"} ·{" "}
								{threshold.trim() ? `$${Number(threshold).toFixed(2)}/mo` : "No amount yet"}
							</p>
						)}
					</div>
				</div>
				<button
					type="button"
					className="btn btn-ghost btn-sm btn-square"
					onClick={onClose}
					aria-label="Close the Badge editor"
				>
					<XMarkIcon className="h-5 w-5" />
				</button>
			</div>

			{error && (
				<div className="alert alert-error mx-5 mt-3 text-sm">
					<span>{error}</span>
				</div>
			)}

			{!creating && (
				<div
					role="tablist"
					aria-label="Badge sections"
					className="mt-3 flex gap-1 border-b border-base-300 px-5"
				>
					{TABS.map((t) => (
						<button
							key={t.id}
							type="button"
							role="tab"
							id={`badge-tab-${t.id}`}
							aria-selected={tab === t.id}
							aria-controls={`badge-panel-${t.id}`}
							className={`-mb-px border-b-2 px-3 py-2 text-sm ${
								tab === t.id
									? "border-primary font-medium text-primary"
									: "border-transparent text-base-content/60 hover:text-base-content"
							}`}
							onClick={() => setTab(t.id)}
						>
							{t.label}
							{t.id === "perks" && perksLoaded && checkedPerkCount > 0
								? ` (${checkedPerkCount})`
								: ""}
							{t.id === "unlocks" && gatedWorks && gatedWorks.length > 0
								? ` (${gatedWorks.length})`
								: ""}
						</button>
					))}
				</div>
			)}

			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				{creating ? (
					basicsPanel
				) : (
					<>
						<div
							role="tabpanel"
							id="badge-panel-basics"
							aria-labelledby="badge-tab-basics"
							hidden={tab !== "basics"}
						>
							{basicsPanel}
						</div>
						<div
							role="tabpanel"
							id="badge-panel-emblem"
							aria-labelledby="badge-tab-emblem"
							hidden={tab !== "emblem"}
							className="h-full"
						>
							{emblemPanel}
						</div>
						<div
							role="tabpanel"
							id="badge-panel-perks"
							aria-labelledby="badge-tab-perks"
							hidden={tab !== "perks"}
						>
							{perksPanel}
						</div>
						<div
							role="tabpanel"
							id="badge-panel-unlocks"
							aria-labelledby="badge-tab-unlocks"
							hidden={tab !== "unlocks"}
						>
							{unlocksPanel}
						</div>
					</>
				)}
			</div>

			<div className="flex flex-wrap items-center gap-2 border-t border-base-300 px-5 py-3">
				{!creating &&
					(confirmingDelete ? (
						<div className="mr-auto flex items-center gap-2">
							<span className="text-xs text-base-content/60">Delete this Badge?</span>
							<button
								type="button"
								className="btn btn-error btn-xs"
								onClick={() => void handleDelete()}
								disabled={saving}
							>
								{saving ? "Deleting…" : "Delete"}
							</button>
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								onClick={() => setConfirmingDelete(false)}
								disabled={saving}
							>
								Keep it
							</button>
						</div>
					) : (
						<button
							type="button"
							className="btn btn-ghost btn-sm mr-auto text-error"
							onClick={() => setConfirmingDelete(true)}
							disabled={saving}
						>
							<TrashIcon className="h-4 w-4" />
							Delete
						</button>
					))}
				<button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
					Cancel
				</button>
				<button
					type="submit"
					className="btn btn-primary btn-sm"
					disabled={saving || !label.trim() || !threshold.trim()}
				>
					{saving ? "Saving…" : creating ? "Add Badge" : "Save"}
				</button>
			</div>
		</form>
	);
}
