// SPDX-License-Identifier: Apache-2.0
/**
 * Admin accounts: who can sign in to this app, inviting somebody new, and the recent changes.
 *
 * Super-admin only. The route hides this screen from other accounts, and the API refuses them
 * whatever this screen does, so the check here is courtesy rather than the gate.
 *
 * 🚨 **The mailbox is the credential.** An admin account signs in with a code sent to its address,
 * so changing the address moves the credential and ends every session the account holds, and
 * deactivating ends them too. Both ask for confirmation and say so, and both say so louder when the
 * account is the one signed in, because the next request then lands on the sign-in screen.
 *
 * The API refuses to remove the last active super-admin. The screen shows that refusal in the API's
 * own words rather than predicting it, so the rule lives in one place.
 */
import { type FormEvent, useState } from "react";
import { ErrorAlert, Loading, PageHeader, SectionHeading } from "../components/ui";
import { adminPost, useAdminData } from "../lib/load";
import { useSession } from "../lib/session";

interface Account {
	id: number;
	email: string;
	displayName: string;
	isSuperAdmin: boolean;
	deactivatedAt: string | null;
	createdAt: string;
}

interface AccountEvent {
	id: number;
	kind: string;
	detail: Record<string, unknown> | null;
	createdAt: string;
	account: string;
	actor: string | null;
}

interface AccountsResponse {
	accounts: Account[];
	events: AccountEvent[];
}

type Pending =
	| { accountId: number; action: "deactivate" }
	| { accountId: number; action: "email"; email: string }
	| { accountId: number; action: "revoke" };

function shortDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
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

function describeEvent(event: AccountEvent): string {
	const detail = event.detail ?? {};
	switch (event.kind) {
		case "created":
			return detail.isSuperAdmin === true ? "Account created as a super-admin" : "Account created";
		case "deactivated":
			return "Account deactivated";
		case "reactivated":
			return "Account reactivated";
		case "email_changed":
			return `Address changed from ${String(detail.from ?? "?")} to ${String(detail.to ?? "?")}`;
		case "super_admin_granted":
			return "Made a super-admin";
		case "super_admin_revoked":
			return "Super-admin removed";
		default:
			return event.kind;
	}
}

function InviteForm({ onInvited }: { onInvited: (message: string) => void }) {
	const [email, setEmail] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [isSuperAdmin, setIsSuperAdmin] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function invite(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const result = await adminPost<{ account: Account }>("/api/admin/accounts", {
			email: email.trim(),
			displayName: displayName.trim(),
			isSuperAdmin,
		});
		setBusy(false);
		if (!result.ok) {
			setError(result.error);
			return;
		}
		onInvited(
			`${result.data.account.displayName} can now sign in with ${result.data.account.email}.`,
		);
		setEmail("");
		setDisplayName("");
		setIsSuperAdmin(false);
	}

	return (
		<form onSubmit={invite} className="rounded-box border border-base-300 bg-base-100 p-4">
			<p className="mb-4 text-sm text-base-content/70">
				Inviting creates the account at once and emails the address a link to this app. There is
				nothing to accept: the invitee signs in with a code sent to that address.
			</p>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="block">
					<span className="mb-1 block text-sm font-medium">Email Address</span>
					<input
						type="email"
						maxLength={254}
						className="input input-bordered input-sm w-full"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
				</label>
				<label className="block">
					<span className="mb-1 block text-sm font-medium">Display Name</span>
					<input
						type="text"
						maxLength={120}
						className="input input-bordered input-sm w-full"
						value={displayName}
						onChange={(e) => setDisplayName(e.target.value)}
						required
					/>
				</label>
			</div>
			<label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
				<input
					type="checkbox"
					className="checkbox checkbox-sm"
					checked={isSuperAdmin}
					onChange={(e) => setIsSuperAdmin(e.target.checked)}
				/>
				Make this account a super-admin, which lets it manage admin accounts
			</label>
			{error && <p className="mt-3 text-sm text-error">{error}</p>}
			<div className="mt-3">
				<button
					type="submit"
					className="btn btn-sm btn-primary"
					disabled={busy || !email.trim() || !displayName.trim()}
				>
					{busy ? "Inviting…" : "Invite"}
				</button>
			</div>
		</form>
	);
}

export default function Accounts() {
	const { account: me, refresh } = useSession();
	const { data, loading, error, reload } = useAdminData<AccountsResponse>("/api/admin/accounts");
	const [pending, setPending] = useState<Pending | null>(null);
	const [editingEmail, setEditingEmail] = useState<{ accountId: number; email: string } | null>(
		null,
	);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	async function change(accountId: number, path: string, body?: unknown, affectsMe = false) {
		setBusy(true);
		setActionError(null);
		setMessage(null);
		const result = await adminPost<{ account: Account }>(
			`/api/admin/accounts/${accountId}/${path}`,
			body,
		);
		setBusy(false);
		if (!result.ok) {
			setActionError(result.error);
			return;
		}
		setPending(null);
		setEditingEmail(null);
		// A change to the signed-in account can end its session or its super-admin, so the session is
		// re-read first; the app then shows the sign-in screen or leaves this section on its own.
		if (affectsMe) {
			await refresh();
			return;
		}
		await reload();
	}

	function cancel() {
		setPending(null);
		setEditingEmail(null);
		setActionError(null);
	}

	return (
		<div>
			<PageHeader
				title="Admin Accounts"
				description="Who can sign in to this app. Admin accounts are separate from Anthers accounts."
				onRefresh={reload}
				loading={loading}
			/>
			{error && <ErrorAlert>{error}</ErrorAlert>}
			{actionError && <ErrorAlert>{actionError}</ErrorAlert>}
			{message && (
				<div role="status" className="alert alert-success mb-4">
					<span>{message}</span>
				</div>
			)}

			<section className="mb-10">
				<SectionHeading>Invite an Admin</SectionHeading>
				<InviteForm
					onInvited={(text) => {
						setMessage(text);
						void reload();
					}}
				/>
			</section>

			<section className="mb-10">
				<SectionHeading>Accounts</SectionHeading>
				{loading && !data ? (
					<Loading />
				) : (
					data && (
						<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
							<table className="table table-sm">
								<thead>
									<tr>
										<th>Name</th>
										<th>Address</th>
										<th>Role</th>
										<th>State</th>
										<th>Created</th>
										<th />
									</tr>
								</thead>
								<tbody>
									{data.accounts.map((a) => {
										const isMe = a.id === me?.id;
										const active = a.deactivatedAt == null;
										const confirming = pending?.accountId === a.id ? pending : null;
										const editing = editingEmail?.accountId === a.id ? editingEmail : null;
										return (
											<tr key={a.id} className={active ? "align-top" : "align-top opacity-60"}>
												<td className="font-medium">
													{a.displayName}
													{isMe && <span className="badge badge-sm badge-ghost ml-2">You</span>}
												</td>
												<td className="text-sm">{a.email}</td>
												<td>
													<span
														className={`badge badge-sm ${a.isSuperAdmin ? "badge-primary" : "badge-ghost"}`}
													>
														{a.isSuperAdmin ? "Super-Admin" : "Admin"}
													</span>
												</td>
												<td>
													{active ? (
														<span className="badge badge-sm badge-success badge-outline">
															Active
														</span>
													) : (
														<>
															<span className="badge badge-sm badge-ghost">Deactivated</span>
															<div className="text-xs text-base-content/60">
																{shortDate(a.deactivatedAt as string)}
															</div>
														</>
													)}
												</td>
												<td className="whitespace-nowrap text-xs">{shortDate(a.createdAt)}</td>
												<td className="min-w-72 text-right">
													{confirming ? (
														<div className="text-left">
															<p className="text-sm">
																{confirming.action === "deactivate" &&
																	`Deactivating ${a.displayName} ends every session the account holds and stops it signing in until it is reactivated.`}
																{confirming.action === "email" &&
																	`The mailbox is this account's credential, so changing the address to ${confirming.email} ends every session the account holds, and its next sign-in needs a code sent to the new address.`}
																{confirming.action === "revoke" &&
																	`Removing super-admin from ${a.displayName} takes away the ability to manage admin accounts.`}
															</p>
															{isMe && (
																<p className="mt-1 text-sm text-warning">
																	{confirming.action === "revoke"
																		? "This is your own account, so you will leave this section."
																		: "This is your own account, so you will be signed out."}
																</p>
															)}
															<div className="mt-2 flex gap-2">
																<button
																	type="button"
																	className="btn btn-xs btn-error"
																	disabled={busy}
																	onClick={() => {
																		if (confirming.action === "deactivate") {
																			void change(a.id, "deactivate", undefined, isMe);
																		} else if (confirming.action === "email") {
																			void change(a.id, "email", { email: confirming.email }, isMe);
																		} else {
																			void change(
																				a.id,
																				"super-admin",
																				{ isSuperAdmin: false },
																				isMe,
																			);
																		}
																	}}
																>
																	{confirming.action === "deactivate"
																		? "Confirm Deactivation"
																		: confirming.action === "email"
																			? "Confirm Address Change"
																			: "Confirm Removal"}
																</button>
																<button
																	type="button"
																	className="btn btn-xs btn-ghost"
																	onClick={cancel}
																	disabled={busy}
																>
																	Cancel
																</button>
															</div>
														</div>
													) : editing ? (
														<form
															className="flex flex-wrap items-center justify-end gap-2"
															onSubmit={(e) => {
																e.preventDefault();
																if (editing.email.trim()) {
																	setPending({
																		accountId: a.id,
																		action: "email",
																		email: editing.email.trim(),
																	});
																}
															}}
														>
															<input
																type="email"
																maxLength={254}
																className="input input-bordered input-xs w-56"
																value={editing.email}
																onChange={(e) =>
																	setEditingEmail({ accountId: a.id, email: e.target.value })
																}
																aria-label="New email address"
																required
															/>
															<button type="submit" className="btn btn-xs btn-primary">
																Continue
															</button>
															<button
																type="button"
																className="btn btn-xs btn-ghost"
																onClick={cancel}
															>
																Cancel
															</button>
														</form>
													) : (
														<div className="flex flex-wrap justify-end gap-1">
															<button
																type="button"
																className="btn btn-xs btn-ghost"
																disabled={busy}
																onClick={() => {
																	cancel();
																	setEditingEmail({ accountId: a.id, email: a.email });
																}}
															>
																Change Address
															</button>
															{a.isSuperAdmin ? (
																<button
																	type="button"
																	className="btn btn-xs btn-ghost"
																	disabled={busy}
																	onClick={() => {
																		cancel();
																		setPending({ accountId: a.id, action: "revoke" });
																	}}
																>
																	Remove Super-Admin
																</button>
															) : (
																<button
																	type="button"
																	className="btn btn-xs btn-ghost"
																	disabled={busy}
																	onClick={() =>
																		void change(a.id, "super-admin", { isSuperAdmin: true })
																	}
																>
																	Make Super-Admin
																</button>
															)}
															{active ? (
																<button
																	type="button"
																	className="btn btn-xs btn-error btn-outline"
																	disabled={busy}
																	onClick={() => {
																		cancel();
																		setPending({ accountId: a.id, action: "deactivate" });
																	}}
																>
																	Deactivate
																</button>
															) : (
																<button
																	type="button"
																	className="btn btn-xs btn-outline"
																	disabled={busy}
																	onClick={() => void change(a.id, "reactivate")}
																>
																	Reactivate
																</button>
															)}
														</div>
													)}
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						</div>
					)
				)}
			</section>

			<section>
				<SectionHeading>Recent Changes</SectionHeading>
				{data && data.events.length === 0 ? (
					<p className="text-sm text-base-content/60">
						No change to an admin account has been recorded.
					</p>
				) : (
					data && (
						<div className="overflow-x-auto rounded-box border border-base-300 bg-base-100">
							<table className="table table-sm">
								<thead>
									<tr>
										<th>When</th>
										<th>Account</th>
										<th>Change</th>
										<th>Made by</th>
									</tr>
								</thead>
								<tbody>
									{data.events.map((event) => (
										<tr key={event.id}>
											<td className="whitespace-nowrap text-xs">{dateTime(event.createdAt)}</td>
											<td className="text-sm">{event.account}</td>
											<td className="text-sm">{describeEvent(event)}</td>
											<td className="text-sm">
												{event.actor ?? (
													<span className="text-base-content/60">The recovery script</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)
				)}
			</section>
		</div>
	);
}
