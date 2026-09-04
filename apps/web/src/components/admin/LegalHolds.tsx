// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Legal holds — the operator surface over a mechanism that shipped without one.
 *
 * 🚨 **`legal_holds` has been honored by five sweeps since PR #72 and placed by exactly
 * one caller**, `services/quarantine.ts`, automatically. Everything else — a subpoena, a
 * preservation letter, a suit — went in by hand with `psql`, and **a hold you can only
 * place with `psql` is one that will not get placed at 2am**, which is when a preservation
 * letter arrives. § 6.4 of the Legal Request and Preservation Policy names placing a hold
 * as a step in the procedure rather than a thing somebody remembers to do.
 *
 * ⚠️ **Lifted and expired holds stay in this table, and filtering them out would defeat
 * it.** A lifted hold is the record that something was preserved, for how long, and on
 * whose say-so; the question *"why did this survive the sweep?"* is asked years after the
 * hold stops applying. `liftHold` stamps rather than deletes for that reason, and hiding
 * the stamped rows here would undo it at the one place anybody looks.
 *
 * ⭐ **The subject label is the safety property, not decoration.** A hold on an id that
 * names nothing preserves nothing and looks exactly like one that works, so the id is
 * resolved to a name before the write and echoed back afterwards — which is what lets
 * somebody notice they have just preserved the wrong account.
 */

import { displayHandle } from "@anthers/web-shared/profile";
import { apiFetch } from "@anthers/web-shared/rpc";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

type SubjectType = "user" | "work" | "report" | "abuse_report";

interface Hold {
	id: number;
	subjectType: SubjectType;
	subjectId: number;
	subjectLabel: string | null;
	reason: string;
	note: string;
	placedBy: string | null;
	placedAt: string;
	expiresAt: string | null;
	liftedAt: string | null;
	state: "active" | "lifted" | "expired";
}

const SUBJECT_LABELS: Record<SubjectType, string> = {
	user: "Account",
	work: "Work",
	report: "Moderation report",
	abuse_report: "Abuse report",
};

/**
 * The three durations, named by what they are rather than by a number of days.
 *
 * A one-year preservation is 18 U.S.C. § 2258A(h) and the server computes it, so nobody
 * counts on a calendar. *Indefinite* is what a live suit gets, and it is lifted by hand.
 * A chosen date covers a § 2703(f) request, which runs ninety days and may be renewed once.
 */
const DURATIONS = [
	{ value: "preservation", label: "One year — § 2258A(h) preservation" },
	{ value: "indefinite", label: "Indefinite — a live suit, lifted by hand" },
	{ value: "date", label: "Until a date I choose" },
] as const;

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

export default function LegalHolds() {
	const [holds, setHolds] = useState<Hold[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [placed, setPlaced] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirming, setConfirming] = useState<number | null>(null);

	const [subjectType, setSubjectType] = useState<SubjectType>("user");
	const [subjectId, setSubjectId] = useState("");
	const [reason, setReason] = useState("");
	const [note, setNote] = useState("");
	const [duration, setDuration] = useState<string>("preservation");
	const [untilDate, setUntilDate] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch("/api/admin/legal-holds");
			if (!res.ok) {
				setError("Couldn't load the holds.");
				return;
			}
			const body = (await res.json()) as { holds: Hold[] };
			setHolds(body.holds ?? []);
		} catch {
			setError("Couldn't load the holds.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const place = async () => {
		setBusy(true);
		setError(null);
		setPlaced(null);
		try {
			const res = await apiFetch("/api/admin/legal-holds", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					subjectType,
					subjectId: Number(subjectId),
					reason: reason.trim(),
					note: note.trim() || undefined,
					duration:
						duration === "date" ? new Date(`${untilDate}T00:00:00Z`).toISOString() : duration,
				}),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				// The server's own words when it has them: "No user with id 9412" is the
				// message that actually stops somebody preserving nothing.
				setError(body?.error ?? "That hold didn't go through.");
				return;
			}
			const body = (await res.json()) as { subjectLabel: string };
			setPlaced(`Held ${body.subjectLabel}.`);
			setSubjectId("");
			setReason("");
			setNote("");
			await load();
		} catch {
			setError("That hold didn't go through.");
		} finally {
			setBusy(false);
		}
	};

	const lift = async (hold: Hold) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/admin/legal-holds/${hold.id}/lift`, { method: "POST" });
			if (!res.ok) {
				setError("That lift didn't go through.");
				return;
			}
			setConfirming(null);
			await load();
		} catch {
			setError("That lift didn't go through.");
		} finally {
			setBusy(false);
		}
	};

	const canPlace =
		subjectId.trim() !== "" &&
		reason.trim() !== "" &&
		(duration !== "date" || untilDate !== "") &&
		!busy;

	return (
		<section>
			<div className="flex items-center justify-between gap-4 mb-3">
				<div>
					<h2 className="text-lg font-semibold">Legal holds</h2>
					<p className="text-sm text-base-content/60">
						A hold stops every scheduled deletion from touching what it names. It is not a
						suspension — the account is served, signs in and is moderated exactly as before.
					</p>
				</div>
				<button
					type="button"
					className="btn btn-sm btn-ghost gap-2"
					onClick={load}
					disabled={loading}
				>
					<ArrowPathIcon className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
					Refresh
				</button>
			</div>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}
			{placed && (
				<div className="alert alert-success mb-4">
					<span>{placed}</span>
				</div>
			)}

			<div className="card bg-base-200 mb-6">
				<div className="card-body gap-4">
					<h3 className="font-medium">Place a hold</h3>
					<div className="grid gap-3 sm:grid-cols-3">
						<label className="block">
							<span className="block text-sm font-medium mb-1">What kind</span>
							<select
								className="select select-bordered select-sm w-full"
								value={subjectType}
								onChange={(e) => setSubjectType(e.target.value as SubjectType)}
							>
								{Object.entries(SUBJECT_LABELS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</select>
						</label>
						<label className="block">
							<span className="block text-sm font-medium mb-1">Its id</span>
							<input
								type="number"
								min={1}
								className="input input-bordered input-sm w-full"
								value={subjectId}
								onChange={(e) => setSubjectId(e.target.value)}
							/>
						</label>
						<label className="block">
							<span className="block text-sm font-medium mb-1">How long</span>
							<select
								className="select select-bordered select-sm w-full"
								value={duration}
								onChange={(e) => setDuration(e.target.value)}
							>
								{DURATIONS.map((d) => (
									<option key={d.value} value={d.value}>
										{d.label}
									</option>
								))}
							</select>
						</label>
					</div>

					{duration === "date" && (
						<label className="block max-w-xs">
							<span className="block text-sm font-medium mb-1">Held until</span>
							<input
								type="date"
								className="input input-bordered input-sm w-full"
								value={untilDate}
								onChange={(e) => setUntilDate(e.target.value)}
							/>
						</label>
					)}

					<label className="block">
						<span className="block text-sm font-medium mb-1">
							Why — required, and it should name the matter
						</span>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							placeholder="Preservation request, Denver PD, case 26-114873"
							value={reason}
							onChange={(e) => setReason(e.target.value)}
						/>
						<span className="block text-xs mt-1 text-base-content/60">
							A hold nobody can explain is indistinguishable from a bug, and will be lifted by
							whoever finds it.
						</span>
					</label>

					<label className="block">
						<span className="block text-sm font-medium mb-1">Anything else (optional)</span>
						<input
							type="text"
							className="input input-bordered input-sm w-full"
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
					</label>

					<div>
						<button
							type="button"
							className="btn btn-sm btn-primary"
							onClick={place}
							disabled={!canPlace}
						>
							Place hold
						</button>
					</div>
				</div>
			</div>

			{holds === null ? null : holds.length === 0 ? (
				<p className="text-sm text-base-content/60">No hold has ever been placed.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>Subject</th>
								<th>Why</th>
								<th>Placed</th>
								<th>Until</th>
								<th>State</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{holds.map((hold) => (
								<tr key={hold.id} className={hold.state === "active" ? "" : "opacity-60"}>
									<td>
										<div className="font-medium">
											{hold.subjectLabel ?? (
												<span className="text-error">
													{SUBJECT_LABELS[hold.subjectType]} {hold.subjectId} — gone
												</span>
											)}
										</div>
										<div className="text-xs text-base-content/60">
											{SUBJECT_LABELS[hold.subjectType]} #{hold.subjectId}
										</div>
									</td>
									<td className="max-w-md">
										<div>{hold.reason}</div>
										{hold.note && <div className="text-xs text-base-content/60">{hold.note}</div>}
									</td>
									<td className="whitespace-nowrap">
										<div>{shortDate(hold.placedAt)}</div>
										<div className="text-xs text-base-content/60">
											{hold.placedBy ? displayHandle(hold.placedBy) : "by a job"}
										</div>
									</td>
									<td className="whitespace-nowrap">
										{hold.expiresAt ? shortDate(hold.expiresAt) : "Indefinite"}
									</td>
									<td>
										<span
											className={`badge badge-sm ${
												hold.state === "active"
													? "badge-warning"
													: hold.state === "expired"
														? "badge-ghost"
														: "badge-neutral"
											}`}
										>
											{hold.state}
										</span>
										{hold.liftedAt && (
											<div className="text-xs text-base-content/60">{shortDate(hold.liftedAt)}</div>
										)}
									</td>
									<td className="text-right">
										{hold.state === "active" &&
											(confirming === hold.id ? (
												<button
													type="button"
													className="btn btn-xs btn-error"
													onClick={() => lift(hold)}
													disabled={busy}
												>
													Confirm lift
												</button>
											) : (
												<button
													type="button"
													className="btn btn-xs btn-outline"
													onClick={() => setConfirming(hold.id)}
													disabled={busy}
												>
													Lift
												</button>
											))}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}
