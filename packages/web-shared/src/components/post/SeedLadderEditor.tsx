// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings card: the creator's Seed ladder — the rungs that populate every post's
 * Seed Access table. Each rung is a Seed gate (label + Seed threshold + description).
 * Wired to the subscriptions gates API (own seed-type gates only).
 *
 * Thresholds are **whole Seeds**, not dollars (migration `0007`). A Seed is an
 * indivisible $3 unit, so a rung between two whole Seeds is not expressible — which is
 * why the input steps by 1 rather than by a cent, and why the dollar figure beside it is
 * derived for display rather than typed.
 */
import { SEED_PRICE } from "@anthers/shared/constants";
import { PencilIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { client } from "../../lib/rpc";
import type { CreatorGate } from "../../lib/types";

/** Coerce to a whole Seed count ≥ 1 — the API stores thresholds as whole Seeds. */
function wholeSeeds(v: string): string {
	const n = Math.floor(Number(v));
	if (!Number.isFinite(n) || n < 1) return "1";
	return String(n);
}

/** "2 Seeds ($6/mo)" — the count is the gate; the money is derived for the creator's sake. */
function rungLabel(threshold: string | number): string {
	const seeds = Math.max(0, Math.floor(Number(threshold) || 0));
	return `${seeds} Seed${seeds === 1 ? "" : "s"} ($${seeds * SEED_PRICE}/mo)`;
}

export default function SeedLadderEditor() {
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

	const fetchGates = () => {
		setLoading(true);
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
					threshold: wholeSeeds(newThreshold),
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
					threshold: wholeSeeds(editThreshold),
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
				<h3 className="card-title text-lg">Seed Ladder</h3>
				<p className="text-sm text-base-content/60 mb-2">
					Seed rungs let supporters unlock content by giving you a number of Seeds — ${SEED_PRICE}
					/mo each. These rungs appear as rows in every post's Seed Access table.
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
											min="1"
											step="1"
											placeholder="Seeds"
										/>
									</div>
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
									min="1"
									step="1"
									placeholder="Seeds"
								/>
							</div>
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
