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
 * ⭐ **Three tabs, because the four jobs outgrew one view** (Parker, 2026-10-26): Basics
 * (name, monthly amount, description), Emblem (shape, background, and the emblem itself),
 * and Perks (the perks table plus the Works this Badge opens). The art editor used to sit
 * above the fields as one long column, which made the dialog scroll for reasons a creator
 * could not see and put the perks table below the fold.
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
 * repeatedly costs the platform nothing.
 */

import {
	BADGE_COLORS,
	BADGE_EMBLEM_COLORS,
	BADGE_PERK_KINDS,
	BADGE_SHAPES,
	type BadgePerkKind,
	DEFAULT_BADGE_SHAPE,
	defaultEmblemColor,
} from "@anthers/shared/badge-art";
import { BADGE_ART_MAX_BYTES, STRIPE_MIN_CHARGE, supportAmount } from "@anthers/shared/constants";
import { ArrowUpTrayIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { apiFetch, client } from "../../lib/rpc";
import { studioUrl } from "../../lib/studio";
import type { CreatorBadge } from "../../lib/types";
import { BadgeMark } from "../economics/BadgeMark";
import { CreatorBadgeMark, fallbackBadgeDesign } from "../economics/CreatorBadgeMark";
import { TakeHome } from "../economics/TakeHome";
import InfoTip from "../ui/InfoTip";
import { type EmblemPlacement, NounEmblemPicker } from "./NounEmblemPicker";

/** Coerce to a monthly amount above zero — thresholds are dollars, cents included. */
function rungAmount(v: string): string {
	// ⚠️ **Never floor this.** Flooring a DOLLAR amount silently
	// turns a creator's $2.50 rung into $2 — the granularity the unit retirement removed,
	// reintroduced by a coercion nobody would look at twice.
	const n = supportAmount(v);
	return (n > 0 ? n : 1).toFixed(2);
}

/** The dialog's own order: the things a creator usually edits first, then the art, then perks. */
const TABS = [
	{ id: "basics", label: "Basics" },
	{ id: "emblem", label: "Emblem" },
	{ id: "perks", label: "Perks" },
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
 * The perks table for one Badge — a whole-list editor over the fixed category list.
 *
 * ⭐ **One Add button creates a row with every field on it** (Parker, 2026-10-26). The
 * retired control made a creator pick a type before a row existed, which hid the label and
 * description fields and made the type look like the only decision. The four explanations
 * now live in one (i) beside the Type column, so comparing them does not mean selecting
 * each in turn.
 */
function PerkEditor({
	perks,
	onChange,
}: {
	perks: PerkDraft[];
	onChange: (perks: PerkDraft[]) => void;
}) {
	const update = (i: number, patch: Partial<PerkDraft>) => {
		onChange(perks.map((p, j) => (j === i ? { ...p, ...patch } : p)));
	};

	const changeKind = (i: number, kind: string) => {
		const current = perks[i];
		const oldFriendly = BADGE_PERK_KINDS.find((k) => k.id === String(current.kind))?.friendly ?? "";
		const nextFriendly = BADGE_PERK_KINDS.find((k) => k.id === kind)?.friendly ?? "";
		update(i, {
			kind,
			// Keep a description the creator wrote; only replace the placeholder the previous
			// type supplied, which is the one string that is not their words.
			description:
				!current.description || current.description === oldFriendly
					? nextFriendly
					: current.description,
		});
	};

	const remove = (i: number) => onChange(perks.filter((_, j) => j !== i));
	const add = () => {
		// The type starts unchosen, and the row shows it as a required field. A default would
		// silently classify a new perk — and the type is what decides the sales-tax code.
		onChange([...perks, { key: crypto.randomUUID(), kind: "", label: "", description: "" }]);
	};

	return (
		<div className="rounded-lg border border-base-300">
			<div className="flex flex-col gap-2 border-b border-base-300 px-3 py-2 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<div className="text-sm font-medium">Perks</div>
					<p className="text-xs text-base-content/50">
						What a supporter gets beside access. Access is set on the Work, not here — the Works
						below are the ones this Badge opens.
					</p>
				</div>
				<button
					type="button"
					className="btn btn-outline btn-xs shrink-0 self-start"
					onClick={add}
					disabled={perks.length >= 10}
				>
					Add a perk
				</button>
			</div>

			<div className="overflow-x-auto">
				<table className="table table-sm">
					<thead>
						<tr>
							<th className="w-44">
								<span className="inline-flex items-center gap-1">
									Type
									<InfoTip wide unclipped>
										<span className="block font-medium text-base-content">Perk types</span>
										<ul className="mt-1 space-y-1">
											{BADGE_PERK_KINDS.map((k) => (
												<li key={k.id}>
													<strong className="font-medium text-base-content/80">{k.label}</strong> —{" "}
													{k.friendly}
												</li>
											))}
										</ul>
										<span className="mt-1 block text-base-content/50">
											A Badge carrying more than one type is taxed at its most-taxable type.
										</span>
										<span className="mt-1 block text-base-content/50">
											Sales tax is added to the buyer's total. It is not taken from what you
											receive.
										</span>
									</InfoTip>
								</span>
							</th>
							<th>What supporters get</th>
							<th>Description</th>
							<th className="w-10" />
						</tr>
					</thead>
					<tbody>
						{perks.length === 0 ? (
							<tr>
								<td colSpan={4} className="py-6 text-center text-xs text-base-content/50">
									No perks yet. Add one to show supporters what else this Badge carries.
								</td>
							</tr>
						) : (
							perks.map((perk, i) => (
								<tr key={perk.key}>
									<td>
										<select
											className="select select-bordered select-xs w-40"
											value={String(perk.kind)}
											onChange={(e) => changeKind(i, e.target.value)}
											aria-label="Perk type"
										>
											<option value="" disabled>
												Choose a type
											</option>
											{BADGE_PERK_KINDS.map((k) => (
												<option key={k.id} value={k.id}>
													{k.label}
												</option>
											))}
										</select>
									</td>
									<td>
										<input
											type="text"
											className="input input-bordered input-xs w-full min-w-36"
											value={perk.label}
											onChange={(e) => update(i, { label: e.target.value })}
											placeholder="What supporters get, in your words"
											aria-label="Perk name"
										/>
									</td>
									<td>
										<input
											type="text"
											className="input input-bordered input-xs w-full min-w-36"
											value={perk.description ?? ""}
											onChange={(e) => update(i, { description: e.target.value })}
											placeholder="A line of detail (optional)"
											aria-label="Perk description"
										/>
									</td>
									<td>
										<button
											type="button"
											className="btn btn-ghost btn-xs btn-square text-error"
											onClick={() => remove(i)}
											title="Remove perk"
											aria-label="Remove perk"
										>
											<TrashIcon className="h-3.5 w-3.5" />
										</button>
									</td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			<p className="border-t border-base-300 px-3 py-2 text-[11px] text-base-content/50">
				{perks.length >= 10
					? "A Badge carries ten perks at most."
					: "Not sure which applies? Write to support@anthers.org."}
			</p>
		</div>
	);
}

type PerkDraft = {
	/** Stable within the editor session, for React keys on draft rows. */ key: string;
	kind: BadgePerkKind | string;
	label: string;
	description?: string;
};

/** The Works this Badge opens, read from the Works' own Access tables. */
interface GatedWork {
	id: number;
	publicId: string;
	title: string;
	type: string;
	visibility: string;
}

function GatedWorks({ badgeId }: { badgeId: number }) {
	const [works, setWorks] = useState<GatedWork[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<number | null>(null);

	useEffect(() => {
		let live = true;
		apiFetch(`/api/content/badge-gates/${badgeId}`)
			.then(async (res) => {
				if (!live) return;
				if (!res.ok) {
					setError("Couldn't load the Works this Badge opens.");
					setWorks([]);
					return;
				}
				const body = (await res.json()) as { works: GatedWork[] };
				setWorks(body.works ?? []);
			})
			.catch(() => {
				if (live) {
					setError("Couldn't load the Works this Badge opens.");
					setWorks([]);
				}
			});
		return () => {
			live = false;
		};
	}, [badgeId]);

	const ungate = async (work: GatedWork) => {
		setBusyId(work.id);
		setError(null);
		try {
			const res = await apiFetch(`/api/content/badge-gates/${badgeId}/${work.id}`, {
				method: "DELETE",
			});
			if (!res.ok) {
				setError(await responseError(res, "Couldn't stop this Badge opening that Work."));
				return;
			}
			setWorks((prev) => (prev ?? []).filter((w) => w.id !== work.id));
		} catch {
			setError("Couldn't stop this Badge opening that Work.");
		} finally {
			setBusyId(null);
		}
	};

	return (
		<div className="mt-3 rounded-lg border border-base-300">
			<div className="border-b border-base-300 px-3 py-2">
				<div className="text-sm font-medium">Works this Badge opens</div>
				<p className="text-xs text-base-content/50">
					A Work joins this list when its Access table allows this Badge's level at $0. Open a
					Work's editor to change its gates; stop one here to close it for this Badge.
				</p>
			</div>

			{works === null ? (
				<p className="px-3 py-4 text-xs text-base-content/50">Loading Works…</p>
			) : works.length === 0 && !error ? (
				<p className="px-3 py-4 text-xs text-base-content/50">
					No Works are gated at this Badge yet. Open a Work's editor and tick this level in its
					Access table.
				</p>
			) : works.length === 0 ? null : (
				<ul className="divide-y divide-base-300">
					{works.map((work) => (
						<li key={work.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium">{work.title}</div>
								<div className="text-[11px] text-base-content/50">
									{work.type} · {work.visibility === "released" ? "Released" : "Not released"}
								</div>
							</div>
							<a
								href={studioUrl(`/works/${work.publicId}/edit`)}
								className="btn btn-ghost btn-xs"
								target="_blank"
								rel="noreferrer"
							>
								Open in Studio
							</a>
							<button
								type="button"
								className="btn btn-ghost btn-xs text-error"
								onClick={() => void ungate(work)}
								disabled={busyId === work.id}
							>
								{busyId === work.id ? "Stopping…" : "Stop opening"}
							</button>
						</li>
					))}
				</ul>
			)}

			{error && <p className="border-t border-base-300 px-3 py-2 text-xs text-error">{error}</p>}
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
	const creating = badge === null;
	const badgeId = badge?.id ?? null;
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

	// The art draft. Shape and color start from what the rung stored, and from the fallback
	// design's own color when the rung has never chosen one — otherwise the preview would
	// show the fallback's color and the saved composition would use a different one.
	const initialShape = badge?.artShape ?? DEFAULT_BADGE_SHAPE;
	const initialColor = badge?.artColor ?? fallback.color;
	const [shape, setShape] = useState(initialShape);
	const [color, setColor] = useState(initialColor);
	const [emblemMode, setEmblemMode] = useState<EmblemMode>(null);
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

	// A composed Badge is a finished image of the whole badge, shape and field included. A
	// new shape or background can only take effect through a new composition, because the
	// stored PNG already carries the old ones and the emblem color is not recoverable.
	const composedArt = Boolean(badge?.hasComposedArt);
	const artChoiceChanged = shape !== initialShape || color !== initialColor;
	const needsNewEmblemForChoice =
		composedArt && artChoiceChanged && !selection && !upload && !removed;
	// A row with no name is a blank the creator has not filled in yet, not a perk.
	const namedPerkCount = perks.filter((p) => p.label.trim()).length;

	// Perks are stored rows; load them for the editor (minting keys for React). The editor
	// stays mounted when a save refetches the ladder, so this reads once per Badge.
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
				const body = (await res.json()) as { perks: Omit<PerkDraft, "key">[] };
				setPerks((body.perks ?? []).map((p) => ({ ...p, key: crypto.randomUUID() })));
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
		if (badge?.hasArt && !removed) {
			return (
				<CreatorBadgeMark
					badgeId={badge.id}
					index={index}
					label={previewLabel}
					art={{ ...badge, artShape: shape, artColor: color }}
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
			if (!creating && perksLoaded && perks.some((p) => p.label.trim() && !p.kind)) {
				throw new Error("Choose a type for each perk that has a name.");
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
				onChanged?.();
				onClose();
				return;
			}

			const res = await client.api.subscriptions.badges[":id"].$patch({
				param: { id: String(badge.id) },
				json: {
					threshold: rungAmount(threshold),
					label: label.trim(),
					description: description.trim(),
				},
			});
			if (!res.ok) throw new Error("Couldn't save this Badge.");

			await saveArt(badge);

			// A failed read leaves the stored perks alone rather than replacing them with the
			// empty list the creator saw. The whole-list route makes an absent read destructive.
			if (perksLoaded) {
				const perksRes = await apiFetch(`/api/subscriptions/badges/${badge.id}/perks`, {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						perks: perks
							.filter((p) => p.label.trim())
							.map((p) => ({
								kind: p.kind,
								label: p.label.trim(),
								description: p.description ?? "",
							})),
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
	 * 🚨 **Compose writes shape and color itself**, so it runs alone. Upload and removal do
	 * not, so the shape/color choice is patched first and the file (or the removal) follows.
	 * A compose that fails leaves the previous art untouched, which is the server's own rule.
	 */
	const saveArt = async (stored: CreatorBadge) => {
		if (needsNewEmblemForChoice) {
			throw new Error(
				"This Badge's emblem is a finished image, so a new shape or background needs a new emblem. Find or upload one below.",
			);
		}
		const choiceChanged = artChoiceChanged;

		if (selection) {
			const res = await apiFetch(`/api/subscriptions/badges/${stored.id}/compose`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					noun: { id: selection.nounIcon.id },
					placement: {
						shape,
						fieldColor: color,
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
				body: JSON.stringify({ artShape: shape, artColor: color }),
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
		if (!badge) return;
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.badges[":id"].$delete({
				param: { id: String(badge.id) },
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

			<div className="flex flex-wrap items-start gap-3">
				<label className="form-control w-36 shrink-0">
					<span className="label-text mb-1 text-xs font-medium text-base-content/60">
						Monthly amount
					</span>
					<input
						type="number"
						aria-label="Monthly amount"
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

			<label className="form-control">
				<span className="label-text mb-1 text-xs font-medium text-base-content/60">
					Short description
				</span>
				<textarea
					className="textarea textarea-bordered textarea-sm w-full"
					rows={3}
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="What this level gives, in a sentence or two (optional)"
				/>
			</label>
		</div>
	);

	const emblemPanel = (
		<div className="flex h-full flex-col gap-3" data-testid="badge-art-control">
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

			<PickerRow label="Background Color">
				{BADGE_COLORS.map((col) => (
					<button
						key={col.id}
						type="button"
						aria-label={col.label}
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

			{needsNewEmblemForChoice && (
				<p className="rounded-box bg-warning/10 px-3 py-2 text-xs text-warning-content">
					This Badge's emblem is a finished image. A new shape or background needs a new emblem —
					find or upload one below.
				</p>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs font-medium text-base-content/60">Emblem</span>
				<div className="join">
					<button
						type="button"
						className={`btn btn-xs join-item ${emblemMode === "upload" ? "btn-primary" : "btn-outline"}`}
						aria-pressed={emblemMode === "upload"}
						onClick={() => setEmblemMode("upload")}
					>
						Upload an Emblem
					</button>
					<button
						type="button"
						className={`btn btn-xs join-item ${emblemMode === "find" ? "btn-primary" : "btn-outline"}`}
						aria-pressed={emblemMode === "find"}
						onClick={() => setEmblemMode("find")}
					>
						Find an Emblem
					</button>
				</div>
				{badge?.hasArt && !removed && !upload && !selection && (
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
				<PerkEditor perks={perks} onChange={setPerks} />
			)}
			{badgeId !== null && <GatedWorks badgeId={badgeId} />}
		</div>
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
							<>
								<p className="truncate text-sm text-base-content/60">
									{label.trim() || "Untitled"} ·{" "}
									{threshold.trim() ? `$${Number(threshold).toFixed(2)}/mo` : "No amount yet"}
								</p>
								<button
									type="button"
									className="btn btn-ghost btn-xs -ml-2 mt-1"
									onClick={() => setTab("emblem")}
								>
									{badge?.hasArt ? "Change the emblem" : "Give it your own emblem"}
								</button>
							</>
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
							{t.id === "perks" && perksLoaded && namedPerkCount > 0 ? ` (${namedPerkCount})` : ""}
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
