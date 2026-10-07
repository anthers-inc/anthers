// SPDX-License-Identifier: Apache-2.0
/**
 * Settings card: the **Badge Maker** — the one place a creator makes a Badge.
 *
 * 🚨 **This replaces the Badge rung editor rather than adding a picker beside it**
 * (Parker, 2026-09-13): naming a rung, setting its monthly amount, describing it, and
 * designing its art are one tool's four jobs. Studio settings renders this card where
 * the old editor sat.
 *
 * 🚨 **There are no standard creator Badges any more.** A creator's Badge art is built
 * from the Noun Project catalog here or uploaded as their own file, and nothing else —
 * the old mix-and-match emblem library is retired for creators. **A rung with no art of
 * its own falls back to Anthers' own Badge designs by ladder position** (`index % 4`); *
 * that is a fallback and a start, not a design to settle for, so an untouched rung says
 * so and invites the creator to give it an emblem of their own.
 *
 * ⭐ **Composition happens at save, and an unchanged save is free** — the server dedupes
 * on the composition fingerprint before it spends anything, so a creator pressing save
 * repeatedly costs the platform nothing.
 */

import {
	BADGE_COLORS,
	BADGE_PERK_KINDS,
	BADGE_SHAPES,
	type BadgePerkKind,
} from "@anthers/shared/badge-art";
import {
	amountLabel,
	BADGE_ART_MAX_BYTES,
	STRIPE_MIN_CHARGE,
	supportAmount,
} from "@anthers/shared/constants";
import { PencilIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { apiFetch, client } from "../../lib/rpc";
import type { CreatorBadge } from "../../lib/types";
import { CreatorBadgeMark } from "../economics/CreatorBadgeMark";
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

/** "$6/mo" — the amount IS the rung now, so nothing has to be derived from it. */
function rungLabel(threshold: string | number): string {
	return `${amountLabel(threshold)}/mo`;
}

/**
 * The art control for one rung: shape, field color, the Noun Project catalog, or the
 * creator's own upload — the four art choices in one place, with the rung's own mark as
 * the button that opens them.
 */
function BadgeArtControl({
	badge,
	index,
	onChanged,
	onError,
}: {
	badge: CreatorBadge;
	index: number;
	onChanged: () => void;
	onError: (message: string | null) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [_open, _setOpen] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [composing, setComposing] = useState(false);

	const upload = async (file: File) => {
		onError(null);
		if (file.size > BADGE_ART_MAX_BYTES) {
			onError("That image is too large — 4 MB at most.");
			return;
		}
		setBusy(true);
		try {
			const body = new FormData();
			body.append("file", file);
			const res = await apiFetch(`/api/subscriptions/badges/${badge.id}/art`, {
				method: "POST",
				body,
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => null)) as { error?: string } | null;
				// The server's own words: "that file is not an image we can read" is more use
				// than anything this component could guess.
				onError(detail?.error ?? "That art didn't go through.");
				return;
			}
			onChanged();
		} catch {
			onError("That art didn't go through.");
		} finally {
			setBusy(false);
			if (input.current) input.current.value = "";
		}
	};

	const clear = async () => {
		setBusy(true);
		onError(null);
		try {
			const res = await apiFetch(`/api/subscriptions/badges/${badge.id}/art`, { method: "DELETE" });
			if (!res.ok) onError("Couldn't remove that art.");
			else onChanged();
		} finally {
			setBusy(false);
		}
	};

	/** Save one library choice (shape or field color) — server-validated against the list. */
	const choose = async (patch: Record<string, string | null>) => {
		setBusy(true);
		onError(null);
		try {
			const res = await apiFetch(`/api/subscriptions/badges/${badge.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			if (!res.ok) onError("Couldn't save that choice.");
			else onChanged();
		} catch {
			onError("Couldn't save that choice.");
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Compose the held placement into the rung's art.
	 *
	 * 🚨 The compose route composes, rasterizes and discards the vendor's vector inside
	 * one request and stores only the finished Badge — this client never sees an icon
	 * file, because there is deliberately no such artifact anywhere in the product.
	 */
	const savePlacement = async (placement: EmblemPlacement) => {
		setComposing(true);
		onError(null);
		try {
			const res = await apiFetch(`/api/subscriptions/badges/${badge.id}/compose`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					noun: { id: placement.nounIcon.id },
					placement: {
						shape: badge.artShape ?? "circle",
						fieldColor: badge.artColor ?? "moss",
						emblemColor: placement.emblemColor,
						scale: placement.scale,
						offsetX: placement.offsetX,
						offsetY: placement.offsetY,
					},
				}),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => null)) as { error?: string } | null;
				onError(detail?.error ?? "Couldn't compose that emblem.");
				return;
			}
			setPickerOpen(false);
			onChanged();
		} catch {
			onError("Couldn't compose that emblem.");
		} finally {
			setComposing(false);
		}
	};

	return (
		<div className="relative flex flex-col items-center gap-1">
			<button
				type="button"
				className="btn btn-ghost btn-square h-14 w-14 p-0"
				onClick={() => setPickerOpen((o) => !o)}
				disabled={busy || composing}
				title="Change this badge"
			>
				<CreatorBadgeMark
					badgeId={badge.id}
					index={index}
					label={`${badge.label} badge`}
					art={badge}
				/>
			</button>
			{!badge.hasArt && (
				// The fallback is a start, not a design to settle for — say so where the
				// creator is looking at it.
				<span className="text-[10px] text-base-content/50 max-w-16 text-center leading-tight">
					Give it your own emblem
				</span>
			)}
			<input
				ref={input}
				type="file"
				accept="image/png,image/jpeg,image/webp"
				className="hidden"
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) upload(file);
				}}
			/>

			{pickerOpen && (
				<div className="absolute top-16 left-0 z-10 w-96 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
					<PickerRow label="Shape">
						{BADGE_SHAPES.map((s) => (
							<button
								key={s.id}
								type="button"
								aria-label={s.label}
								aria-pressed={badge.artShape === s.id}
								className={`btn btn-xs btn-square ${badge.artShape === s.id ? "btn-primary" : "btn-ghost"}`}
								onClick={() => choose({ artShape: s.id })}
								disabled={busy}
							>
								<svg viewBox="0 0 100 100" className="h-4 w-4" aria-hidden="true">
									<title>{s.label}</title>
									<path d={s.path} fill="currentColor" />
								</svg>
							</button>
						))}
					</PickerRow>

					<PickerRow label="Field color">
						{BADGE_COLORS.map((col) => (
							<button
								key={col.id}
								type="button"
								aria-label={col.label}
								aria-pressed={badge.artColor === col.id}
								className={`h-5 w-5 rounded-full border ${badge.artColor === col.id ? "border-primary" : "border-base-300"}`}
								style={{ backgroundColor: col.fill }}
								onClick={() => choose({ artColor: col.id })}
								disabled={busy}
							/>
						))}
					</PickerRow>

					{/* 🚨 The catalog. Every emblem here is somebody's artwork, shown with the
					    artist's name — byline in the picker, credit on the Badge itself. */}
					<div className="mt-3 border-t border-base-300 pt-3">
						<div className="mb-2 flex items-baseline justify-between">
							<div className="text-xs font-medium text-base-content/60">
								Emblem from the Noun Project
							</div>
							<span className="text-[10px] text-base-content/40">
								nearly ten million icons, every one by a named artist
							</span>
						</div>
						<NounEmblemPicker
							onSave={(p) => void savePlacement(p)}
							onCancel={() => setPickerOpen(false)}
							busy={busy || composing}
						/>
					</div>

					<div className="mt-2 flex items-center gap-2 border-t border-base-300 pt-2">
						<button
							type="button"
							className="btn btn-xs"
							onClick={() => input.current?.click()}
							disabled={busy}
						>
							{badge.hasArt ? "Replace art" : "Use my own art"}
						</button>
						{badge.hasArt && (
							<button
								type="button"
								className="btn btn-ghost btn-xs text-base-content/50"
								onClick={clear}
								disabled={busy}
							>
								Remove
							</button>
						)}
					</div>
					{/* Said here rather than discovered at the refusal: the server cannot
					    safety-scan an SVG without rasterizing it first, so it refuses one. */}
					<p className="mt-1 text-[11px] text-base-content/50">
						PNG, JPEG or WebP. Your art sits on the background you picked.
					</p>
				</div>
			)}
		</div>
	);
}

function PickerRow({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mb-2">
			<div className="mb-1 text-xs font-medium text-base-content/60">{label}</div>
			<div className="flex flex-wrap items-center gap-1">{children}</div>
		</div>
	);
}

/**
 * The perk editor for one rung — a whole-list editor over the fixed category list.
 *
 * ⭐ **Each category carries its friendly explanation, not tax language** (Parker,
 * 2026-09-15), and the line telling a creator who is unsure which applies what to do is
 * the posture's own: write to support@anthers.org.
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
	const remove = (i: number) => onChange(perks.filter((_, j) => j !== i));
	const add = (kind: string) => {
		const kindDef = BADGE_PERK_KINDS.find((k) => k.id === kind);
		onChange([
			...perks,
			{ key: crypto.randomUUID(), kind, label: "", description: kindDef?.friendly ?? "" },
		]);
	};

	return (
		<div className="rounded-lg border border-base-300 p-2">
			<div className="mb-1 flex items-baseline justify-between">
				<div className="text-xs font-medium text-base-content/60">
					Perks — what supporters receive
				</div>
				<span className="text-[10px] text-base-content/40">
					access to gated works is added automatically
				</span>
			</div>
			{perks.map((perk, i) => (
				// Keyed on the row's own stable key (minted when the row was added) — the
				// index reorders badly on a remove, and a kind+label pair collides when two
				// perks of one kind share a label.
				<div key={perk.key} className="mb-2 flex flex-wrap items-center gap-1">
					<select
						className="select select-bordered select-xs w-40"
						value={String(perk.kind)}
						onChange={(e) => update(i, { kind: e.target.value })}
					>
						{BADGE_PERK_KINDS.map((k) => (
							<option key={k.id} value={k.id}>
								{k.label}
							</option>
						))}
					</select>
					<input
						type="text"
						className="input input-bordered input-xs flex-1 min-w-40"
						value={perk.label}
						onChange={(e) => update(i, { label: e.target.value })}
						placeholder="What supporters get, in your words"
					/>
					<button
						type="button"
						className="btn btn-ghost btn-xs btn-square text-error"
						onClick={() => remove(i)}
						title="Remove perk"
					>
						<TrashIcon className="w-3.5 h-3.5" />
					</button>
				</div>
			))}
			{perks.length < 10 && (
				<select
					className="select select-bordered select-xs w-52"
					value=""
					onChange={(e) => e.target.value && add(e.target.value)}
				>
					<option value="">Add a perk…</option>
					{BADGE_PERK_KINDS.map((k) => (
						<option key={k.id} value={k.id}>
							{k.label}
						</option>
					))}
				</select>
			)}
			{perks.length > 0 && (
				<p className="mt-1 text-[11px] text-base-content/50">
					{BADGE_PERK_KINDS.find((k) => k.id === String(perks[perks.length - 1]?.kind))?.friendly}
				</p>
			)}
			<p className="mt-1 text-[11px] text-base-content/50">
				Not sure which applies? Write to support@anthers.org.
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

export default function BadgeMaker() {
	const [badges, setBadges] = useState<CreatorBadge[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// New-rung form
	const [newLabel, setNewLabel] = useState("");
	const [newThreshold, setNewThreshold] = useState("");
	const [newDescription, setNewDescription] = useState("");

	// Inline edit
	const [editingId, setEditingId] = useState<number | null>(null);
	const [editLabel, setEditLabel] = useState("");
	const [editThreshold, setEditThreshold] = useState("");
	const [editDescription, setEditDescription] = useState("");
	// Perks, edited with the rung and saved as one whole-list replace.
	const [editPerks, setEditPerks] = useState<PerkDraft[]>([]);

	/**
	 * ⚠️ **Only the FIRST load blanks the ladder.** A refetch after a save used to set
	 * `loading` unconditionally, which swapped the whole list for "Loading…" and unmounted
	 * every rung — so a creator picking a shape watched the ladder flash and the picker
	 * close, and had to reopen it for the color and again for the emblem. Three choices,
	 * three reopenings, for a component whose entire point is mixing and matching. Found in
	 * the browser; nothing in the API tests could have shown it.
	 */
	const fetchBadges = () => {
		setLoading((wasLoading) => wasLoading || badges.length === 0);
		client.api.subscriptions.badges
			.$get()
			.then(async (res) => {
				if (!res.ok) {
					setBadges([]);
					return;
				}
				const data = (await res.json()) as { badges: CreatorBadge[] };
				// Every rung the ladder holds is the creator's own Badge — there is no
				// `gateType` to filter on, and no cross-issuer rung to exclude.
				setBadges(data.badges ?? []);
			})
			.catch(() => setBadges([]))
			.finally(() => setLoading(false));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: the first load only. A save refetches by calling `fetchBadges` directly, and depending on `badges.length` would refetch every time a rung is added.
	useEffect(fetchBadges, []);

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newLabel.trim() || !newThreshold.trim()) return;
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.badges.$post({
				json: {
					threshold: rungAmount(newThreshold),
					label: newLabel.trim(),
					description: newDescription.trim(),
				},
			});
			if (!res.ok) throw new Error("Failed to add rung.");
			setNewLabel("");
			setNewThreshold("");
			setNewDescription("");
			fetchBadges();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to add rung.");
		} finally {
			setSaving(false);
		}
	};

	const startEdit = async (badge: CreatorBadge) => {
		setEditingId(badge.id);
		setEditLabel(badge.label);
		setEditThreshold(badge.threshold);
		setEditDescription(badge.description ?? "");
		// Perks are stored rows; load them for the editor (minting keys for React).
		setEditPerks([]);
		try {
			const res = await apiFetch(`/api/subscriptions/badges/${badge.id}/perks`);
			if (res.ok) {
				const body = (await res.json()) as { perks: Omit<PerkDraft, "key">[] };
				setEditPerks((body.perks ?? []).map((p) => ({ ...p, key: crypto.randomUUID() })));
			}
		} catch {
			// The editor opens with none on a failed read; saving sends the empty list,
			// which is the honest state the creator saw.
		}
	};

	const handleSaveEdit = async (id: number) => {
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.badges[":id"].$patch({
				param: { id: String(id) },
				json: {
					threshold: rungAmount(editThreshold),
					label: editLabel.trim(),
					description: editDescription.trim(),
				},
			});
			if (!res.ok) throw new Error("Failed to save rung.");
			// Perks ride along as their own whole-list replace, so one save settles both.
			const perksRes = await apiFetch(`/api/subscriptions/badges/${id}/perks`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					perks: editPerks
						.filter((p) => p.label.trim())
						.map((p) => ({
							kind: p.kind,
							label: p.label.trim(),
							description: p.description ?? "",
						})),
				}),
			});
			if (!perksRes.ok) throw new Error("Failed to save perks.");
			setEditingId(null);
			fetchBadges();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to save rung.");
		} finally {
			setSaving(false);
		}
	};

	const handleDelete = async (id: number) => {
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.badges[":id"].$delete({
				param: { id: String(id) },
			});
			if (!res.ok) throw new Error("Failed to delete rung.");
			fetchBadges();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete rung.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Badge Maker</h3>
				<p className="text-sm text-base-content/60 mb-2">
					Badges let supporters unlock work by giving you a monthly amount — you choose the levels,
					at any amount you like. Design each Badge here: its shape, field color and emblem, drawn
					from the Noun Project catalog where every emblem was made by a named artist, or your own
					art. They appear as rows in every Work's access table.
				</p>

				{error && (
					<div className="alert alert-error text-sm mb-2">
						<span>{error}</span>
					</div>
				)}

				{loading ? (
					<p className="text-sm text-base-content/50">Loading...</p>
				) : (
					<div className="flex flex-col gap-2">
						{badges.length === 0 && <p className="text-sm text-base-content/50">No rungs yet.</p>}
						{badges.map((badge) =>
							editingId === badge.id ? (
								<div key={badge.id} className="flex flex-col gap-2 p-3 bg-base-100 rounded-lg">
									<div className="flex flex-wrap gap-2">
										<input
											type="text"
											className="input input-bordered input-sm flex-1 min-w-40"
											value={editLabel}
											onChange={(e) => setEditLabel(e.target.value)}
											placeholder="Label (e.g. Supporter)"
										/>
										<input
											type="number"
											className="input input-bordered input-sm w-28"
											value={editThreshold}
											onChange={(e) => setEditThreshold(e.target.value)}
											min={STRIPE_MIN_CHARGE}
											step="0.01"
											placeholder="$/mo"
										/>
									</div>
									<TakeHome amount={Number(editThreshold) || 0} kind="badge" />
									<input
										type="text"
										className="input input-bordered input-sm w-full"
										value={editDescription}
										onChange={(e) => setEditDescription(e.target.value)}
										placeholder="Description (optional)"
									/>

									{/* 🚨 PERKS. What a supporter gets beside access. Access itself is
									    read from the Work gates — never typed here. The categories are
									    the sales-tax posture's: a rung is taxed at its most-taxable
									    kind, which the creator should know is why the tag matters. */}
									<PerkEditor perks={editPerks} onChange={setEditPerks} />

									<div className="flex gap-2">
										<button
											type="button"
											className="btn btn-primary btn-xs"
											onClick={() => handleSaveEdit(badge.id)}
											disabled={saving || !editLabel.trim() || !editThreshold.trim()}
										>
											Save
										</button>
										<button
											type="button"
											className="btn btn-ghost btn-xs"
											onClick={() => setEditingId(null)}
										>
											Cancel
										</button>
									</div>
								</div>
							) : (
								<div key={badge.id} className="flex items-center gap-2 p-3 bg-base-100 rounded-lg">
									<BadgeArtControl
										badge={badge}
										index={badges.indexOf(badge)}
										onChanged={fetchBadges}
										onError={setError}
									/>
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<span className="font-medium text-sm">{badge.label}</span>
											<span className="badge badge-sm">{rungLabel(badge.threshold)}</span>
										</div>
										{badge.description && (
											<p className="text-xs text-base-content/50">{badge.description}</p>
										)}
									</div>
									<button
										type="button"
										className="btn btn-ghost btn-xs btn-square"
										onClick={() => startEdit(badge)}
										title="Edit rung"
									>
										<PencilIcon className="w-4 h-4" />
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs btn-square text-error"
										onClick={() => handleDelete(badge.id)}
										disabled={saving}
										title="Delete rung"
									>
										<TrashIcon className="w-4 h-4" />
									</button>
								</div>
							),
						)}

						{/* Add a new rung */}
						<form
							onSubmit={handleAdd}
							className="flex flex-col gap-2 mt-2 border-t border-base-300 pt-3"
						>
							<div className="flex flex-wrap gap-2">
								<input
									type="text"
									className="input input-bordered input-sm flex-1 min-w-40"
									value={newLabel}
									onChange={(e) => setNewLabel(e.target.value)}
									placeholder="Label (e.g. Supporter)"
								/>
								<input
									type="number"
									className="input input-bordered input-sm w-28"
									value={newThreshold}
									onChange={(e) => setNewThreshold(e.target.value)}
									min={STRIPE_MIN_CHARGE}
									step="0.01"
									placeholder="$/mo"
								/>
							</div>
							{/* 🚨 Beside the field the creator is typing in. Until 2026-08-16 this input
							    stepped whole $3 units, so there was nothing to explain — every level
							    was a multiple and the deduction was always ~13%. With any amount
							    allowed, a $1 rung is legal and keeps 67%, and the creator should see
							    that before they choose rather than discover it on a payout. */}
							<TakeHome amount={Number(newThreshold) || 0} kind="badge" />
							<input
								type="text"
								className="input input-bordered input-sm w-full"
								value={newDescription}
								onChange={(e) => setNewDescription(e.target.value)}
								placeholder="Description (optional)"
							/>
							<button
								type="submit"
								className="btn btn-primary btn-sm w-fit"
								disabled={saving || !newLabel.trim() || !newThreshold.trim()}
							>
								Add rung
							</button>
						</form>
					</div>
				)}
			</div>
		</div>
	);
}
