// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Appealing an operator's correction of a Work's rating.
 *
 * 🚨 **This is part of the rating feature rather than a later refinement.** Because Anthers'
 * adults-only category is payment-gated, an over-cautious call does not merely add a warning
 * to a work — it puts it behind a paywall, and for a queer coming-of-age story wrongly
 * flagged that is exactly the harm the category exists to prevent, produced by the mechanism
 * meant to prevent it (wiki 40.09). A correction surface without a contest would be only the
 * half that can do damage.
 *
 * ⭐ **It shows the answer, not just the outcome.** An appeal refused with no explanation is
 * the version of this that teaches creators not to file one, so the operator's resolution
 * note is rendered beside the verdict — and a granted appeal says what the rating became.
 */

import { maturityLabel, RATING_APPEAL_STATEMENT_MAX } from "@anthers/shared/content-rating";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/rpc";

interface Appeal {
	id: number;
	requestedMaturity: string;
	correctedMaturity: string;
	statement: string;
	status: "open" | "granted" | "upheld";
	resolutionNote: string;
	createdAt: string;
}

interface RatingAppealProps {
	workId: number;
	/** The rating an operator set — what the appeal is against. */
	corrected: string;
}

export default function RatingAppeal({ workId, corrected }: RatingAppealProps) {
	const [appeals, setAppeals] = useState<Appeal[] | null>(null);
	const [statement, setStatement] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		apiFetch(`/api/content/works/${workId}/rating-appeals`)
			.then(async (res) => {
				if (!res.ok || !live) return;
				const body = (await res.json()) as { appeals: Appeal[] };
				setAppeals(body.appeals ?? []);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [workId]);

	// The only thing there is to ask for: the rating is two values, and one of them is the
	// one an operator just set. A picker would be a control with a single option.
	const requested = corrected === "mature" ? "general" : "mature";
	const open = appeals?.find((a) => a.status === "open");
	const settled = (appeals ?? []).filter((a) => a.status !== "open");

	const submit = async () => {
		setSending(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/content/works/${workId}/rating-appeals`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ requestedMaturity: requested, statement: statement.trim() }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error || "That appeal couldn't be sent. Please try again.");
				return;
			}
			const body = (await res.json()) as { appeal: Appeal };
			setAppeals((prev) => [body.appeal, ...(prev ?? [])]);
			setStatement("");
		} catch {
			setError("That appeal couldn't be sent. Please try again.");
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="rounded-box border border-base-300 p-4">
			<h4 className="font-semibold text-sm">Appeal this rating</h4>

			{settled.length > 0 && (
				<ul className="mt-3 flex flex-col gap-2">
					{settled.map((appeal) => (
						<li key={appeal.id} className="text-sm">
							<span
								className={`badge badge-sm ${appeal.status === "granted" ? "badge-success" : "badge-ghost"}`}
							>
								{appeal.status === "granted" ? "Granted" : "Not changed"}
							</span>{" "}
							<span className="text-base-content/70">
								You asked for {maturityLabel(appeal.requestedMaturity)}.
							</span>
							{appeal.resolutionNote && (
								<p className="mt-1 text-xs text-base-content/60">{appeal.resolutionNote}</p>
							)}
						</li>
					))}
				</ul>
			)}

			{open ? (
				<p className="mt-3 text-sm text-base-content/70">
					Your appeal is with an operator. We will answer it here.
				</p>
			) : (
				<>
					<p className="mt-1 text-sm text-base-content/70">
						Tell us why this should be {maturityLabel(requested)} rather than{" "}
						{maturityLabel(corrected)}. A person reads every one of these.
					</p>
					<textarea
						className="textarea textarea-bordered mt-2 w-full"
						rows={3}
						maxLength={RATING_APPEAL_STATEMENT_MAX}
						placeholder="What is in this work, and what an operator may have read it as."
						value={statement}
						onChange={(e) => setStatement(e.target.value)}
					/>
					{error && <p className="mt-1 text-sm text-error">{error}</p>}
					<button
						type="button"
						className="btn btn-sm btn-outline mt-2"
						disabled={sending || statement.trim().length < 10}
						onClick={submit}
					>
						{sending ? "Sending…" : "Send appeal"}
					</button>
				</>
			)}
		</div>
	);
}
