// SPDX-License-Identifier: Apache-2.0
/**
 * Data-rights requests: the operator's side of the Privacy Policy's promise to answer within
 * thirty days.
 *
 * Open requests come first and nearest the deadline first, with an overdue one marked in a way that
 * cannot be read past, because a deadline nobody can see is not a mechanism. Days left and overdue
 * come from the API rather than being worked out here, so this screen and the Home count agree.
 *
 * Resolving tells the requester, with the note as the message body. While the account that asked
 * still exists that is an in-app notice, which also emails the account's address; once the account is
 * gone it is an email to the address captured with the request, which is why the address was
 * captured. That email is the only copy the requester will ever get, so a send the provider refused
 * is shown and kept on screen until the operator has seen it, rather than vanishing with the reload.
 */
import {
	RIGHTS_DETAILS_MAX,
	RIGHTS_REQUEST_KINDS,
	RIGHTS_RESPONSE_DAYS,
} from "@anthers/shared/rights";
import { useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading, StatCard } from "../../components/ui";
import { adminPost, useAdminData } from "../../lib/load";

interface RightsRequest {
	id: number;
	userId: number | null;
	email: string;
	kind: string;
	details: string;
	status: "open" | "resolved";
	dueAt: string;
	resolvedAt: string | null;
	/** The admin account that answered it. */
	resolvedByName: string | null;
	resolutionNote: string;
	createdAt: string;
	overdue: boolean;
	daysLeft: number;
}

interface RightsResponse {
	requests: RightsRequest[];
	open: number;
	overdue: number;
}

/** Short operator-facing names; the shared list carries the requester's own wording as `label`. */
const KIND_NAMES: Record<string, string> = {
	access: "Access",
	rectification: "Rectification",
	objection: "Objection",
	portability: "Portability",
	other: "Other",
};

function kindName(kind: string): string {
	return KIND_NAMES[kind] ?? kind;
}

function kindWording(kind: string): string | undefined {
	return RIGHTS_REQUEST_KINDS.find((k) => k.value === kind)?.label;
}

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

function DeadlineBadge({ request }: { request: RightsRequest }) {
	if (request.overdue) return <span className="badge badge-error">Overdue</span>;
	const days = Math.max(request.daysLeft, 0);
	return (
		<span className={`badge ${days <= 7 ? "badge-warning" : "badge-ghost"}`}>
			{days} {days === 1 ? "Day" : "Days"} Left
		</span>
	);
}

function OpenRequest({ request, onResolved }: { request: RightsRequest; onResolved: () => void }) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [unsent, setUnsent] = useState(false);

	async function resolve() {
		setBusy(true);
		setError(null);
		const result = await adminPost<{ resolved: boolean; emailed: boolean }>(
			`/api/admin/rights-requests/${request.id}/resolve`,
			{ note: note.trim() || undefined },
		);
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		if (request.userId == null && !result.data.emailed) {
			setUnsent(true);
			return;
		}
		onResolved();
	}

	if (unsent) {
		return (
			<li className="rounded-box border border-error bg-base-100 p-4">
				<p className="text-sm text-error">
					This request is resolved, but the answer could not be emailed to {request.email}. Reply to
					that address directly, since the account that asked no longer exists and nothing else will
					reach them.
				</p>
				<div className="mt-2">
					<button type="button" className="btn btn-sm" onClick={onResolved}>
						Done
					</button>
				</div>
			</li>
		);
	}

	return (
		<li
			className={`rounded-box border bg-base-100 p-4 ${request.overdue ? "border-error" : "border-base-300"}`}
		>
			<div className="flex flex-wrap items-center gap-2">
				<DeadlineBadge request={request} />
				<span className="badge badge-ghost" title={kindWording(request.kind)}>
					{kindName(request.kind)}
				</span>
				<a className="link font-medium" href={`mailto:${request.email}`}>
					{request.email}
				</a>
				<span className="ml-auto text-xs text-base-content/60">
					Received {shortDate(request.createdAt)} · due {shortDate(request.dueAt)}
				</span>
			</div>

			{request.details ? (
				<p className="mt-3 whitespace-pre-wrap text-sm text-base-content/80">{request.details}</p>
			) : (
				<p className="mt-3 text-sm text-base-content/50">The requester added no details.</p>
			)}

			{request.userId == null && (
				<p className="mt-3 text-sm text-warning">
					The account that made this request no longer exists, so resolving it emails the note to{" "}
					{request.email}, and that email is the only answer they will receive.
				</p>
			)}

			{error && <p className="mt-3 text-sm text-error">{error}</p>}

			<textarea
				className="textarea textarea-bordered mt-3 w-full"
				rows={2}
				maxLength={RIGHTS_DETAILS_MAX}
				placeholder="What was done. The requester reads this note as the body of the message."
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>
			<div className="mt-2">
				<button type="button" className="btn btn-sm btn-primary" onClick={resolve} disabled={busy}>
					{busy ? "Resolving…" : "Resolve"}
				</button>
			</div>
		</li>
	);
}

export default function RightsRequests() {
	const { data, loading, error, reload } = useAdminData<RightsResponse>(
		"/api/admin/rights-requests",
	);

	const open = (data?.requests ?? [])
		.filter((r) => r.status === "open")
		.sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
	const resolved = (data?.requests ?? [])
		.filter((r) => r.status === "resolved")
		.sort(
			(a, b) =>
				new Date(b.resolvedAt ?? b.createdAt).getTime() -
				new Date(a.resolvedAt ?? a.createdAt).getTime(),
		);

	return (
		<div>
			<PageHeader
				title="Rights Requests"
				description={`Data-rights requests, which the Privacy Policy promises to answer within ${RIGHTS_RESPONSE_DAYS} days.`}
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data && (
					<div className="space-y-10">
						<div className="grid grid-cols-3 gap-3">
							<StatCard title="Open" value={String(data.open)} />
							<StatCard title="Overdue" value={String(data.overdue)} />
							<StatCard title="Resolved" value={String(resolved.length)} />
						</div>

						<section>
							<SectionHeading>Open Requests</SectionHeading>
							{open.length === 0 ? (
								<p className="text-sm text-success">No request is waiting for an answer.</p>
							) : (
								<ul className="flex flex-col gap-3">
									{open.map((request) => (
										<OpenRequest key={request.id} request={request} onResolved={reload} />
									))}
								</ul>
							)}
						</section>

						<section>
							<SectionHeading>Resolved Requests</SectionHeading>
							{resolved.length === 0 ? (
								<p className="text-sm text-base-content/60">No request has been resolved yet.</p>
							) : (
								<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
									<table className="table table-sm">
										<thead>
											<tr>
												<th>Requester</th>
												<th>Kind</th>
												<th>Received</th>
												<th>Resolved</th>
												<th>Note</th>
											</tr>
										</thead>
										<tbody>
											{resolved.map((r) => {
												const late =
													r.resolvedAt != null &&
													new Date(r.resolvedAt).getTime() > new Date(r.dueAt).getTime();
												return (
													<tr key={r.id}>
														<td className="text-sm">{r.email}</td>
														<td>
															<span
																className="badge badge-sm badge-ghost"
																title={kindWording(r.kind)}
															>
																{kindName(r.kind)}
															</span>
														</td>
														<td className="whitespace-nowrap text-xs">{shortDate(r.createdAt)}</td>
														<td className="whitespace-nowrap text-xs">
															{r.resolvedAt ? shortDate(r.resolvedAt) : "—"}
															{r.resolvedByName && (
																<div className="text-base-content/60">{r.resolvedByName}</div>
															)}
															{late && (
																<span className="badge badge-sm badge-error badge-outline ml-2">
																	Late
																</span>
															)}
														</td>
														<td className="max-w-md text-xs text-base-content/70">
															{r.resolutionNote || "—"}
														</td>
													</tr>
												);
											})}
										</tbody>
									</table>
								</div>
							)}
						</section>
					</div>
				)
			)}
		</div>
	);
}
