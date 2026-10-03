// SPDX-License-Identifier: Apache-2.0
/**
 * Disputes — the operator's view of every chargeback Stripe recorded, with the flags
 * that say which ones deserve a person before any human has looked.
 *
 * ⭐ **This screen decides nothing, and that is its job.** Anthers never contests by
 * default; a person can evaluate and perhaps contest an *exceptional* dispute
 * (Parker, 2026-09-15). Everything here exists to give that person what the decision
 * needs — what was bought, from whom, by whom, for how much, and when the evidence
 * window closes — and the contest action itself is another task
 * (*Contest an Exceptional Dispute from the Admin App*), deliberately not built here.
 *
 * The flags are computed at read time by the API (the service's docblock says why):
 * **repeat** (two or more purchase disputes on one creator's sales in the trailing
 * window), **large** (an amount worth a person's look on its own) and **self-pay**
 * (the buyer is the creator whose Work it is). A flagged row is emphasized and sorted
 * first; no flag changes any state anywhere.
 *
 * ⚠️ **The repeat and self-pay flags cover purchase disputes only**, and the page says
 * so rather than pretending otherwise: a support charge is one invoice whose lines may
 * span several creators, and a chargeback takes the whole charge, so "whose sale was
 * disputed" is not something the tables can answer for one.
 */
import { DISPUTE_LARGE_AMOUNT } from "@anthers/shared/constants";
import { profileUrl } from "@anthers/web-shared/profile";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { useAdminData } from "../../lib/load";
import { useSession } from "../../lib/session";

interface Person {
	id: number;
	handle: string;
	displayName: string;
}

interface DisputeItem {
	id: number;
	stripeDisputeId: string;
	kind: "purchase" | "support" | "unlinked";
	amount: string;
	currency: string;
	reason: string;
	status: string;
	outcome: string | null;
	evidenceDueBy: string | null;
	createdAt: string;
	workTitle: string | null;
	workSlug: string | null;
	workPublicId: number | null;
	workExists: boolean;
	creator: Person | null;
	buyer: Person | null;
	flags: ("repeat" | "large" | "self-pay")[];
}

interface Standing {
	count: number;
	ratio: number | null;
	openCount: number;
	state: "quiet" | "approaching" | "early-warning";
}

interface DisputesResponse {
	items: DisputeItem[];
	standing: Standing;
}

const KIND_LABELS: Record<DisputeItem["kind"], string> = {
	purchase: "Purchase",
	support: "Support Charge",
	unlinked: "Unlinked Charge",
};

/** What each flag means, in one line a person reads at speed. */
const FLAG_NOTES: Record<DisputeItem["flags"][number], string> = {
	repeat: "Repeat — this creator has 2 or more purchase disputes in the last 30 days.",
	large: "Large — over the line a single dispute is worth a person's look on its own.",
	"self-pay": "Self-Pay — the buyer is the creator whose Work this is.",
};

function ratioLabel(standing: Standing): string {
	// Null is "nothing to say," never 0%: no successful payments in the window means
	// there is no ratio, and rendering one would read as "healthy" rather than "empty".
	if (standing.ratio === null) return "no charges in the window to measure";
	return `${(standing.ratio * 100).toFixed(2)}% of successful payments`;
}

export default function Disputes() {
	const { siteLink } = useSession();
	const { data, error, loading, reload } = useAdminData<DisputesResponse>("/api/admin/disputes");

	const items = loading && !data ? null : (data?.items ?? []);
	const openCount = data?.standing.openCount ?? null;

	return (
		<section>
			<PageHeader
				title="Disputes"
				description="Every chargeback Stripe recorded, with the ones that deserve a person flagged first. Anthers never contests by default — this is where a person decides."
				onRefresh={reload}
				loading={loading}
			/>

			{error && <ErrorAlert>{error}</ErrorAlert>}

			{data && (
				<div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
					<StatCard title="Open Disputes" value={String(openCount)} />
					<StatCard
						title="In the Last 30 Days"
						value={String(data.standing.count)}
						sub={ratioLabel(data.standing)}
					/>
					<StatCard
						title="Network Standing"
						// Both lines stated on the card, because a small account trips the count
						// first and a large one the ratio — either alone misleads in one direction.
						sub={`early-warning at 0.5% or 5 disputes · approaching at half that · now: ${
							data.standing.state === "early-warning"
								? "early-warning"
								: data.standing.state === "approaching"
									? "approaching"
									: "below the lines"
						}`}
						value={
							data.standing.state === "early-warning"
								? "Early-Warning"
								: data.standing.state === "approaching"
									? "Approaching"
									: "Quiet"
						}
					/>
				</div>
			)}

			<SectionHeading>The List</SectionHeading>
			{!items ? (
				loading ? (
					<Loading />
				) : null
			) : items.length === 0 ? (
				<p className="text-sm text-base-content/60">
					No disputes have been recorded. Nothing has been charged back.
				</p>
			) : (
				<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
					<table className="table table-sm">
						<thead>
							<tr>
								<th>What Was Disputed</th>
								<th>Amount</th>
								<th>Reason</th>
								<th>Status</th>
								<th>Evidence Due</th>
								<th>Created</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{(items ?? []).map((d) => (
								// A flagged row is emphasized and nothing more — no state changed, no
								// row hidden; the flag is an ordering and a color, not a judgment made.
								<tr key={d.id} className={d.flags.length > 0 ? "bg-warning/5 font-semibold" : ""}>
									<td className="max-w-md">
										<div className="flex items-center gap-2">
											<span className="badge badge-sm badge-ghost">{KIND_LABELS[d.kind]}</span>
											{d.flags.map((flag) => (
												<span
													key={flag}
													className="badge badge-sm badge-warning"
													title={FLAG_NOTES[flag]}
												>
													{flag === "self-pay" ? "Self-Pay" : flag}
												</span>
											))}
										</div>
										<div className="mt-1 text-sm break-words">
											{d.kind === "purchase" && d.workSlug && d.workExists && d.workPublicId ? (
												<a
													className="link"
													href={siteLink(`/works/${d.workSlug}-${d.workPublicId}`)}
													rel="noreferrer noopener"
													target="_blank"
												>
													{d.workTitle || "Untitled"}
												</a>
											) : (
												// A deleted Work's title still reads — the snapshot survives the Work
												// by design, which is the whole reason the list can name it.
												d.workTitle || (d.kind === "purchase" ? "Untitled" : "—")
											)}
										</div>
										<div className="mt-0.5 text-xs text-base-content/60">
											{d.creator ? (
												<a
													className="link"
													href={siteLink(profileUrl(d.creator.handle))}
													rel="noreferrer noopener"
													target="_blank"
												>
													@{d.creator.handle}
												</a>
											) : (
												"creator unknown"
											)}
											{" · buyer "}
											{d.buyer ? (
												<a
													className="link"
													href={siteLink(profileUrl(d.buyer.handle))}
													rel="noreferrer noopener"
													target="_blank"
												>
													@{d.buyer.handle}
												</a>
											) : (
												"unknown"
											)}
											{/* An open purchase dispute has taken the buyer's access with it (a
											    dispute flips the purchase off `completed`, the same as a refund), and
											    the row must not read as though the buyer still has the Work. */}
											{d.kind === "purchase" &&
												d.outcome === null &&
												" · the buyer's access is revoked while it is open"}
											{d.outcome === "won" && " · the buyer's access was restored"}
										</div>
									</td>
									<td className="tabular-nums">${d.amount}</td>
									<td>{d.reason || "—"}</td>
									<td>
										{/* Stripe's own word, verbatim — the schema's rule, and the reason there is
										    no label map here. */}
										<span className="badge badge-sm badge-ghost">{d.status}</span>
										{d.outcome && (
											<span
												className={`badge badge-sm ml-1 ${
													d.outcome === "won" ? "badge-success" : "badge-error"
												}`}
											>
												{d.outcome}
											</span>
										)}
									</td>
									<td className="text-xs">
										{d.evidenceDueBy
											? new Date(d.evidenceDueBy).toLocaleDateString("en-US", {
													year: "numeric",
													month: "long",
													day: "numeric",
													timeZone: "UTC",
												})
											: "—"}
									</td>
									<td className="text-xs text-base-content/60">
										{new Date(d.createdAt).toLocaleDateString()}
									</td>
									<td className="text-xs text-base-content/50">{d.stripeDisputeId}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<p className="mt-3 text-xs text-base-content/50">
				The repeat and self-pay flags cover purchase disputes only — a support charge is one invoice
				whose lines can span several creators, so which sale was disputed cannot be known from the
				record. Large covers every dispute over ${DISPUTE_LARGE_AMOUNT}. No contest action exists
				yet; deciding to contest an exceptional one is recorded elsewhere when that mechanism is
				built.
			</p>
		</section>
	);
}
