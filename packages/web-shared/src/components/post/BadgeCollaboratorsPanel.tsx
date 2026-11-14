// SPDX-License-Identifier: Apache-2.0
/**
 * Who owns this Badge, and who is waiting to.
 *
 * The panel is the creator-facing half of a Collab Badge. It names the publisher and every
 * accepted owner, shows the invitation that has not been answered, and lets an owner invite
 * another creator, withdraw a pending invitation, leave, or — if they are the publisher —
 * ask another owner to take the publisher role.
 *
 * ⚠️ **The publisher is a record and billing home, not a rank.** Every owner edits and
 * splits evenly; the panel says so where the role is introduced, because a chip that only
 * says "Publisher" invites the reader to infer that the publisher owns more of the Badge.
 */
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useAuth } from "../../lib/auth";
import { profileUrl } from "../../lib/profile";
import { Link } from "../../lib/router";
import { apiBaseUrl } from "../../lib/rpc";

interface CollaboratorRow {
	id: number;
	creatorId: number;
	status: "pending" | "accepted" | "declined";
	createdAt: string;
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

interface PublisherRow {
	id: number;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

interface PendingHandover {
	id: number;
	toCreatorId: number;
	handle: string;
	displayName: string | null;
}

interface CollaboratorsData {
	publisher: PublisherRow | null;
	collaborators: CollaboratorRow[];
	pendingHandover: PendingHandover | null;
}

interface SearchIdentity {
	did: string;
	handle: string;
	displayName: string | null;
	avatar: string | null;
}

function PersonAvatar({
	handle,
	displayName,
	avatar,
	size = 36,
}: {
	handle: string;
	displayName: string | null;
	avatar: string | null;
	size?: number;
}) {
	const name = displayName || handle;
	return avatar ? (
		<img
			src={avatar}
			alt=""
			className="shrink-0 rounded-full object-cover"
			style={{ width: size, height: size }}
		/>
	) : (
		<span
			className="flex shrink-0 items-center justify-center rounded-full bg-base-300 font-bold text-base-content/50"
			style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
		>
			{name.charAt(0).toUpperCase()}
		</span>
	);
}

function PersonLine({
	handle,
	displayName,
	avatar,
	children,
}: {
	handle: string;
	displayName: string | null;
	avatar: string | null;
	children?: ReactNode;
}) {
	const name = displayName || `@${handle}`;
	return (
		<div className="flex items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3">
			<PersonAvatar handle={handle} displayName={displayName} avatar={avatar} />
			<div className="min-w-0 flex-1">
				<Link to={profileUrl(handle)} className="truncate text-sm font-semibold hover:underline">
					{name}
				</Link>
				<p className="truncate text-xs text-base-content/50">@{handle}</p>
			</div>
			{children}
		</div>
	);
}

export default function BadgeCollaboratorsPanel({
	badgeId,
	badgeLabel,
	onChanged,
	onLeft,
}: {
	badgeId: number;
	badgeLabel: string;
	onChanged?: () => void;
	/** The current user left; the Badge Maker should close because the Badge is no longer theirs. */
	onLeft: () => void;
}) {
	const { user } = useAuth();
	const [data, setData] = useState<CollaboratorsData | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const [query, setQuery] = useState("");
	const [searching, setSearching] = useState(false);
	const [results, setResults] = useState<SearchIdentity[]>([]);
	const [searchNote, setSearchNote] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await fetch(`${apiBaseUrl()}/api/subscriptions/badges/${badgeId}/collaborators`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Couldn't read this Badge's collaborators.");
		setData((await res.json()) as CollaboratorsData);
	}, [badgeId]);

	useEffect(() => {
		let live = true;
		void load().catch((err: unknown) => {
			if (live)
				setLoadError(err instanceof Error ? err.message : "Couldn't read the collaborators.");
		});
		return () => {
			live = false;
		};
	}, [load]);

	const refresh = async () => {
		await load();
		onChanged?.();
	};

	const invite = async (did: string) => {
		setBusy(`invite:${did}`);
		setError(null);
		try {
			const res = await fetch(`${apiBaseUrl()}/api/subscriptions/badges/${badgeId}/collaborators`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ did }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't send the invitation.");
			}
			setQuery("");
			setResults([]);
			setSearchNote("Invitation sent.");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't send the invitation.");
		} finally {
			setBusy(null);
		}
	};

	const remove = async (creatorId: number, leaving: boolean) => {
		if (
			leaving &&
			!window.confirm(
				"Leave this Badge? It stays with the other owners, and your share of future support stops. Any of your Works gated on it must be moved first.",
			)
		)
			return;
		setBusy(`remove:${creatorId}`);
		setError(null);
		try {
			const res = await fetch(
				`${apiBaseUrl()}/api/subscriptions/badges/${badgeId}/collaborators/${creatorId}`,
				{ method: "DELETE", credentials: "include" },
			);
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't change the collaborators.");
			}
			if (leaving) {
				onChanged?.();
				onLeft();
				return;
			}
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't change the collaborators.");
		} finally {
			setBusy(null);
		}
	};

	const handOver = async (creatorId: number, handle: string) => {
		if (
			!window.confirm(
				`Make @${handle} the publisher? The Badge's billing and art home moves to them. Ownership, editing and the split do not change.`,
			)
		)
			return;
		setBusy(`publisher:${creatorId}`);
		setError(null);
		try {
			const res = await fetch(`${apiBaseUrl()}/api/subscriptions/badges/${badgeId}/publisher`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ creatorId }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't ask for the publisher change.");
			}
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't ask for the publisher change.");
		} finally {
			setBusy(null);
		}
	};

	const cancelHandover = async () => {
		setBusy("publisher:cancel");
		setError(null);
		try {
			const res = await fetch(`${apiBaseUrl()}/api/subscriptions/badges/${badgeId}/publisher`, {
				method: "DELETE",
				credentials: "include",
			});
			if (!res.ok) throw new Error("Couldn't cancel the publisher change.");
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't cancel the publisher change.");
		} finally {
			setBusy(null);
		}
	};

	const search = async (event: React.FormEvent) => {
		event.preventDefault();
		const q = query.trim();
		if (q.length < 2) {
			setSearchNote("Type at least two characters.");
			return;
		}
		setSearching(true);
		setSearchNote(null);
		setError(null);
		try {
			const res = await fetch(
				`${apiBaseUrl()}/api/accounts/identity-search?q=${encodeURIComponent(q)}`,
				{ credentials: "include" },
			);
			if (!res.ok) throw new Error("Search is unavailable right now.");
			const body = (await res.json()) as { identities: SearchIdentity[] };
			setResults(body.identities);
			if (body.identities.length === 0) setSearchNote("No creator matches that search.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Search is unavailable right now.");
		} finally {
			setSearching(false);
		}
	};

	if (loadError) return <p className="text-sm text-error">{loadError}</p>;
	if (!data) return <p className="text-sm text-base-content/50">Reading the collaborators…</p>;

	const isPublisher = data.publisher?.id === user?.id;
	const accepted = data.collaborators.filter((row) => row.status === "accepted");
	const pending = data.collaborators.filter((row) => row.status === "pending");
	const declined = data.collaborators.filter((row) => row.status === "declined");
	const knownHandles = new Set<string>(
		[data.publisher?.handle, ...data.collaborators.map((row) => row.handle)].filter(
			(handle): handle is string => Boolean(handle),
		),
	);
	const searchable = results.filter(
		(identity) => !knownHandles.has(identity.handle) && identity.handle !== user?.handle,
	);

	return (
		<div className="space-y-6">
			<p className="text-sm text-base-content/60">
				Every creator here owns {badgeLabel}. Each can edit it, each can leave, and the support is
				split evenly. The publisher holds the Badge's billing and art home; it is not a rank.
			</p>

			{error && <p className="text-sm text-error">{error}</p>}

			<section className="space-y-2">
				<h4 className="text-sm font-semibold">Owners</h4>
				{data.publisher && (
					<PersonLine
						handle={data.publisher.handle}
						displayName={data.publisher.displayName}
						avatar={data.publisher.avatar}
					>
						<span className="badge badge-sm badge-outline">Publisher</span>
					</PersonLine>
				)}
				{accepted.map((row) => (
					<PersonLine
						key={row.id}
						handle={row.handle}
						displayName={row.displayName}
						avatar={row.avatar}
					>
						{isPublisher && (
							<button
								type="button"
								className="btn btn-xs btn-outline"
								disabled={busy !== null}
								onClick={() => void handOver(row.creatorId, row.handle)}
							>
								Make publisher
							</button>
						)}
						{row.creatorId === user?.id && (
							<button
								type="button"
								className="btn btn-xs btn-error btn-outline"
								disabled={busy !== null}
								onClick={() => void remove(row.creatorId, true)}
							>
								Leave
							</button>
						)}
					</PersonLine>
				))}
			</section>

			{data.pendingHandover && (
				<div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
					<p>
						Publisher change requested — waiting for{" "}
						<strong>{data.pendingHandover.displayName || `@${data.pendingHandover.handle}`}</strong>
						.
					</p>
					{isPublisher && (
						<button
							type="button"
							className="btn btn-xs btn-ghost mt-2"
							disabled={busy !== null}
							onClick={() => void cancelHandover()}
						>
							Cancel request
						</button>
					)}
				</div>
			)}

			{(pending.length > 0 || declined.length > 0) && (
				<section className="space-y-2">
					<h4 className="text-sm font-semibold">Invitations</h4>
					{pending.map((row) => (
						<PersonLine
							key={row.id}
							handle={row.handle}
							displayName={row.displayName}
							avatar={row.avatar}
						>
							<span className="text-xs text-base-content/50">Invited — waiting</span>
							<button
								type="button"
								className="btn btn-xs btn-ghost"
								disabled={busy !== null}
								onClick={() => void remove(row.creatorId, false)}
							>
								Cancel
							</button>
						</PersonLine>
					))}
					{declined.map((row) => (
						<PersonLine
							key={row.id}
							handle={row.handle}
							displayName={row.displayName}
							avatar={row.avatar}
						>
							<span className="text-xs text-base-content/50">Declined</span>
							<button
								type="button"
								className="btn btn-xs btn-outline"
								disabled={busy !== null}
								onClick={() => void invite(row.did)}
							>
								Invite again
							</button>
						</PersonLine>
					))}
				</section>
			)}

			<section className="space-y-2">
				<h4 className="text-sm font-semibold">Invite a creator</h4>
				<p className="text-xs text-base-content/50">
					They will see the invitation on their own account and can accept or decline. The Badge
					stays yours until they accept.
				</p>
				<form className="flex gap-2" onSubmit={(event) => void search(event)}>
					<input
						type="search"
						className="input input-bordered input-sm min-w-0 flex-1"
						placeholder="Search by name or handle"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<button type="submit" className="btn btn-sm btn-outline" disabled={searching}>
						{searching ? "Searching…" : "Search"}
					</button>
				</form>
				{searchNote && <p className="text-xs text-base-content/50">{searchNote}</p>}
				{searchable.map((identity) => (
					<div
						key={identity.did}
						className="flex items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3"
					>
						<PersonAvatar
							handle={identity.handle}
							displayName={identity.displayName}
							avatar={identity.avatar}
						/>
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-semibold">
								{identity.displayName || `@${identity.handle}`}
							</p>
							<p className="truncate text-xs text-base-content/50">@{identity.handle}</p>
						</div>
						<button
							type="button"
							className="btn btn-xs btn-primary"
							disabled={busy !== null}
							onClick={() => void invite(identity.did)}
						>
							Invite
						</button>
					</div>
				))}
			</section>
		</div>
	);
}
