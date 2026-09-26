// SPDX-License-Identifier: Apache-2.0
/**
 * People — the console's view of Anthers accounts as moderation subjects.
 *
 * This is where an operator acts on a *person* rather than a thing they made: suspend,
 * lift, and the earnings review a suspension opens. The mechanism lives in
 * `services/moderation.ts` and `services/payouts.ts`; this screen reads and drives it.
 *
 * 🚨 **The list is not a directory.** It shows accounts that are suspended or reported,
 * or one an operator named in a search — never "every account, newest first". Browsing a
 * user list under a moderation header invites acting on somebody nobody complained about,
 * the same line the queue's People filter holds.
 *
 * 🚨 **Every action states the policy at the moment it is taken** rather than silently
 * encoding it (the task's own rule): the suspend form says the held payouts default to
 * payout even on termination and that the review window lapses into an automatic release;
 * the earnings-review form says a clear pays out everything held. The operator who needs
 * an exception should meet the rule, not discover it.
 *
 * Nothing here deletes. Suspension is a state; the lift is a second recorded decision
 * rather than an edit of the first, and the action log below renders the sequence.
 */
import { MODERATION_NOTE_MAX, MODERATION_REASON_GROUPS, moderationReasonLabel, reasonsInGroup } from "@anthers/shared/moderation";
import { profileUrl } from "@anthers/web-shared/profile";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";
import { useSession } from "../../lib/session";

// ── Response shapes (mirror services/moderation.ts and services/payouts.ts) ────
interface PersonRow {
	id: number;
	handle: string;
	displayName: string;
	bio: string | null;
	isCreator: boolean;
	suspendedAt: string | null;
	suspendedUntil: string | null;
	openReports: number;
	totalReports: number;
	reasons: string[];
}

interface RecordedAction {
	id: number;
	action: string;
	reason: string;
	note: string;
	createdAt: string;
	actor: string | null;
}

/** The payout hold on a suspended creator, as `suspensionPayoutReview` reads it. */
interface PayoutReview {
	heldAmount: string;
	resolvedAt: string | null;
	releasesAt: string | null;
}

interface PeopleResponse {
	people: PersonRow[];
}

interface PersonResponse {
	person: PersonRow;
	actions: RecordedAction[];
	payout: PayoutReview | null;
}

function dateTime(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

/** The action names as the log reads. `reclassify` never has a `user` subject; the log is shared. */
const ACTION_WORDS: Record<string, string> = {
	suspend: "Suspended",
	unsuspend: "Suspension lifted",
	payout_review: "Earnings review concluded",
};

function describeAction(row: RecordedAction): string {
	const named = ACTION_WORDS[row.action] ?? row.action;
	if (row.action === "payout_review") return named;
	if (!row.reason) return named;
	return `${named} — ${moderationReasonLabel(row.reason)}`;
}

/** The badge a person's suspension state wears in the list and on the detail. */
function SuspensionBadge({ person }: { person: PersonRow }) {
	if (!person.suspendedAt) {
		return <span className="badge badge-sm badge-ghost">not suspended</span>;
	}
	const indefinite = !person.suspendedUntil;
	const expired = person.suspendedUntil && new Date(person.suspendedUntil) <= new Date();
	return (
		<span className="badge badge-sm badge-error">
			{indefinite ? "suspended — no end" : expired ? "suspension expired" : "suspended"}
		</span>
	);
}

/**
 * The suspend form, policy first.
 *
 * The reason picker is grouped the same way the reporter's is — an operator recording why
 * an account was acted on chooses from the same vocabulary a reporter chose from.
 */
function SuspendForm({
	person,
	onDone,
	onError,
}: {
	person: PersonRow;
	onDone: (message: string) => void;
	onError: (message: string) => void;
}) {
	const [reason, setReason] = useState("");
	const [note, setNote] = useState("");
	const [days, setDays] = useState("");
	const [busy, setBusy] = useState(false);

	async function suspend(event: FormEvent) {
		event.preventDefault();
		if (!reason) return;
		setBusy(true);
		const until = days
			? new Date(Date.now() + Number(days) * 86_400_000).toISOString()
			: undefined;
		const result = await adminPost("/api/admin/moderation/suspend", {
			userId: person.id,
			reason,
			note: note.trim() || undefined,
			...(until ? { until } : {}),
		});
		setBusy(false);
		if (!result.ok) {
			onError(result.error);
			return;
		}
		onDone(
			person.suspendedAt
				? `Re-suspended @${person.handle}.`
				: `Suspended @${person.handle}. Their held payouts are under review, and they were emailed.`,
		);
	}

	return (
		<form onSubmit={suspend} className="rounded-box border border-base-300 bg-base-100 p-4">
			<p className="mb-3 text-sm text-base-content/70">
				Suspending ends every session the account holds and stops it signing in; their presence
				and their Works stop appearing publicly, and existing buyers keep their purchases. The
				payouts they already earned are <strong>held for review, not taken</strong>: the default
				is that everything pays out — on reinstatement and on termination alike — unless a
				review affirmatively finds some of it was earned by the violation itself.
			</p>
			<select
				className="select select-bordered w-full"
				value={reason}
				onChange={(e) => setReason(e.target.value)}
				aria-label="Reason"
			>
				<option value="">Reason…</option>
				{MODERATION_REASON_GROUPS.map((group) => (
					<optgroup key={group.key} label={group.heading.toUpperCase()}>
						{reasonsInGroup(group.key).map((r) => (
							<option key={r.value} value={r.value}>
								{r.label}
							</option>
						))}
					</optgroup>
				))}
			</select>
			<div className="mt-2 grid gap-2 sm:grid-cols-2">
				<label className="block">
					<span className="mb-1 block text-sm text-base-content/70">
						Days until it lifts itself
					</span>
					<input
						type="number"
						min={1}
						className="input input-bordered input-sm w-full"
						value={days}
						onChange={(e) => setDays(e.target.value)}
						placeholder="Leave empty for no end"
					/>
				</label>
			</div>
			<textarea
				className="textarea textarea-bordered mt-2 w-full"
				rows={2}
				maxLength={MODERATION_NOTE_MAX}
				placeholder="Note for the record (optional)"
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>
			<div className="mt-3">
				<button
					type="submit"
					className="btn btn-sm btn-error"
					disabled={busy || !reason}
					title="The account is emailed the reason category and the appeal path the moment this lands."
				>
					{busy ? "Suspending…" : "Suspend"}
				</button>
			</div>
		</form>
	);
}

/** Conclude the earnings review a suspension opened — a finding or a clear. */
function PayoutReviewForm({
	person,
	heldAmount,
	onDone,
	onError,
}: {
	person: PersonRow;
	heldAmount: string;
	onDone: (message: string) => void;
	onError: (message: string) => void;
}) {
	const [tainted, setTainted] = useState("");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);

	async function conclude(finding: boolean) {
		setBusy(true);
		const result = await adminPost(`/api/admin/people/${person.id}/payout-review`, {
			...(finding && tainted ? { taintedAmount: tainted } : {}),
			note: note.trim() || undefined,
		});
		setBusy(false);
		if (!result.ok) {
			onError(result.error);
			return;
		}
		onDone(
			finding && tainted
				? `Review concluded: $${tainted} named as earned by the violation. The rest pays out.`
				: "Review concluded with no finding. The held amount pays out in full.",
		);
	}

	return (
		<form
			className="rounded-box border border-base-300 bg-base-100 p-4"
			onSubmit={(e) => {
				e.preventDefault();
				void conclude(true);
			}}
		>
			<p className="mb-3 text-sm text-base-content/70">
				<strong>${heldAmount} is held</strong> — money this creator earned before the
				suspension. The default disposition is payout of all of it; a finding names only what
				was earned by the violation itself. If the window lapses with no finding recorded,
				the hold releases automatically — an anti-corruption rule you can wait out is not one.
			</p>
			<label className="block">
				<span className="mb-1 block text-sm text-base-content/70">
					Earned by the violation itself, in dollars (a finding)
				</span>
				<input
					type="text"
					inputMode="decimal"
					className="input input-bordered input-sm w-48"
					value={tainted}
					onChange={(e) => setTainted(e.target.value)}
					placeholder="Like 12.50"
					pattern="\d+(\.\d{1,2})?"
				/>
			</label>
			<textarea
				className="textarea textarea-bordered mt-2 w-full"
				rows={2}
				maxLength={MODERATION_NOTE_MAX}
				placeholder="Note for the record (optional)"
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>
			<div className="mt-3 flex flex-wrap gap-2">
				<button
					type="submit"
					className="btn btn-sm btn-primary"
					disabled={busy || !tainted}
					title="The finding is recorded in the moderation log; the rest of the held amount pays out."
				>
					{busy ? "Recording…" : "Record the Finding"}
				</button>
				<button
					type="button"
					className="btn btn-sm btn-outline"
					disabled={busy}
					onClick={() => void conclude(false)}
					title="No tainted earnings found — everything held pays out."
				>
					Conclude with No Finding
				</button>
			</div>
		</form>
	);
}

// ── The list ───────────────────────────────────────────────────────────────────
function PeopleList() {
	const [params, setParams] = useSearchParams();
	const query = params.get("q") ?? "";
	const { data, loading, error, reload } = useAdminData<PeopleResponse>(
		`/api/admin/people${query ? `?q=${encodeURIComponent(query)}` : ""}`,
	);
	const { siteLink } = useSession();

	return (
		<section>
			<PageHeader
				title="People"
				description="Accounts that are suspended or reported, or one you name. This is a moderation view, not a directory of everybody."
				onRefresh={reload}
				loading={loading}
			/>
			<form
				className="mb-4 flex gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					const value = new FormData(e.currentTarget).get("q");
					setParams(value ? { q: String(value) } : {});
				}}
			>
				<input
					type="search"
					name="q"
					defaultValue={query}
					className="input input-bordered input-sm w-72"
					placeholder="Handle, name, or account id"
					aria-label="Search accounts"
				/>
				<button type="submit" className="btn btn-sm btn-ghost">
					Search
				</button>
			</form>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data &&
				(data.people.length === 0 ? (
					<p className="text-sm text-base-content/60">
						{query
							? "No account matches that search."
							: "No account is suspended, and nobody has been reported."}
					</p>
				) : (
					<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
						<table className="table table-sm">
							<thead>
								<tr>
									<th>Account</th>
									<th>State</th>
									<th>Reports</th>
									<th>Reasons</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{data.people.map((p) => (
									<tr key={p.id}>
										<td>
											<div className="font-medium">{p.displayName || `@${p.handle}`}</div>
											<div className="text-xs text-base-content/60">@{p.handle}</div>
											{p.isCreator && (
												<span className="badge badge-sm badge-ghost mt-1">creator</span>
											)}
										</td>
										<td>
											<SuspensionBadge person={p} />
										</td>
										<td className="text-sm tabular-nums">
											{p.openReports > 0 ? (
												<span className="font-semibold text-warning">{p.openReports} open</span>
											) : (
												<span className="text-base-content/50">{p.totalReports} closed</span>
											)}
										</td>
										<td className="text-xs text-base-content/60">
											{p.reasons.map(moderationReasonLabel).join(", ") || "—"}
										</td>
										<td className="text-right">
											<Link
												to={`/moderation/people/${p.id}`}
												className="btn btn-xs btn-ghost"
											>
												Open
											</Link>
											{p.handle && (
												<a
													href={siteLink(profileUrl(p.handle))}
													target="_blank"
													rel="noopener noreferrer"
													className="btn btn-xs btn-ghost ml-1"
												>
													Profile
												</a>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))
			)}
		</section>
	);
}

// ── The detail ────────────────────────────────────────────────────────────────
function PersonDetail() {
	const { id } = useParams();
	const navigate = useNavigate();
	const { siteLink } = useSession();
	const { data, loading, error, reload } = useAdminData<PersonResponse>(
		`/api/admin/people/${id}`,
	);
	const [message, setMessage] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [lifting, setLifting] = useState(false);

	async function lift() {
		if (!data) return;
		const result = await adminPost("/api/admin/moderation/unsuspend", { userId: data.person.id });
		if (!result.ok) {
			setActionError(result.error);
			return;
		}
		setMessage(
			"Lifted. The account can sign in again, their presence and Works return, and paused renewals resume.",
		);
		await reload();
	}

	useEffect(() => {
		// Clear the transient banners whenever the account being viewed changes.
		setMessage(null);
		setActionError(null);
	}, [id]);

	if (loading && !data) return <Loading />;
	if (error) return <ErrorAlert>{error}</ErrorAlert>;
	if (!data) return null;

	const { person, actions, payout } = data;
	const suspended = person.suspendedAt != null;
	const reviewOpen =
		payout != null && payout.releasesAt != null && new Date(payout.releasesAt) > new Date();

	return (
		<div>
			<button
				type="button"
				className="btn btn-ghost btn-xs mb-2"
				onClick={() => void navigate("/moderation/people")}
			>
				← Back to People
			</button>
			<PageHeader
				title={person.displayName || `@${person.handle}`}
				description={`@${person.handle} · account #${person.id}`}
				onRefresh={reload}
				loading={loading}
			/>
			{message && (
				<div role="status" className="alert alert-success mb-4">
					<span>{message}</span>
				</div>
			)}
			{actionError && <ErrorAlert>{actionError}</ErrorAlert>}

			<div className="mb-6 flex flex-wrap items-center gap-3">
				<SuspensionBadge person={person} />
				{person.isCreator && <span className="badge badge-sm badge-ghost">creator</span>}
				{person.openReports > 0 && (
					<span className="badge badge-sm badge-warning">{person.openReports} reports open</span>
				)}
				{person.handle && (
					<a
						href={siteLink(profileUrl(person.handle))}
						target="_blank"
						rel="noopener noreferrer"
						className="link link-hover text-sm"
					>
						open their profile
					</a>
				)}
			</div>

			{person.bio && <p className="mb-6 max-w-prose text-sm text-base-content/70">{person.bio}</p>}

			<section className="mb-8">
				<SectionHeading>{suspended ? "Suspend Again or Lift" : "Suspend"}</SectionHeading>
				{suspended ? (
					<div className="rounded-box border border-base-300 bg-base-100 p-4">
						<p className="text-sm text-base-content/70">
							{person.suspendedUntil
								? `Suspended until ${dateTime(person.suspendedUntil)} (it lifts itself at that moment).`
								: "Suspended with no end — it stands until lifted here."}
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							{lifting ? (
								<>
									<button
										type="button"
										className="btn btn-sm btn-error"
										disabled={loading}
										onClick={() => void lift()}
									>
										Confirm Lift
									</button>
									<button
										type="button"
										className="btn btn-sm btn-ghost"
										onClick={() => setLifting(false)}
										disabled={loading}
									>
										Cancel
									</button>
								</>
							) : (
								<button
									type="button"
									className="btn btn-sm btn-outline"
									disabled={loading}
									onClick={() => setLifting(true)}
								>
									Lift the Suspension
								</button>
							)}
						</div>
						<p className="mt-3 text-xs text-base-content/50">
							The lift is recorded as its own decision; the original suspension stays in the
							log below.
						</p>
					</div>
				) : (
					<SuspendForm
						person={person}
						onDone={async (text) => {
							setMessage(text);
							await reload();
						}}
						onError={setActionError}
					/>
				)}
			</section>

			{payout && (
				<section className="mb-8">
					<SectionHeading>Earnings Review</SectionHeading>
					{reviewOpen ? (
						<PayoutReviewForm
							person={person}
							heldAmount={payout.heldAmount}
							onDone={async (text) => {
								setMessage(text);
								await reload();
							}}
							onError={setActionError}
						/>
					) : (
						<div className="rounded-box border border-base-300 bg-base-100 p-4 text-sm text-base-content/70">
							{payout.resolvedAt
								? `The review concluded on ${dateTime(payout.resolvedAt)}; the held amount was released. See the log below for the finding.`
								: `A hold of $${payout.heldAmount} stands with the review window open until ${dateTime(payout.releasesAt ?? "")}.`}
						</div>
					)}
				</section>
			)}

			<section>
				<SectionHeading>Recorded Actions</SectionHeading>
				{actions.length === 0 ? (
					<p className="text-sm text-base-content/60">
						No moderation decision has been recorded about this account.
					</p>
				) : (
					<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
						<table className="table table-sm">
							<thead>
								<tr>
									<th>When</th>
									<th>Decision</th>
									<th>By</th>
								</tr>
							</thead>
							<tbody>
								{actions.map((a) => (
									<tr key={a.id}>
										<td className="whitespace-nowrap text-xs">{dateTime(a.createdAt)}</td>
										<td className="text-sm">
											{describeAction(a)}
											{a.note && (
												<div className="text-xs italic text-base-content/60">“{a.note}”</div>
											)}
										</td>
										<td className="text-sm">
											{a.actor ?? <span className="text-base-content/50">automated</span>}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}

export default function People() {
	const { id } = useParams();
	return id ? <PersonDetail /> : <PeopleList />;
}