// SPDX-License-Identifier: Apache-2.0
/**
 * The users directory: every Anthers account in one searchable table.
 *
 * This answers "who is this person?" — a support email, a name somebody mentioned, an
 * account number in a report. It is deliberately **not** the Moderation section's People
 * screen: that list shows the accounts a queue is waiting on and its docblock explains why
 * a directory under a moderation header invites acting on somebody nobody complained
 * about. Here the list is the whole account base, and it is read-only — a row's Details
 * link opens the person's moderation record, where any action states its policy first.
 *
 * The search and the page live in the URL so a lookup can be linked, reloaded or stepped
 * back through. The API does the matching and the paging, and the server owns the page
 * size, so the table never loads the whole account base to filter it in the browser.
 */
import { profileUrl } from "@anthers/web-shared/profile";
import type { FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ErrorAlert, Loading, PageHeader } from "../components/ui";
import { useAdminData } from "../lib/load";
import { useSession } from "../lib/session";

interface DirectoryUser {
	id: number;
	handle: string;
	displayName: string;
	email: string;
	emailVerified: boolean;
	creatorMode: boolean;
	isCreator: boolean;
	suspendedAt: string | null;
	suspendedUntil: string | null;
	deletionRequestedAt: string | null;
	createdAt: string;
}

interface UsersResponse {
	users: DirectoryUser[];
	page: number;
	pageSize: number;
	total: number;
	hasMore: boolean;
}

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** The account's state as a badge. States are read, never changed, on this screen. */
function StateBadges({ user }: { user: DirectoryUser }) {
	const suspended = user.suspendedAt != null;
	const deletionPending = user.deletionRequestedAt != null;
	if (!suspended && !deletionPending) {
		return <span className="badge badge-sm badge-ghost">active</span>;
	}
	const expired = user.suspendedUntil != null && new Date(user.suspendedUntil) <= new Date();
	return (
		<>
			{suspended && (
				<span className={`badge badge-sm ${expired ? "badge-warning" : "badge-error"}`}>
					{expired ? "suspension expired" : "suspended"}
				</span>
			)}
			{deletionPending && <span className="badge badge-sm badge-warning">deletion pending</span>}
		</>
	);
}

export default function Users() {
	const [params, setParams] = useSearchParams();
	const { siteLink } = useSession();
	const query = params.get("q") ?? "";
	const page = Math.max(0, Number(params.get("page") ?? 0) || 0);

	const request = new URLSearchParams();
	if (query) request.set("q", query);
	if (page > 0) request.set("page", String(page));
	const queryString = request.toString();
	const { data, loading, error, reload } = useAdminData<UsersResponse>(
		`/api/admin/users${queryString ? `?${queryString}` : ""}`,
	);

	function search(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const value = String(new FormData(event.currentTarget).get("q") ?? "").trim();
		// A new search is a new result set, so it starts at the first page.
		setParams(value ? { q: value } : {});
	}

	function goTo(nextPage: number) {
		const next = new URLSearchParams(params);
		if (nextPage <= 0) next.delete("page");
		else next.set("page", String(nextPage));
		setParams(next);
	}

	const total = data?.total ?? 0;
	const pageSize = data?.pageSize ?? 50;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const firstShown = data && data.users.length > 0 ? data.page * pageSize + 1 : 0;
	const lastShown = data ? data.page * pageSize + data.users.length : 0;

	return (
		<div>
			<PageHeader
				title="Users"
				description="Every Anthers account, searchable by name, handle, email address, or account number."
				onRefresh={reload}
				loading={loading}
			/>

			<form onSubmit={search} className="mb-4 flex gap-2">
				<input
					key={query}
					type="search"
					name="q"
					defaultValue={query}
					className="input input-bordered input-sm w-80"
					placeholder="Name, handle, email address, or account number"
					aria-label="Search users"
				/>
				<button type="submit" className="btn btn-sm btn-ghost">
					Search
				</button>
			</form>

			{error && <ErrorAlert>{error}</ErrorAlert>}
			{loading && !data ? (
				<Loading />
			) : (
				data && (
					<>
						{data.users.length > 0 && (
							<p className="mb-3 text-sm text-base-content/60">
								{query
									? `${total.toLocaleString()} matching account${total === 1 ? "" : "s"}`
									: `${total.toLocaleString()} account${total === 1 ? "" : "s"}`}
								{total > data.users.length &&
									` · showing ${firstShown.toLocaleString()}–${lastShown.toLocaleString()}`}
							</p>
						)}

						{data.users.length === 0 ? (
							data.total > 0 ? (
								// A page past the end — a stale link, or rows removed since the page
								// was bookmarked. Saying "no match" here would be a lie about the
								// search, so the way back is offered instead.
								<p className="text-sm text-base-content/60">
									Nothing is on this page.{" "}
									<button type="button" className="link" onClick={() => goTo(0)}>
										Go to the first page
									</button>
									.
								</p>
							) : (
								<p className="text-sm text-base-content/60">
									{query ? "No account matches that search." : "There are no accounts yet."}
								</p>
							)
						) : (
							<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
								<table className="table table-sm">
									<thead>
										<tr>
											<th>Account</th>
											<th>Email</th>
											<th>Creator</th>
											<th>Joined</th>
											<th>State</th>
											<th />
										</tr>
									</thead>
									<tbody>
										{data.users.map((user) => (
											<tr key={user.id}>
												<td>
													<div className="font-medium">{user.displayName || `@${user.handle}`}</div>
													<div className="text-xs text-base-content/60">
														{user.displayName ? `@${user.handle} · #${user.id}` : `#${user.id}`}
													</div>
												</td>
												<td className="text-sm">
													{user.email}
													{!user.emailVerified && (
														<div className="text-xs text-base-content/50">address unverified</div>
													)}
												</td>
												<td>
													{user.isCreator ? (
														<span className="badge badge-sm badge-ghost">creator</span>
													) : user.creatorMode ? (
														<span
															className="badge badge-sm badge-outline"
															title="Turned creator mode on and has not finished setup"
														>
															creator mode
														</span>
													) : (
														<span className="text-base-content/40">—</span>
													)}
												</td>
												<td className="whitespace-nowrap text-xs">{shortDate(user.createdAt)}</td>
												<td className="whitespace-nowrap">
													<StateBadges user={user} />
												</td>
												<td className="whitespace-nowrap text-right">
													<Link
														to={`/moderation/people/${user.id}`}
														className="btn btn-xs btn-ghost"
														title="Open this account's moderation record"
													>
														Details
													</Link>
													{user.handle && (
														<a
															href={siteLink(profileUrl(user.handle))}
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
						)}

						{totalPages > 1 && (
							<div className="mt-4 flex items-center justify-between">
								<button
									type="button"
									className="btn btn-sm btn-outline"
									disabled={page <= 0 || loading}
									onClick={() => goTo(page - 1)}
								>
									Previous
								</button>
								<span className="text-sm text-base-content/70">
									Page {(data.page + 1).toLocaleString()} of {totalPages.toLocaleString()}
								</span>
								<button
									type="button"
									className="btn btn-sm btn-outline"
									disabled={!data.hasMore || loading}
									onClick={() => goTo(page + 1)}
								>
									Next
								</button>
							</div>
						)}
					</>
				)
			)}
		</div>
	);
}
