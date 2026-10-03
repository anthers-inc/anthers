// SPDX-License-Identifier: Apache-2.0
/**
 * Disputes — the operator's view of every chargeback Stripe recorded, with the flags
 * that say which ones deserve a person before any human has looked, and the contest
 * action for the exceptional ones.
 *
 * ⭐ **This screen still decides nothing on its own.** Anthers never contests by default;
 * a person can evaluate and perhaps contest an *exceptional* dispute (Parker,
 * 2026-09-15) — particularly egregious, suspicious or large — and everything here exists
 * to give that person what the decision needs and, once decided, to carry it out. The
 * flags and the list are the deciding half; the contest form below is the acting half,
 * and it exists only behind a click because nothing automatic ever contests.
 *
 * The flags are computed at read time by the API (the service's docblock says why):
 * **repeat** (two or more purchase disputes on one creator's sales in the trailing
 * window), **large** (an amount worth a person's look on its own) and **self-pay**
 * (the buyer is the creator whose Work it is). A flagged row is emphasized and sorted
 * first; no flag changes any state anywhere, and neither does one pre-select the form.
 *
 * ⚠️ **The repeat and self-pay flags cover purchase disputes only**, and the page says
 * so rather than pretending otherwise: a support charge is one invoice whose lines may
 * span several creators, and a chargeback takes the whole charge, so "whose sale was
 * disputed" is not something the tables can answer for one.
 *
 * ⚠️ **The evidence form holds only what Anthers honestly holds.** The fields are the
 * plain-text ones our own record can fill — what was bought, when it was received, the
 * buyer's address, anything worth saying in the open field — and the Visa Compelling
 * Evidence 3.0 half (purchase IP, prior undisputed transactions) is Stripe's to autofill
 * from the history it holds as processor. Visa allows one submission only, so the form
 * is the one shot and the stakes are named on the button.
 */
import { DISPUTE_LARGE_AMOUNT } from "@anthers/shared/constants";
import { profileUrl } from "@anthers/web-shared/profile";
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";
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
	contestedBy: { id: number; displayName: string } | null;
	contestedAt: string | null;
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

/** Whether the contest form can be opened for this dispute at all. */
function contestable(d: DisputeItem): boolean {
	// Open, in the window, and never contested — the same three guards the service
	// enforces (outcome, contestedAt, evidenceDueBy); the button hides when any fails,
	// and the service is still the thing that refuses, because a page that hides the
	// button is a courtesy and not a gate.
	return d.outcome === null && d.contestedAt === null && d.evidenceDueBy !== null;
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
								<DisputeRow key={d.id} d={d} siteLink={siteLink} onContested={reload} />
							))}
						</tbody>
					</table>
				</div>
			)}

			<p className="mt-3 text-xs text-base-content/50">
				Anthers never contests a dispute by default. Contesting is the deliberate exception for an
				egregious, suspicious or large dispute, chosen by a person each time — never automatic, and
				never for an ordinary chargeback. Visa allows one evidence submission per dispute, and the
				dispute's countered fee is returned only on a win. The repeat and self-pay flags cover
				purchase disputes only — a support charge is one invoice whose lines can span several
				creators, so which sale was disputed cannot be known from the record. Large covers every
				dispute over ${DISPUTE_LARGE_AMOUNT}.
			</p>
		</section>
	);
}

function DisputeRow({
	d,
	siteLink,
	onContested,
}: {
	d: DisputeItem;
	siteLink: (path: string) => string;
	onContested: () => void;
}) {
	const [open, setOpen] = useState(false);
	const showForm = open && contestable(d);

	return (
		<>
			<tr className={d.flags.length > 0 ? "bg-warning/5 font-semibold" : ""}>
				<td className="max-w-md">
					<div className="flex items-center gap-2">
						<span className="badge badge-sm badge-ghost">{KIND_LABELS[d.kind]}</span>
						{d.flags.map((flag) => (
							<span key={flag} className="badge badge-sm badge-warning" title={FLAG_NOTES[flag]}>
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
						{/* The contest record, once a person has made it. Who and when, nothing
						    more — the evidence itself is the API's to answer with, and a row that
						    restated it would be a copy with no way to stay honest. */}
						{d.contestedAt &&
							d.contestedBy &&
							` · contested by ${d.contestedBy.displayName} on ${new Date(d.contestedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}`}
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
					{d.contestedAt && !d.outcome && (
						<span className="badge badge-sm ml-1 badge-info">Contested</span>
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
				<td className="text-xs text-base-content/50">
					{d.stripeDisputeId}
					{/* The one door to the contest. Only an open, in-window, never-contested
					    dispute shows it, and it opens a form rather than acting — the stakes
					    are stated before the submit, not after. */}
					{contestable(d) && (
						<button
							type="button"
							className="btn btn-xs btn-ghost ml-2"
							onClick={() => setOpen(!open)}
						>
							{showForm ? "Close" : "Contest…"}
						</button>
					)}
				</td>
			</tr>
			{showForm && (
				<tr>
					<td colSpan={7} className="bg-base-200/50">
						<ContestForm d={d} onContested={onContested} />
					</td>
				</tr>
			)}
		</>
	);
}

/**
 * The evidence assembly and submission — the acting half of the screen.
 *
 * The description field arrives prefilled from what the record already holds (the Work's
 * title and what was bought), because the honest description is the one a person should
 * not have to retype; every field stays editable, because the person submitting is the
 * one attesting to the bank. The button names the stakes: one submission only, the
 * countered fee returned only on a win.
 */
function ContestForm({ d, onContested }: { d: DisputeItem; onContested: () => void }) {
	const [description, setDescription] = useState(
		d.kind === "purchase" && d.workTitle
			? `A digital purchase on Anthers: "${d.workTitle}" (a ${"$"}${d.amount} charge), which gave the buyer a permanent copy of the Work.`
			: "",
	);
	const [serviceDate, setServiceDate] = useState(new Date(d.createdAt).toLocaleDateString("en-US"));
	const [email, setEmail] = useState("");
	const [extra, setExtra] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		setBusy(true);
		setError(null);
		const result = await adminPost<{ dispute: DisputeItem }>(
			`/api/admin/disputes/${d.id}/contest`,
			{
				product_description: description.trim(),
				service_date: serviceDate.trim() || undefined,
				customer_email_address: email.trim() || undefined,
				uncategorized_text: extra.trim() || undefined,
			},
		);
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onContested();
	}

	return (
		<div className="my-2">
			{error && <ErrorAlert>{error}</ErrorAlert>}
			<p className="mb-2 text-xs text-base-content/70">
				Contesting submits evidence to the buyer's bank through Stripe. Visa allows one submission
				per dispute, so check the evidence before sending it. The dispute's counter fee is returned
				only if the dispute is won.
			</p>
			<div className="grid gap-2 md:grid-cols-2">
				<label className="form-control">
					<div className="label py-1">
						<span className="label-text text-sm">What was sold</span>
					</div>
					<textarea
						className="textarea textarea-bordered w-full"
						rows={3}
						maxLength={20_000}
						placeholder="The product or service the buyer paid for, in plain words"
						value={description}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</label>
				<div className="grid gap-2">
					<label className="form-control">
						<div className="label py-1">
							<span className="label-text text-sm">Buyer's email address</span>
						</div>
						<input
							type="email"
							className="input input-bordered w-full"
							placeholder="the address Anthers holds, if any"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
						/>
					</label>
					<label className="form-control">
						<div className="label py-1">
							<span className="label-text text-sm">Date the buyer received it</span>
						</div>
						<input
							type="text"
							className="input input-bordered w-full"
							value={serviceDate}
							onChange={(e) => setServiceDate(e.target.value)}
						/>
					</label>
				</div>
			</div>
			<label className="form-control mt-2">
				<div className="label py-1">
					<span className="label-text text-sm">Anything else worth saying (optional)</span>
				</div>
				<textarea
					className="textarea textarea-bordered w-full"
					rows={2}
					maxLength={20_000}
					placeholder="The open field — anything the record holds that the bank should see"
					value={extra}
					onChange={(e) => setExtra(e.target.value)}
				/>
			</label>
			<div className="mt-2 flex items-center gap-2">
				<button
					type="button"
					className="btn btn-sm btn-error"
					disabled={busy || description.trim().length === 0}
					onClick={submit}
				>
					{busy ? "Submitting…" : "Submit Evidence to Contest"}
				</button>
				<span className="text-xs text-base-content/60">
					One submission only — the deliberate exception, not the default.
				</span>
			</div>
		</div>
	);
}
