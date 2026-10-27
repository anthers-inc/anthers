// SPDX-License-Identifier: Apache-2.0
/**
 * A person's credits, on their profile — the Work page's liner notes turned around into a
 * body of work, the way a person's credits page reads anywhere else.
 *
 * A visitor sees every accepted credit, grouped by role. The account itself additionally
 * sees the credits that name them and have no answer yet, in one place beside the list they
 * belong to, so reviewing an attribution does not mean hunting through Works.
 *
 * The pending half comes from the server already scoped to the account — see the credits
 * route's docblock — so this component never decides whose list it is.
 */

import { workUrl } from "@anthers/web-shared/postUrl";
import { Link } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import EmptyState from "@anthers/web-shared/ui/EmptyState";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useCallback, useEffect, useState } from "react";
import CreditConfirmationControls from "../work/CreditConfirmationControls";

/** One credit as the person's own list renders it. */
interface CreditAttribution {
	workId: number;
	slug: string;
	publicId: number;
	title: string | null;
	role: string;
	year: number;
}

interface CreditsResponse {
	creator: { handle: string; displayName: string | null };
	accepted: CreditAttribution[];
	pending: CreditAttribution[];
}

/** The creator's credits, in the order the API sends them: grouped by role, newest first. */
export default function CreatorCredits({
	handle,
	creatorName,
	isOwner,
}: {
	handle: string;
	creatorName: string;
	/** The creator's own page — the empty line speaks to them rather than about them. */
	isOwner: boolean;
}) {
	const [data, setData] = useState<CreditsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);

	const load = useCallback(async () => {
		setLoading(true);
		setFailed(false);
		try {
			const res = await client.api.content.credits[":handle"].$get({ param: { handle } });
			if (!res.ok) {
				setFailed(true);
				return;
			}
			setData(await res.json());
		} catch {
			setFailed(true);
		} finally {
			setLoading(false);
		}
	}, [handle]);

	useEffect(() => {
		void load();
	}, [load]);

	if (loading) {
		return (
			<div className="flex justify-center py-12">
				<LoadingSpinner />
			</div>
		);
	}

	if (failed || !data) {
		return <p className="text-sm text-error">Couldn't load these credits just now.</p>;
	}

	const { accepted, pending } = data;
	if (accepted.length === 0 && pending.length === 0) {
		return (
			<EmptyState
				title="No credits yet"
				description={
					isOwner
						? "You aren't credited on any released Work yet."
						: `${creatorName} isn't credited on any released Work yet.`
				}
			/>
		);
	}

	const workCount = new Set(accepted.map((c) => c.workId)).size;
	const roles = new Map<string, CreditAttribution[]>();
	for (const credit of accepted) {
		const group = roles.get(credit.role);
		if (group) group.push(credit);
		else roles.set(credit.role, [credit]);
	}

	return (
		<div className="max-w-3xl space-y-10">
			<section className="space-y-5">
				<h2 className="text-lg font-bold">
					{accepted.length} {accepted.length === 1 ? "credit" : "credits"} on {workCount}{" "}
					{workCount === 1 ? "Work" : "Works"}
				</h2>
				{[...roles].map(([role, credits]) => (
					<div key={role}>
						<h3 className="mb-2 text-sm font-semibold">{role}</h3>
						<ul className="flex flex-col">
							{credits.map((credit, i) => (
								<li
									// biome-ignore lint/suspicious/noArrayIndexKey: a credit row has no id — the same Work can carry two rows with the same role, and the list is pure data in server order.
									key={`${credit.workId}-${credit.role}-${i}`}
									className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-base-content/10 py-2 text-sm last:border-0"
								>
									<Link
										to={workUrl(credit)}
										className="link link-hover underline decoration-base-content/20 underline-offset-2"
									>
										{credit.title?.trim() || "Untitled Work"}
									</Link>
									<span className="text-base-content/50">{credit.year}</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</section>

			{pending.length > 0 && (
				<section className="space-y-3">
					<div>
						<h2 className="text-lg font-bold">Awaiting your confirmation ({pending.length})</h2>
						<p className="text-sm text-base-content/60">
							These Works credit you, but you haven't confirmed them yet. Accepting publishes the
							credit on the Work.
						</p>
					</div>
					<ul className="flex flex-col gap-2">
						{pending.map((credit, i) => (
							<li
								// biome-ignore lint/suspicious/noArrayIndexKey: a credit row has no id — the same Work can carry two rows with the same role, and the list is pure data in server order.
								key={`${credit.workId}-${credit.role}-${i}`}
								className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-base-300 bg-base-200/60 px-3 py-2 text-sm"
							>
								<span>
									<Link
										to={workUrl(credit)}
										className="link link-hover underline decoration-base-content/20 underline-offset-2"
									>
										{credit.title?.trim() || "Untitled Work"}
									</Link>
									<span className="text-base-content/50"> ({credit.year})</span>
									<span className="text-base-content/60"> as {credit.role}</span>
								</span>
								<CreditConfirmationControls
									workId={credit.workId}
									role={credit.role}
									onDecided={() => void load()}
								/>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}
