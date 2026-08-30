// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings card: the creator's **Badge ladder** — the rungs that populate every Work's
 * access table. Each rung is a Badge (label + monthly amount + description).
 * Wired to the subscriptions gates API (own seed-type gates only).
 *
 * 🚨 **Thresholds are DOLLARS, and any amount is expressible** (migration `0041`). They
 * were whole Seeds — an indivisible $3 unit — so a rung between two of them could not be
 * written down at all, which is why the input steps by 1 rather than by a cent, and why
 * the dollar figure beside it is
 * derived for display rather than typed.
 */

import type { BrandIconName } from "@anthers/brand";
import { BADGE_COLORS, BADGE_EMBLEMS, BADGE_SHAPES } from "@anthers/shared/badge-art";
import {
	amountLabel,
	BADGE_ART_MAX_BYTES,
	STRIPE_MIN_CHARGE,
	supportAmount,
} from "@anthers/shared/constants";
import { PencilIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { apiFetch, client } from "../../lib/rpc";
import type { CreatorGate } from "../../lib/types";
import { BrandGlyph } from "../decor/BrandGlyph";
import { CreatorBadgeMark } from "../economics/CreatorBadgeMark";
import { TakeHome } from "../economics/TakeHome";

/** Coerce to a monthly amount above zero — thresholds are dollars, cents included. */
function rungAmount(v: string): string {
	// ⚠️ **Never floor this.** Flooring a DOLLAR amount silently
	// turns a creator's $2.50 rung into $2 — the granularity the unit retirement removed,
	// reintroduced by a coercion nobody would look at twice.
	const n = supportAmount(v);
	return (n > 0 ? n : 1).toFixed(2);
}

/** "$6/mo" — the amount IS the gate now, so nothing has to be derived from it. */
function rungLabel(threshold: string | number): string {
	return `${amountLabel(threshold)}/mo`;
}

/**
 * The mark for one rung, and the way its art is changed.
 *
 * ⭐ **The mark is the control**, rather than a separate "upload" button beside a preview.
 * A creator picking art for a rung is looking at the rung, and what they want to press is
 * the picture — which also means the default is visible in the place the real art will
 * appear, so nothing about the ladder changes shape when a file lands.
 *
 * ⚠️ **Raster only, and the input says so.** An SVG is refused by the server, which cannot
 * safety-scan one without rasterizing it first, so accepting one here would only move the
 * refusal later and make it look like a bug.
 */
function BadgeArtControl({
	gate,
	index,
	onChanged,
	onError,
}: {
	gate: CreatorGate;
	index: number;
	onChanged: () => void;
	onError: (message: string | null) => void;
}) {
	const input = useRef<HTMLInputElement>(null);
	const [busy, setBusy] = useState(false);
	const [open, setOpen] = useState(false);

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
			const res = await apiFetch(`/api/subscriptions/gates/${gate.id}/art`, {
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
			const res = await apiFetch(`/api/subscriptions/gates/${gate.id}/art`, { method: "DELETE" });
			if (!res.ok) onError("Couldn't remove that art.");
			else onChanged();
		} finally {
			setBusy(false);
		}
	};

	/** Save one library choice. Null is how a creator goes back to the default. */
	const choose = async (patch: Record<string, string | null>) => {
		setBusy(true);
		onError(null);
		try {
			const res = await apiFetch(`/api/subscriptions/gates/${gate.id}`, {
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

	return (
		<div className="relative flex flex-col items-center gap-1">
			<button
				type="button"
				className="btn btn-ghost btn-square h-14 w-14 p-0"
				onClick={() => setOpen((o) => !o)}
				disabled={busy}
				title="Change this badge"
			>
				<CreatorBadgeMark gateId={gate.id} index={index} label={`${gate.label} badge`} art={gate} />
			</button>
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

			{open && (
				// ⭐ Shape, color and emblem are three separate choices, and that is the whole
				// point: a creator who cannot draw still ends up with a badge that is
				// recognizably theirs, without ever opening a file picker.
				<div className="absolute top-16 left-0 z-10 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
					<PickerRow label="Shape">
						{BADGE_SHAPES.map((s) => (
							<button
								key={s.id}
								type="button"
								aria-label={s.label}
								aria-pressed={gate.artShape === s.id}
								className={`btn btn-xs btn-square ${gate.artShape === s.id ? "btn-primary" : "btn-ghost"}`}
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

					<PickerRow label="Color">
						{BADGE_COLORS.map((col) => (
							<button
								key={col.id}
								type="button"
								aria-label={col.label}
								aria-pressed={gate.artColor === col.id}
								className={`h-5 w-5 rounded-full border ${gate.artColor === col.id ? "border-primary" : "border-base-300"}`}
								style={{ backgroundColor: col.fill }}
								onClick={() => choose({ artColor: col.id })}
								disabled={busy}
							/>
						))}
					</PickerRow>

					<PickerRow label="Emblem">
						{BADGE_EMBLEMS.map((name) => (
							<button
								key={name}
								type="button"
								aria-label={name}
								aria-pressed={gate.artEmblem === name}
								className={`btn btn-xs btn-square ${gate.artEmblem === name ? "btn-primary" : "btn-ghost"}`}
								onClick={() => choose({ artEmblem: name })}
								disabled={busy || gate.hasArt}
							>
								<BrandGlyph name={name as BrandIconName} className="h-4 w-4" />
							</button>
						))}
					</PickerRow>

					<div className="mt-2 flex items-center gap-2 border-t border-base-300 pt-2">
						<button
							type="button"
							className="btn btn-xs"
							onClick={() => input.current?.click()}
							disabled={busy}
						>
							{gate.hasArt ? "Replace art" : "Use my own art"}
						</button>
						{gate.hasArt && (
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

export default function BadgeLadderEditor() {
	const [gates, setGates] = useState<CreatorGate[]>([]);
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

	/**
	 * ⚠️ **Only the FIRST load blanks the ladder.** A refetch after a save used to set
	 * `loading` unconditionally, which swapped the whole list for "Loading…" and unmounted
	 * every rung — so a creator picking a shape watched the ladder flash and the picker
	 * close, and had to reopen it for the colour and again for the emblem. Three choices,
	 * three reopenings, for a component whose entire point is mixing and matching. Found in
	 * the browser; nothing in the API tests could have shown it.
	 */
	const fetchGates = () => {
		setLoading((wasLoading) => wasLoading || gates.length === 0);
		client.api.subscriptions.gates
			.$get()
			.then(async (res) => {
				if (!res.ok) {
					setGates([]);
					return;
				}
				const data = (await res.json()) as { gates: CreatorGate[] };
				setGates((data.gates ?? []).filter((g) => g.gateType === "seed"));
			})
			.catch(() => setGates([]))
			.finally(() => setLoading(false));
	};

	useEffect(fetchGates, []);

	const handleAdd = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!newLabel.trim() || !newThreshold.trim()) return;
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.gates.$post({
				json: {
					threshold: rungAmount(newThreshold),
					label: newLabel.trim(),
					description: newDescription.trim(),
					gateType: "seed",
				},
			});
			if (!res.ok) throw new Error("Failed to add rung.");
			setNewLabel("");
			setNewThreshold("");
			setNewDescription("");
			fetchGates();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to add rung.");
		} finally {
			setSaving(false);
		}
	};

	const startEdit = (gate: CreatorGate) => {
		setEditingId(gate.id);
		setEditLabel(gate.label);
		setEditThreshold(gate.threshold);
		setEditDescription(gate.description ?? "");
	};

	const handleSaveEdit = async (id: number) => {
		setSaving(true);
		setError(null);
		try {
			const res = await client.api.subscriptions.gates[":id"].$patch({
				param: { id: String(id) },
				json: {
					threshold: rungAmount(editThreshold),
					label: editLabel.trim(),
					description: editDescription.trim(),
				},
			});
			if (!res.ok) throw new Error("Failed to save rung.");
			setEditingId(null);
			fetchGates();
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
			const res = await client.api.subscriptions.gates[":id"].$delete({
				param: { id: String(id) },
			});
			if (!res.ok) throw new Error("Failed to delete rung.");
			fetchGates();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to delete rung.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Badge Ladder</h3>
				<p className="text-sm text-base-content/60 mb-2">
					Badges let supporters unlock work by giving you a monthly amount — you choose the levels,
					at any amount you like. They appear as rows in every Work's access table.
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
						{gates.length === 0 && (
							<p className="text-sm text-base-content/50">No seed rungs yet.</p>
						)}
						{gates.map((gate) =>
							editingId === gate.id ? (
								<div key={gate.id} className="flex flex-col gap-2 p-3 bg-base-100 rounded-lg">
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
									<div className="flex gap-2">
										<button
											type="button"
											className="btn btn-primary btn-xs"
											onClick={() => handleSaveEdit(gate.id)}
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
								<div key={gate.id} className="flex items-center gap-2 p-3 bg-base-100 rounded-lg">
									<BadgeArtControl
										gate={gate}
										index={gates.indexOf(gate)}
										onChanged={fetchGates}
										onError={setError}
									/>
									<div className="flex-1">
										<div className="flex items-center gap-2">
											<span className="font-medium text-sm">{gate.label}</span>
											<span className="badge badge-sm">{rungLabel(gate.threshold)}</span>
										</div>
										{gate.description && (
											<p className="text-xs text-base-content/50">{gate.description}</p>
										)}
									</div>
									<button
										type="button"
										className="btn btn-ghost btn-xs btn-square"
										onClick={() => startEdit(gate)}
										title="Edit rung"
									>
										<PencilIcon className="w-4 h-4" />
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-xs btn-square text-error"
										onClick={() => handleDelete(gate.id)}
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
