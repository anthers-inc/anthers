// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Rating appeals — the operator's half of the content-rating surface.
 *
 * 🚨 **This queue exists because the correction can do harm, and it is not the optional
 * half of the feature.** Anthers' Adult rung is payment-gated, so an
 * over-cautious call does not merely add a warning to a work — it puts it behind a
 * paywall. For a queer coming-of-age story wrongly flagged, that is exactly the harm the
 * category exists to prevent, produced by the mechanism meant to prevent it (wiki 40.09).
 * An operator surface that could correct a rating and offered no way to contest it would
 * be only the half that can do damage.
 *
 * ⚠️ **Two standing principles bound what `mature` may mean, and they are printed on this
 * screen rather than left in a document.** A queer person existing in a story does not make
 * it mature — neither does a trans character, a same-sex relationship, or a discussion of
 * identity. And subject matter is not the same as treatment: work *about* addiction,
 * violence or sexuality is not rated for its subject. Whoever is clearing this queue at
 * three in the morning is the person those rules are addressed to.
 *
 * ⭐ **Upholding an appeal takes a note.** An appeal refused with no answer is the version
 * of this feature that teaches creators not to file one, and a queue of unfiled appeals
 * looks exactly like a queue of correct decisions.
 */

import { maturityLabel, RATING_NOTE_MAX } from "@anthers/shared/content-rating";
import { apiFetch } from "@anthers/web-shared/rpc";
import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";

interface Appeal {
	id: number;
	workId: number;
	requestedMaturity: string;
	correctedMaturity: string;
	statement: string;
	createdAt: string;
	workTitle: string | null;
	workSlug: string;
	workPublicId: number;
}

export default function RatingAppealsQueue() {
	const [appeals, setAppeals] = useState<Appeal[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [notes, setNotes] = useState<Record<number, string>>({});
	const [busy, setBusy] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await apiFetch("/api/admin/rating-appeals");
			if (!res.ok) {
				setError("Couldn't load the appeals.");
				return;
			}
			const body = (await res.json()) as { appeals: Appeal[] };
			setAppeals(body.appeals ?? []);
		} catch {
			setError("Couldn't load the appeals.");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const resolve = async (appeal: Appeal, outcome: "granted" | "upheld") => {
		setBusy(appeal.id);
		setError(null);
		try {
			const res = await apiFetch("/api/admin/rating-appeals/resolve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ appealId: appeal.id, outcome, note: notes[appeal.id] ?? "" }),
			});
			if (!res.ok) {
				setError("That didn't go through.");
				return;
			}
			setAppeals((prev) => (prev ?? []).filter((a) => a.id !== appeal.id));
		} catch {
			setError("That didn't go through.");
		} finally {
			setBusy(null);
		}
	};

	return (
		<section>
			<div className="mb-3 flex items-center justify-between">
				<h2 className="text-xl font-bold">Rating Appeals</h2>
				<button type="button" className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
					<ArrowPathIcon className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
					Refresh
				</button>
			</div>

			<div className="mb-4 rounded-box border border-base-300 bg-base-200 p-4 text-sm">
				<p className="font-semibold">Two things a rating never turns on.</p>
				<p className="mt-1 text-base-content/80">
					A queer person existing in a story does not make it Mature, and neither does a trans
					character, a same-sex relationship, or a discussion of identity. Neither does a subject on
					its own — work <em>about</em> addiction, violence or sexuality is not Mature for its
					subject. What a rating reads is depiction, explicitness and intent.
				</p>
			</div>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}

			{appeals && appeals.length === 0 && (
				<p className="text-sm text-base-content/60">No open appeals.</p>
			)}

			<ul className="flex flex-col gap-3">
				{(appeals ?? []).map((appeal) => (
					<li key={appeal.id} className="rounded-box border border-base-300 p-4">
						<div className="flex flex-wrap items-baseline gap-2">
							<a
								className="link font-semibold"
								href={`/works/${appeal.workSlug}-${appeal.workPublicId}`}
								rel="noreferrer noopener"
								target="_blank"
							>
								{appeal.workTitle || "Untitled"}
							</a>
							<span className="text-sm text-base-content/60">
								{maturityLabel(appeal.correctedMaturity)} →{" "}
								{maturityLabel(appeal.requestedMaturity)}
							</span>
						</div>
						<p className="mt-2 whitespace-pre-wrap text-sm text-base-content/80">
							{appeal.statement}
						</p>
						<textarea
							className="textarea textarea-bordered mt-3 w-full"
							rows={2}
							maxLength={RATING_NOTE_MAX}
							placeholder="Your answer — the creator reads this."
							value={notes[appeal.id] ?? ""}
							onChange={(e) => setNotes((prev) => ({ ...prev, [appeal.id]: e.target.value }))}
						/>
						<div className="mt-2 flex gap-2">
							<button
								type="button"
								className="btn btn-sm btn-primary"
								disabled={busy === appeal.id}
								onClick={() => resolve(appeal, "granted")}
							>
								Grant — rate it {maturityLabel(appeal.requestedMaturity)}
							</button>
							<button
								type="button"
								className="btn btn-sm btn-outline"
								// An upheld appeal with no answer is the failure this queue is trying to
								// avoid, so the button waits for one. Granting needs none: the creator can
								// see the rating changed.
								disabled={busy === appeal.id || !(notes[appeal.id] ?? "").trim()}
								onClick={() => resolve(appeal, "upheld")}
								title={
									(notes[appeal.id] ?? "").trim()
										? undefined
										: "Say why before leaving the rating as it is"
								}
							>
								Leave it as it is
							</button>
						</div>
					</li>
				))}
			</ul>
		</section>
	);
}
