// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The parental-controls panel — a pin, and five things it protects.
 *
 * 🚨 **The pin travels with every save rather than opening a session, and that is the design
 * rather than an oversight.** An "unlocked" state would leave the panel open on a shared
 * device for whoever picked it up next — which, for this feature, is exactly the person it
 * restricts. Typing four digits per change is a small cost against a lock that stays locked.
 *
 * ⚠️ **Nothing here is the enforcement.** Every control is re-checked server-side, because the
 * account holder may be the person being restricted and they hold the session by definition —
 * so a panel that merely hid the switches would be lifted by anyone who opened a network tab.
 * What this file is for is making the rules legible: a guardian who cannot see what they set
 * will set the wrong thing.
 *
 * 📌 **The time limits say "watching, reading and playing", never "screen time".** Anthers
 * measures time spent consuming Works and nothing else — browsing a catalog writes no event
 * and cannot honestly be counted — so calling it screen time would promise a measurement that
 * does not exist, and a guardian would discover the gap by watching a child sit on the site
 * all evening with the limit untouched.
 */

import {
	PARENTAL_MEDIA_TYPES,
	type ParentalList,
	type ParentalPolicy,
} from "@anthers/shared/parental-controls";
import { displayHandle } from "@anthers/web-shared/profile";
import { apiFetch } from "@anthers/web-shared/rpc";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

/** Minutes in the input, seconds on the wire — nobody sets a limit in seconds. */
function toMinutes(seconds: number | null): string {
	return seconds == null ? "" : String(Math.round(seconds / 60));
}
function toSeconds(minutes: string): number | null {
	const n = Number(minutes);
	return minutes.trim() === "" || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 60);
}

export default function ParentalControlsSection() {
	const [policy, setPolicy] = useState<ParentalPolicy | null>(null);
	const [pin, setPin] = useState("");
	const [newPin, setNewPin] = useState("");
	const [confirmPin, setConfirmPin] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const [username, setUsername] = useState("");
	/**
	 * Creator id → the name to show.
	 *
	 * The rules store **ids**, not handles, and that is deliberate: a creator who changes their
	 * username must not silently fall off a guardian's list. The cost is that the panel has to
	 * look names up to be readable, which is what this is; a rule whose name has not arrived
	 * shows its id rather than disappearing.
	 */
	const [names, setNames] = useState<Record<string, string>>({});

	const load = useCallback(async () => {
		try {
			const res = await apiFetch("/api/accounts/me/parental-controls");
			if (res.ok) setPolicy((await res.json()) as ParentalPolicy);
		} catch {
			/* the panel simply doesn't render; nothing is enforced from here anyway */
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const save = async (update: Record<string, unknown>) => {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const res = await apiFetch("/api/accounts/me/parental-controls", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin, ...update }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "That couldn't be saved.");
				return;
			}
			setPolicy((await res.json()) as ParentalPolicy);
			setSaved(true);
		} catch {
			setError("That couldn't be saved.");
		} finally {
			setBusy(false);
		}
	};

	/** Resolve a handle to an id, then add it to the list in whichever direction it runs. */
	const addCreator = async () => {
		const handle = username.trim();
		if (!handle) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/accounts/users/${encodeURIComponent(handle)}`);
			if (!res.ok) {
				setError(`No creator called ${displayHandle(handle)}.`);
				return;
			}
			const { user } = (await res.json()) as { user: { id: number; username: string } };
			const key = String(user.id);
			const current = policy?.creators ?? { defaultAllow: true, rules: [] };
			if (current.rules.some((r) => r.key === key)) {
				setUsername("");
				return;
			}
			setNames((n) => ({ ...n, [key]: user.username }));
			await save({
				creators: {
					...current,
					// The entry means "reachable" under an allowlist and "not" under a blocklist —
					// one control, whichever way the list is running.
					rules: [...current.rules, { key, allow: !current.defaultAllow, dailySeconds: null }],
				},
			});
			setUsername("");
		} catch {
			setError("That couldn't be looked up.");
		} finally {
			setBusy(false);
		}
	};

	const setThePin = async () => {
		setBusy(true);
		setError(null);
		try {
			if (newPin !== confirmPin) {
				setError("Those two pins don't match.");
				return;
			}
			const res = await apiFetch("/api/accounts/me/parental-controls/pin", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: newPin, ...(policy?.enabled ? { currentPin: pin } : {}) }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "That pin couldn't be set.");
				return;
			}
			setPolicy((await res.json()) as ParentalPolicy);
			setPin(newPin);
			setNewPin("");
			setConfirmPin("");
		} catch {
			setError("That pin couldn't be set.");
		} finally {
			setBusy(false);
		}
	};

	const turnOff = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/parental-controls", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin }),
			});
			if (!res.ok) {
				setError("That isn't the pin.");
				return;
			}
			setPolicy((await res.json()) as ParentalPolicy);
			setPin("");
		} finally {
			setBusy(false);
		}
	};

	if (!policy) return null;

	// ── No pin yet ────────────────────────────────────────────────────────────
	if (!policy.enabled) {
		return (
			<section className="card bg-base-100 shadow-sm">
				<div className="card-body gap-4">
					<h2 className="card-title gap-2 text-lg">
						<LockClosedIcon className="h-5 w-5" />
						Parental controls
					</h2>
					<p className="max-w-prose text-sm text-base-content/70">
						Set a pin and you can lock this account's content settings, choose which creators and
						which kinds of work it can reach, and cap how long it spends watching, reading and
						playing. The pin is asked for on every change, so it can't be undone from this account
						without it.
					</p>
					{/* ⚠️ Said plainly and up front, because the alternative is somebody discovering it
					    at the worst possible moment. */}
					<p className="max-w-prose text-sm text-warning">
						There's no way to reset a forgotten pin from here — a reset link would go to this
						account's own inbox, which is often the inbox of the person the pin is for. If you lose
						it, you'll need to contact us.
					</p>
					<div className="flex flex-wrap items-end gap-2">
						<label className="form-control">
							<span className="label-text text-xs">New pin (4–8 digits)</span>
							<input
								type="password"
								inputMode="numeric"
								value={newPin}
								onChange={(e) => setNewPin(e.target.value)}
								className="input input-bordered input-sm w-40"
							/>
						</label>
						<label className="form-control">
							<span className="label-text text-xs">Again</span>
							<input
								type="password"
								inputMode="numeric"
								value={confirmPin}
								onChange={(e) => setConfirmPin(e.target.value)}
								className="input input-bordered input-sm w-40"
							/>
						</label>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={setThePin}
							disabled={busy || !newPin}
						>
							Set pin
						</button>
					</div>
					{error && <p className="text-sm text-error">{error}</p>}
				</div>
			</section>
		);
	}

	const creators = policy.creators;
	const types = policy.types;

	/** Toggle a media type in the list, keeping whichever direction the list is running in. */
	const toggleType = (key: string) => {
		const existing = types.rules.find((r) => r.key === key);
		const rules = existing
			? types.rules.filter((r) => r.key !== key)
			: [...types.rules, { key, allow: !types.defaultAllow, dailySeconds: null }];
		void save({ types: { ...types, rules } satisfies ParentalList });
	};

	return (
		<section className="card bg-base-100 shadow-sm">
			<div className="card-body gap-5">
				<h2 className="card-title gap-2 text-lg">
					<LockClosedIcon className="h-5 w-5" />
					Parental controls
				</h2>

				<label className="form-control max-w-xs">
					<span className="label-text text-xs">Pin — needed for every change below</span>
					<input
						type="password"
						inputMode="numeric"
						value={pin}
						onChange={(e) => setPin(e.target.value)}
						className="input input-bordered input-sm"
						placeholder="Enter pin"
					/>
				</label>

				{/* ── The rating settings ── */}
				<div className="space-y-2 border-t border-base-300 pt-4">
					<label className="flex items-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-sm mt-0.5"
							checked={policy.lockMaturity}
							disabled={busy || !pin}
							onChange={(e) => save({ lockMaturity: e.target.checked })}
						/>
						<span className="text-sm">
							<strong>Lock the content settings.</strong> Mature and Adult are separate switches and
							both are locked together — a reader who wants difficult work unblurred hasn't said
							anything about explicit work, so it's worth setting them before you lock.
						</span>
					</label>
					{/* ⭐ Worth saying so the pin isn't over-trusted in either direction. */}
					<p className="max-w-prose pl-11 text-xs text-base-content/50">
						Adult work already needs adulthood verified by a credit card on this account, so it
						isn't reachable by flipping a setting — but a parent's card would pass, which is the gap
						this closes.
					</p>
				</div>

				{/* ── Media types ── */}
				<div className="space-y-2 border-t border-base-300 pt-4">
					<p className="text-sm font-semibold">Kinds of work</p>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="toggle toggle-sm"
							checked={!types.defaultAllow}
							disabled={busy || !pin}
							onChange={(e) => save({ types: { defaultAllow: !e.target.checked, rules: [] } })}
						/>
						Only allow the kinds I pick
					</label>
					<div className="flex flex-wrap gap-2 pl-1">
						{PARENTAL_MEDIA_TYPES.map((t) => {
							const listed = types.rules.some((r) => r.key === t.value);
							// One checkbox, two meanings, matching whichever way the list runs — which is
							// the point of the single list shape. "Checked" always means reachable.
							const reachable = listed ? !types.defaultAllow : types.defaultAllow;
							return (
								<label
									key={t.value}
									className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm ${
										reachable ? "border-base-300" : "border-base-300 opacity-50"
									}`}
								>
									<input
										type="checkbox"
										className="checkbox checkbox-xs"
										checked={reachable}
										disabled={busy || !pin}
										onChange={() => toggleType(t.value)}
									/>
									{t.label}
								</label>
							);
						})}
					</div>
				</div>

				{/* ── Creators ── */}
				<div className="space-y-2 border-t border-base-300 pt-4">
					<p className="text-sm font-semibold">Creators</p>
					<label className="flex items-center gap-2 text-sm">
						<input
							type="checkbox"
							className="toggle toggle-sm"
							checked={!creators.defaultAllow}
							disabled={busy || !pin}
							onChange={(e) =>
								save({ creators: { defaultAllow: !e.target.checked, rules: creators.rules } })
							}
						/>
						Only allow the creators on the list
					</label>
					<p className="max-w-prose text-xs text-base-content/50">
						{creators.defaultAllow
							? "Everyone is reachable except the creators listed here."
							: "Only the creators listed here are reachable."}
					</p>
					<div className="flex flex-wrap items-end gap-2">
						<label className="form-control">
							<span className="label-text text-xs">Add by username</span>
							<input
								type="text"
								value={username}
								onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))}
								placeholder="creator"
								className="input input-bordered input-sm w-52"
								disabled={busy || !pin}
							/>
						</label>
						<button
							type="button"
							className="btn btn-sm"
							onClick={addCreator}
							disabled={busy || !pin || !username.trim()}
						>
							Add
						</button>
					</div>
					{creators.rules.length > 0 && (
						<ul className="flex flex-wrap gap-2 pt-1">
							{creators.rules.map((r) => (
								<li key={r.key} className="badge badge-outline gap-2 py-3">
									{names[r.key] ?? `#${r.key}`}
									<button
										type="button"
										className="text-base-content/50 hover:text-error"
										disabled={busy || !pin}
										onClick={() =>
											save({
												creators: {
													...creators,
													rules: creators.rules.filter((x) => x.key !== r.key),
												},
											})
										}
									>
										×
									</button>
								</li>
							))}
						</ul>
					)}
				</div>

				{/* ── Time ── */}
				<div className="space-y-2 border-t border-base-300 pt-4">
					<p className="text-sm font-semibold">Time spent watching, reading and playing</p>
					{/* 📌 Never "screen time" — see the file's own note. */}
					<p className="max-w-prose text-xs text-base-content/50">
						This counts time spent with a work open, which is what Anthers can actually measure.
						Browsing and looking around isn't counted. Leave a box empty for no limit.
					</p>
					<div className="flex flex-wrap gap-3">
						{(
							[
								["daily", "Per day"],
								["weekly", "Per week"],
								["monthly", "Per month"],
							] as const
						).map(([key, label]) => (
							<label key={key} className="form-control">
								<span className="label-text text-xs">{label} (minutes)</span>
								<input
									type="number"
									min={0}
									defaultValue={toMinutes(policy.limits[key])}
									disabled={busy || !pin}
									className="input input-bordered input-sm w-32"
									onBlur={(e) =>
										save({ limits: { ...policy.limits, [key]: toSeconds(e.target.value) } })
									}
								/>
							</label>
						))}
					</div>
				</div>

				{/* ── Language ── */}
				<div className="space-y-1 border-t border-base-300 pt-4">
					<label className="flex items-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-sm mt-0.5"
							checked={policy.languageFilter}
							disabled={busy || !pin}
							onChange={(e) => save({ languageFilter: e.target.checked })}
						/>
						<span className="text-sm">
							<strong>Soften strong language.</strong> Swaps a short list of words for milder ones
							wherever text is shown — "fork", "shirt", and so on.
						</span>
					</label>
					{/* ⚠️ The honest limit, stated where somebody will read it. Strong language never
					    affects a work's rating, so this runs over content nobody classified. */}
					<p className="max-w-prose pl-11 text-xs text-base-content/50">
						It's a courtesy rather than a guarantee: language doesn't affect how work is rated here,
						so this has nothing to consult and will miss things it hasn't been told about.
					</p>
				</div>

				<div className="flex flex-wrap items-center gap-3 border-t border-base-300 pt-4">
					<button
						type="button"
						className="btn btn-ghost btn-sm"
						onClick={turnOff}
						disabled={busy || !pin}
					>
						Turn off and remove the pin
					</button>
					{saved && <span className="text-sm text-success">Saved.</span>}
					{error && <span className="text-sm text-error">{error}</span>}
					{!pin && (
						<span className="text-xs text-base-content/50">Enter the pin to change anything.</span>
					)}
				</div>
			</div>
		</section>
	);
}
