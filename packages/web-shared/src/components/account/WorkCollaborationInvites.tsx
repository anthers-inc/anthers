// SPDX-License-Identifier: Apache-2.0
/**
 * The Work collaboration invitations and publisher requests waiting on this creator.
 *
 * A Work invitation is quiet until it is answered: the Work stays with its current owners,
 * and the invited creator sees it here rather than in their Studio or on their profile.
 * Accepting adds the second view; declining leaves the Work where it was. A publisher
 * request is the same shape, because the role carries the Work's listing home.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "../../lib/router";
import { apiBaseUrl } from "../../lib/rpc";
import { keyToPreview } from "../post/mediaUpload";

interface WorkSummary {
	id: number;
	slug: string;
	publicId: number;
	title: string;
	thumbnail: string | null;
	type: string;
}

interface WorkInvite {
	id: number;
	createdAt: string;
	work: WorkSummary;
	inviter: { handle: string; displayName: string | null };
}

interface WorkHandover {
	id: number;
	createdAt: string;
	work: WorkSummary;
	from: { handle: string; displayName: string | null };
}

interface WorkCollaborationsResponse {
	invites: WorkInvite[];
	handovers: WorkHandover[];
}

function workHref(work: WorkSummary): string {
	return `/works/${work.slug}-${work.publicId}`;
}

function WorkThumb({ work }: { work: WorkSummary }) {
	const src = work.thumbnail ? keyToPreview(work.thumbnail) : "";
	return src ? (
		<img src={src} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
	) : (
		<span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-base-300 text-base-content/50">
			{work.title.charAt(0).toUpperCase()}
		</span>
	);
}

export default function WorkCollaborationInvites({
	onChanged,
}: {
	/** Refetch anything behind the card after an acceptance. */
	onChanged?: () => void | Promise<void>;
}) {
	const [data, setData] = useState<WorkCollaborationsResponse | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const res = await fetch(`${apiBaseUrl()}/api/content/work-collaborations`, {
			credentials: "include",
		});
		if (!res.ok) throw new Error("Couldn't read your Work collaboration invitations.");
		setData((await res.json()) as WorkCollaborationsResponse);
	}, []);

	useEffect(() => {
		let live = true;
		void load().catch((err: unknown) => {
			if (live) setError(err instanceof Error ? err.message : "Couldn't read your invitations.");
		});
		return () => {
			live = false;
		};
	}, [load]);

	const act = async (key: string, url: string) => {
		setBusy(key);
		setError(null);
		try {
			const res = await fetch(url, { method: "POST", credentials: "include" });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "Couldn't answer the invitation.");
			}
			await load();
			await onChanged?.();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't answer the invitation.");
		} finally {
			setBusy(null);
		}
	};

	const waiting = data ? data.invites.length + data.handovers.length : 0;

	return (
		<section className="card bg-base-200" aria-labelledby="work-collaborations">
			<div className="card-body">
				<h3 id="work-collaborations" className="card-title text-lg">
					Work Collaborations
				</h3>
				<p className="text-sm text-base-content/60">
					Invitations to co-own a Work, and requests to take its publisher role.
				</p>

				{error && (
					<div className="alert alert-error mt-2 text-sm">
						<span>{error}</span>
					</div>
				)}

				{!data && !error && (
					<p className="mt-2 text-sm text-base-content/50">Reading your collaborations…</p>
				)}

				{data && waiting === 0 && (
					<p className="mt-2 text-sm text-base-content/50">
						No Work collaboration invitations are waiting.
					</p>
				)}

				{data && waiting > 0 && (
					<div className="mt-2 space-y-3">
						{data.invites.map((invite) => (
							<div
								key={`invite-${invite.id}`}
								className="flex flex-wrap items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3"
							>
								<WorkThumb work={invite.work} />
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold">
										{invite.inviter.displayName || `@${invite.inviter.handle}`} invited you to
										co-own{" "}
										<Link to={workHref(invite.work)} className="link">
											{invite.work.title || "this Work"}
										</Link>
									</p>
									<p className="text-xs text-base-content/50">
										The Work appears in both Studios and on both profiles once you accept.
									</p>
								</div>
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-primary btn-sm"
										disabled={busy !== null}
										onClick={() =>
											void act(
												`accept-${invite.work.id}`,
												`${apiBaseUrl()}/api/content/works/${invite.work.id}/collaborators/accept`,
											)
										}
									>
										Accept
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										disabled={busy !== null}
										onClick={() =>
											void act(
												`decline-${invite.work.id}`,
												`${apiBaseUrl()}/api/content/works/${invite.work.id}/collaborators/decline`,
											)
										}
									>
										Decline
									</button>
								</div>
							</div>
						))}
						{data.handovers.map((handover) => (
							<div
								key={`handover-${handover.id}`}
								className="flex flex-wrap items-center gap-3 rounded-xl border border-base-300 bg-base-100 p-3"
							>
								<WorkThumb work={handover.work} />
								<div className="min-w-0 flex-1">
									<p className="text-sm font-semibold">
										{handover.from.displayName || `@${handover.from.handle}`} wants to make you the
										publisher of{" "}
										<Link to={workHref(handover.work)} className="link">
											{handover.work.title || "this Work"}
										</Link>
									</p>
									<p className="text-xs text-base-content/50">
										The publisher holds the Work's listing home. Ownership, editing and the split do
										not change.
									</p>
								</div>
								<div className="flex gap-2">
									<button
										type="button"
										className="btn btn-primary btn-sm"
										disabled={busy !== null}
										onClick={() =>
											void act(
												`publisher-accept-${handover.work.id}`,
												`${apiBaseUrl()}/api/content/works/${handover.work.id}/publisher/accept`,
											)
										}
									>
										Accept publisher
									</button>
									<button
										type="button"
										className="btn btn-ghost btn-sm"
										disabled={busy !== null}
										onClick={() =>
											void act(
												`publisher-decline-${handover.work.id}`,
												`${apiBaseUrl()}/api/content/works/${handover.work.id}/publisher/decline`,
											)
										}
									>
										Decline
									</button>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</section>
	);
}
