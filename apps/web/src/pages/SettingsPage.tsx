// SPDX-License-Identifier: AGPL-3.0-or-later

import { MATURITY_DISPLAY_CHOICES, type MaturityDisplay } from "@anthers/shared/content-rating";
import { useAuth } from "@anthers/web-shared/auth";
import { useContentPreferences } from "@anthers/web-shared/content-preferences";
import {
	type DesktopHome,
	desktopHome,
	isDesktop,
	setDesktopHome,
} from "@anthers/web-shared/desktop";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiFetch } from "@anthers/web-shared/rpc";
import { useEffect, useState } from "react";
import BlueskyMark from "../components/auth/BlueskyMark";
import { studioUrl } from "../lib/studio";

interface DeviceSession {
	id: number;
	kind: string;
	label: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	lastUsedAt: string | null;
	createdAt: string;
	current: boolean;
}

function formatWhen(value: string | null): string {
	if (!value) return "never";
	const then = new Date(value).getTime();
	const mins = Math.round((Date.now() - then) / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
	return new Date(value).toLocaleDateString();
}

/**
 * Desktop-only: which surface the app opens on.
 *
 * Rendered nowhere else, because it would be meaningless in a browser — a browser has a
 * homepage and an address bar, so "where does it open" is not the app's question to
 * answer. The preference is per-install rather than per-account (see `desktopHome`), so
 * it is stored locally and there is nothing to save to the server and nothing to fail.
 */
function DesktopHomeSection() {
	const [home, setHome] = useState<DesktopHome>(() => desktopHome());
	if (!isDesktop()) return null;

	const choose = (next: DesktopHome) => {
		setDesktopHome(next);
		setHome(next);
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">When Anthers opens</h3>
				<p className="text-sm text-base-content/60">
					Where the app starts. This is set per computer, so you can read here and author somewhere
					else.
				</p>

				<div className="form-control mt-2 gap-2">
					<label className="label cursor-pointer justify-start gap-3 py-1">
						<input
							type="radio"
							name="desktop-home"
							className="radio radio-sm"
							checked={home === "feed"}
							onChange={() => choose("feed")}
						/>
						<span className="label-text">
							<span className="font-medium">Your feed</span>
							<span className="block text-xs text-base-content/50">
								The creators you follow, and what they've released
							</span>
						</span>
					</label>
					<label className="label cursor-pointer justify-start gap-3 py-1">
						<input
							type="radio"
							name="desktop-home"
							className="radio radio-sm"
							checked={home === "studio"}
							onChange={() => choose("studio")}
						/>
						<span className="label-text">
							<span className="font-medium">The Studio</span>
							<span className="block text-xs text-base-content/50">
								Your Catalog, uploads and drafts
							</span>
						</span>
					</label>
				</div>
			</div>
		</div>
	);
}

/**
 * Devices — the revocation surface for signed-in sessions.
 *
 * This is what makes a long-lived desktop token safe to hand out: a stolen laptop is
 * killable here without signing every browser out. Browser sessions are listed too,
 * since "where am I signed in" is the question a creator actually has.
 */
function DevicesSection() {
	const [sessions, setSessions] = useState<DeviceSession[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [revoking, setRevoking] = useState<number | null>(null);

	const load = () => {
		apiFetch("/api/auth/sessions")
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load devices."))))
			.then((data) => setSessions((data as { sessions: DeviceSession[] }).sessions))
			.catch(() => setError("Could not load your devices."));
	};

	useEffect(load, []);

	const revoke = async (id: number) => {
		setRevoking(id);
		setError(null);
		try {
			const res = await apiFetch(`/api/auth/sessions/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed to sign that device out.");
			setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to sign that device out.");
		} finally {
			setRevoking(null);
		}
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Devices</h3>
				<p className="text-sm text-base-content/60">
					Where you're signed in. Signing a device out immediately ends its access.
				</p>

				{error && (
					<div className="alert alert-error text-sm mt-2">
						<span>{error}</span>
					</div>
				)}

				{sessions === null && !error && (
					<p className="text-sm text-base-content/50 mt-2">Loading…</p>
				)}

				{sessions !== null && (
					<ul className="mt-2 divide-y divide-base-300">
						{sessions.map((s) => (
							<li key={s.id} className="flex items-center gap-3 py-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="font-medium truncate">
											{s.label ?? (s.kind === "desktop" ? "Anthers Desktop" : "Browser")}
										</span>
										{s.kind === "desktop" && <span className="badge badge-sm">Desktop</span>}
										{s.current && <span className="badge badge-sm badge-primary">This device</span>}
									</div>
									<div className="text-xs text-base-content/50 truncate">
										Last used {formatWhen(s.lastUsedAt)}
										{s.ipAddress ? ` · ${s.ipAddress}` : ""}
									</div>
								</div>
								{!s.current && (
									<button
										type="button"
										className="btn btn-ghost btn-xs"
										onClick={() => revoke(s.id)}
										disabled={revoking === s.id}
									>
										{revoking === s.id ? "Signing out…" : "Sign out"}
									</button>
								)}
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

interface BlockedUser {
	id: number;
	username: string;
	displayName: string | null;
	createdAt: string;
}

/**
 * What the reader meets at each rung, and the door to the Adult rung.
 *
 * 🚨 **The two rungs get separate controls, and that separation is the design rather than
 * layout.** A reader who wants difficult work unblurred has said nothing about whether they
 * want explicit work at all, and one control covering both would make them say it (wiki
 * 40.09).
 *
 * 🚨 **Nothing here may describe paying as an age check.** A payment proves nothing about
 * age — debit and prepaid cards have no age floor. What carries the signal is the card's
 * funding TYPE, because issuers require the primary accountholder of a credit line to be 18.
 * The copy says that plainly, including the part where an adult with only a debit card
 * cannot get in and nothing routes around it.
 */
function MatureContentSection() {
	const { prefs, refresh } = useContentPreferences();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const setDisplay = async (rung: "mature" | "adult", value: MaturityDisplay) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/content-preferences", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ [rung]: value }),
			});
			if (!res.ok) throw new Error();
			await refresh();
		} catch {
			setError("That preference couldn't be saved.");
		} finally {
			setBusy(false);
		}
	};

	const setAdultAccess = async (on: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/adult-access", {
				method: on ? "POST" : "DELETE",
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				// The server's own sentence. Each refusal has a different remedy and one has
				// none, so a generic message here would undo the whole point of them being
				// separate values.
				setError(body?.error ?? "That couldn't be saved.");
				return;
			}
			await refresh();
		} catch {
			setError("That couldn't be saved.");
		} finally {
			setBusy(false);
		}
	};

	const rungControl = (rung: "mature" | "adult", current: MaturityDisplay) => (
		<div className="join">
			{MATURITY_DISPLAY_CHOICES.map((choice) => (
				<button
					key={choice.value}
					type="button"
					className={`btn btn-sm join-item ${current === choice.value ? "btn-primary" : "btn-outline"}`}
					disabled={busy}
					title={choice.hint}
					onClick={() => setDisplay(rung, choice.value)}
				>
					{choice.label}
				</button>
			))}
		</div>
	);

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body gap-4">
				<div>
					<h3 className="card-title text-lg">Mature Content</h3>
					<p className="text-sm text-base-content/60">
						What you meet before you choose. Nothing here changes what a creator earns or whether
						anyone else can find their work.
					</p>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<p className="font-medium text-sm">Mature</p>
						<p className="text-xs text-base-content/60">
							Work made for adults — violence, sex or difficult subjects shown rather than implied.
							Covered by default.
						</p>
					</div>
					{rungControl("mature", prefs.mature)}
				</div>

				<div className="border-t border-base-300 pt-4">
					<p className="font-medium text-sm">Adult</p>
					<p className="text-xs text-base-content/60">
						Explicit sexual content. You will not see it anywhere on Anthers unless you turn this
						on, and it is always sold or gated by its creator rather than free.
					</p>

					{prefs.adultAccess.canReach ? (
						<div className="mt-3 flex flex-wrap items-center justify-between gap-3">
							{rungControl("adult", prefs.adult)}
							<button
								type="button"
								className="btn btn-sm btn-ghost"
								disabled={busy}
								onClick={() => setAdultAccess(false)}
							>
								Turn Adult content off
							</button>
						</div>
					) : (
						<div className="mt-3">
							<p className="text-xs text-base-content/60">
								Turning this on checks that you are an adult by looking at whether the card on your
								account is a <strong>credit</strong> card, because card issuers require the primary
								accountholder to be 18. Paying for something is not the check — debit and prepaid
								cards have no age requirement at all, so they cannot answer it. We keep only that
								the check happened and when; we never see or store your date of birth, and we never
								ask for ID.
							</p>
							<p className="mt-2 text-xs text-base-content/60">
								If your only card is a debit or prepaid card, this will not let you in and we do not
								have another way to do it. We would rather say so than pretend otherwise.
							</p>
							<button
								type="button"
								className="btn btn-sm btn-outline mt-3"
								disabled={busy}
								onClick={() => setAdultAccess(true)}
							>
								Turn Adult content on
							</button>
						</div>
					)}
				</div>

				{error && <p className="text-sm text-error">{error}</p>}
			</div>
		</div>
	);
}

/**
 * Blocked accounts — and the only place a block can be lifted.
 *
 * It has to exist for the feature to be honest. Blocking makes the other person's
 * profile 404 for you, so the page you blocked them from can no longer name them —
 * without this list a block would be a one-way door. `GET /me/blocks` is deliberately
 * one-directional: it answers "who have I blocked?", never "who has blocked me?",
 * because answering the second would be Anthers stating a block, which is the one
 * thing the feature refuses to do.
 *
 * Sits beside Devices rather than under anything called moderation. A block is your
 * own boundary; nobody reviews it and no operator sees it.
 */
function BlockedSection() {
	const [blocks, setBlocks] = useState<BlockedUser[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [lifting, setLifting] = useState<number | null>(null);

	const load = () => {
		apiFetch("/api/accounts/me/blocks")
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load blocks."))))
			.then((data) => setBlocks((data as { blocks: BlockedUser[] }).blocks))
			.catch(() => setError("Could not load your blocked accounts."));
	};

	useEffect(load, []);

	const unblock = async (u: BlockedUser) => {
		setLifting(u.id);
		setError(null);
		try {
			const res = await apiFetch(`/api/accounts/users/${u.username}/unblock`, { method: "POST" });
			if (!res.ok) throw new Error("Failed to unblock.");
			setBlocks((prev) => prev?.filter((b) => b.id !== u.id) ?? null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to unblock.");
		} finally {
			setLifting(null);
		}
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Blocked accounts</h3>
				<p className="text-sm text-base-content/60">
					You and a blocked account don't see each other around Anthers. Unblocking doesn't restore
					any follows that existed before — you'd need to follow again.
				</p>

				{error && (
					<div className="alert alert-error text-sm mt-2">
						<span>{error}</span>
					</div>
				)}

				{blocks === null && !error && <p className="text-sm text-base-content/50 mt-2">Loading…</p>}

				{blocks !== null && blocks.length === 0 && (
					<p className="text-sm text-base-content/50 mt-2">You haven't blocked anyone.</p>
				)}

				{blocks !== null && blocks.length > 0 && (
					<ul className="mt-2 divide-y divide-base-300">
						{blocks.map((b) => (
							<li key={b.id} className="flex items-center gap-3 py-3">
								<div className="min-w-0 flex-1">
									<div className="font-medium truncate">{b.displayName || b.username}</div>
									<div className="text-xs text-base-content/50 truncate">
										@{b.username} · blocked {formatWhen(b.createdAt)}
									</div>
								</div>
								<button
									type="button"
									className="btn btn-ghost btn-xs"
									onClick={() => unblock(b)}
									disabled={lifting === b.id}
								>
									{lifting === b.id ? "Unblocking…" : "Unblock"}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

/**
 * Connecting a Bluesky (ATProto) identity to this account.
 *
 * ⚠️ **The copy here is the whole feature, and it is easy to overclaim.** What linking does
 * today is exactly two things: it proves the same person holds both identities, and it lets
 * that handle sign in at `/login`. It publishes nothing, moves no content, and grants
 * Anthers no ability to act on the account — the OAuth request asks for the `atproto` scope,
 * which is identity and nothing else. Saying more than that would trip `RETIRED_COPY`, and
 * the guard exists because this exact framing drifted back onto marketing pages twice.
 */
function BlueskySection() {
	const { user, linkBluesky, unlinkBluesky, refreshUser } = useAuth();
	const [searchParams] = useSearchParams();
	const [handle, setHandle] = useState("");
	const [linking, setLinking] = useState(false);
	const [unlinking, setUnlinking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const blueskyResult = searchParams.get("bluesky");
	const isLinked = !!user?.atprotoDid;

	useEffect(() => {
		if (blueskyResult === "linked") {
			refreshUser();
		}
	}, [blueskyResult, refreshUser]);

	const handleLink = async (e: React.FormEvent) => {
		e.preventDefault();
		// A handle is a domain name; the leading `@` is how people write it, not part of it.
		const identifier = handle.trim().replace(/^@/, "");
		if (!identifier) return;
		setError(null);
		setLinking(true);
		try {
			await linkBluesky(identifier);
			// linkBluesky redirects, so we won't reach here
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't reach Bluesky. Please try again.");
			setLinking(false);
		}
	};

	const handleUnlink = async () => {
		setError(null);
		setUnlinking(true);
		try {
			await unlinkBluesky();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to unlink Bluesky account.");
		} finally {
			setUnlinking(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">
					<BlueskyMark />
					Bluesky / ATProto
				</h3>

				{blueskyResult === "linked" && (
					<div className="alert alert-success text-sm">
						<span>Bluesky account linked successfully.</span>
					</div>
				)}

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				{isLinked ? (
					<div className="flex flex-col gap-3">
						<div className="flex items-center gap-2">
							<div className="badge badge-success">Linked</div>
							<span className="text-sm font-medium">
								{user.atprotoHandle ? `@${user.atprotoHandle}` : "handle unavailable"}
							</span>
						</div>
						<p className="text-xs text-base-content/50">DID: {user.atprotoDid}</p>
						<p className="text-sm text-base-content/60">
							You can log in to Anthers with this handle. Unlinking stops that and leaves everything
							else on your account untouched.
						</p>
						<button
							type="button"
							className="btn btn-outline btn-error btn-sm w-fit"
							onClick={handleUnlink}
							disabled={unlinking}
						>
							{unlinking ? "Unlinking…" : "Unlink Bluesky"}
						</button>
					</div>
				) : (
					<form onSubmit={handleLink} className="flex flex-col gap-3">
						<p className="text-sm text-base-content/60">
							Connect a Bluesky account and you can log in to Anthers with it. Anthers asks only to
							confirm who you are — it can't post, follow, or change anything on your Bluesky
							account.
						</p>
						<p className="text-sm text-base-content/60">
							Linking doesn't publish your Anthers work to Bluesky or move it anywhere. Federation
							is a direction we're committed to, not something we've shipped.
						</p>
						<div className="flex gap-2">
							<input
								type="text"
								className="input input-bordered flex-1"
								value={handle}
								onChange={(e) => setHandle(e.target.value)}
								placeholder="alice.bsky.social"
							/>
							<button
								type="submit"
								className="btn btn-primary btn-sm"
								disabled={linking || !handle.trim()}
							>
								{linking ? "Linking…" : "Link account"}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

interface DeletionPreview {
	follows: number;
	bookmarks: number;
	blocks: number;
	viewingEvents: number;
	sessions: number;
	comments: number;
	reviews: number;
	posts: number;
	worksDeleted: number;
	worksWithdrawn: number;
	purchases: number;
}

interface DeletionState {
	scheduledFor: string | null;
	graceDays: number;
	preview: DeletionPreview;
}

/**
 * Your data — the export button and the deletion flow.
 *
 * 🚨 **This section is what makes two published sentences true.** 51.05 has said since it
 * was written that getting a copy of your data and deleting your account are things you
 * do yourself, and `/parents` said the same to parents. The API routes shipped in PR #193
 * and **nothing ever called them**, so both documents described a self-service control
 * that did not exist — a promise with no mechanism, which is the failure this codebase
 * keeps finding. The copy was corrected to "ask us" in PR #227; this restores the claim.
 *
 * Two things here are deliberate rather than incidental:
 *
 * **The counts are real, and they are the whole point of the confirmation.** Parker's
 * ruling on deletion (2026-08-07) was that the safety lives in *informed consent plus an
 * oops window*, not in the foreign keys — so "your content will be deleted" is a sentence
 * people click past, and "3 Works deleted, 1 withdrawn because someone bought it, 14
 * comments tombstoned" is a decision. They come from `deletionPreview()` on the server,
 * per account, never from anything computed here.
 *
 * **The outcomes are not uniform and the UI must not flatten them.** Some things are
 * destroyed, some tombstoned, some anonymised, and some kept with the person detached for
 * tax records. Showing one number would misrepresent all four.
 */
function DataSection() {
	const [state, setState] = useState<DeletionState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [exporting, setExporting] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);

	const load = () => {
		apiFetch("/api/accounts/me/deletion")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load your data."))))
			.then((d) => setState(d as DeletionState))
			.catch((e) => setError(e instanceof Error ? e.message : "Could not load your data."));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: load on mount only
	useEffect(load, []);

	const handleExport = async () => {
		setExporting(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/export");
			if (!res.ok) throw new Error("Export failed.");
			// The server sends it as an attachment deliberately — this is the one document
			// containing everything about a person, and a browser rendering it in a tab is a
			// thing that ends up in shared screenshots and back-button history. Honour that
			// by saving it rather than navigating to it.
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `anthers-export-${new Date().toISOString().slice(0, 10)}.json`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Export failed.");
		} finally {
			setExporting(false);
		}
	};

	const handleDelete = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me", { method: "DELETE" });
			if (!res.ok) throw new Error("Could not schedule deletion.");
			// Every session went with the request, including this one. A full reload is the
			// honest response: staying on a logged-in-looking page would be a lie the client
			// is telling about a server that has already forgotten us.
			window.location.href = "/";
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not schedule deletion.");
			setBusy(false);
		}
	};

	const handleCancel = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/deletion/cancel", { method: "POST" });
			if (!res.ok) throw new Error("Could not cancel.");
			load();
			setConfirming(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not cancel.");
		} finally {
			setBusy(false);
		}
	};

	const p = state?.preview;
	const scheduled = state?.scheduledFor;

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Your data</h3>

				{error && (
					<div className="alert alert-error alert-sm">
						<span>{error}</span>
					</div>
				)}

				<div className="flex flex-wrap items-center gap-3">
					<button type="button" className="btn btn-sm" onClick={handleExport} disabled={exporting}>
						{exporting ? "Preparing…" : "Download my data"}
					</button>
					<p className="text-xs text-base-content/60">
						Everything we hold about you, as a JSON file. It does not include your password, or
						anything that is someone else's.
					</p>
				</div>

				<div className="divider my-2" />

				{scheduled ? (
					<div className="alert alert-warning flex-col items-start gap-2">
						<span className="font-medium">
							Your account is scheduled for deletion on {new Date(scheduled).toLocaleDateString()}.
						</span>
						<span className="text-sm">
							Nothing has been deleted yet. Cancelling puts everything back exactly as it was —
							there is no separate restore.
						</span>
						<button type="button" className="btn btn-sm" onClick={handleCancel} disabled={busy}>
							Cancel deletion
						</button>
					</div>
				) : (
					<>
						<h4 className="font-medium text-error">Delete my account</h4>
						{!confirming ? (
							<div className="flex flex-wrap items-center gap-3">
								<button
									type="button"
									className="btn btn-sm btn-error btn-outline"
									onClick={() => setConfirming(true)}
								>
									Delete my account
								</button>
								<p className="text-xs text-base-content/60">
									You get {state?.graceDays ?? 7} days to change your mind.
								</p>
							</div>
						) : (
							<div className="rounded-lg border border-error/40 p-4">
								<p className="text-sm font-medium">Here is exactly what happens to this account:</p>
								{p ? (
									<ul className="mt-2 space-y-1 text-sm text-base-content/80">
										<li>
											<strong>Deleted:</strong> your profile, {p.follows} follow
											{p.follows === 1 ? "" : "s"}, {p.bookmarks} bookmark
											{p.bookmarks === 1 ? "" : "s"}, {p.sessions} session
											{p.sessions === 1 ? "" : "s"}, and {p.viewingEvents} viewing record
											{p.viewingEvents === 1 ? "" : "s"}.
										</li>
										<li>
											<strong>Kept, with your name removed:</strong> {p.posts} post
											{p.posts === 1 ? "" : "s"} and {p.comments} comment
											{p.comments === 1 ? "" : "s"} — so conversations other people took part in
											stay readable — and {p.reviews} review
											{p.reviews === 1 ? "" : "s"}, whose scores stay in creators' averages.
										</li>
										<li>
											<strong>Your Works:</strong> {p.worksDeleted} deleted
											{p.worksWithdrawn > 0 ? (
												<>
													, and {p.worksWithdrawn} withdrawn rather than destroyed because someone
													bought {p.worksWithdrawn === 1 ? "it" : "them"} — a purchase outlives the
													account that sold it
												</>
											) : null}
											.
										</li>
										<li>
											<strong>Kept without you attached:</strong> {p.purchases} purchase
											{p.purchases === 1 ? "" : "s"}, because we have to be able to evidence sales
											tax.
										</li>
									</ul>
								) : (
									<p className="mt-2 text-sm text-base-content/60">Loading your counts…</p>
								)}
								<p className="mt-3 text-sm">
									It takes effect in {state?.graceDays ?? 7} days. Signing back in during that week
									cancels it. You will be signed out everywhere now.
								</p>
								<div className="mt-3 flex gap-2">
									<button
										type="button"
										className="btn btn-sm btn-error"
										onClick={handleDelete}
										disabled={busy || !p}
									>
										{busy ? "Scheduling…" : "Yes, delete my account"}
									</button>
									<button
										type="button"
										className="btn btn-sm btn-ghost"
										onClick={() => setConfirming(false)}
										disabled={busy}
									>
										Keep my account
									</button>
								</div>
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

export default function SettingsPage() {
	const { user, refreshUser } = useAuth();

	const [isCreator, setIsCreator] = useState(user?.isCreator || false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const handleCreatorToggle = async (checked: boolean) => {
		setIsCreator(checked);
		setSaving(true);
		setError(null);
		setSuccess(false);

		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ isCreator: checked }),
			});

			if (!res.ok) {
				const data = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(data?.error ?? "Failed to save settings.");
			}

			await refreshUser();
			setSuccess(true);
		} catch (err) {
			setIsCreator(!checked); // revert on failure
			setError(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="max-w-2xl mx-auto px-4 py-8">
			<h1 className="text-2xl font-bold mb-6">Settings</h1>

			{error && (
				<div className="alert alert-error mb-4">
					<span>{error}</span>
				</div>
			)}
			{success && (
				<div className="alert alert-success mb-4">
					<span>Settings saved.</span>
				</div>
			)}

			{/* Creator mode toggle */}
			<div className="card bg-base-200 mb-6">
				<div className="card-body">
					<div className="form-control">
						<label className="label cursor-pointer justify-start gap-3">
							<input
								type="checkbox"
								className="toggle toggle-primary"
								checked={isCreator}
								onChange={(e) => handleCreatorToggle(e.target.checked)}
								disabled={saving || !user?.emailVerified}
							/>
							<div>
								<span className="label-text font-medium">Enable creator mode</span>
								<p className="text-xs text-base-content/50 mt-0.5">
									Allows you to publish projects and posts
								</p>
							</div>
						</label>
						{!user?.emailVerified && (
							<p className="text-xs text-warning mt-2">
								<Link to="/verify-email" className="link">
									Verify your email
								</Link>{" "}
								to enable creator mode.
							</p>
						)}
					</div>
				</div>
			</div>

			{/* Bluesky / ATProto */}
			<BlueskySection />

			{/* Signed-in devices — revocation for browsers and the desktop Studio. */}
			<DesktopHomeSection />

			<DevicesSection />

			{/* What the reader meets at each rung, and the door to the Adult rung. */}
			<MatureContentSection />

			{/* Blocked accounts — the only place a block can be lifted, since a blocked
			    profile no longer resolves. */}
			<BlockedSection />

			{/* Export and deletion — the controls 51.05 and /parents describe. */}
			<DataSection />

			{/* Creator tools live in the Studio (payouts, connections, Badges). */}
			{isCreator && (
				<div className="card bg-base-200 mt-6">
					<div className="card-body">
						<h3 className="card-title text-lg">Creator tools</h3>
						<p className="text-sm text-base-content/60">
							Manage payouts, platform connections, and your Badges in your Studio.
						</p>
						<a href={studioUrl("/settings")} className="btn btn-primary btn-sm w-fit">
							Open Studio settings
						</a>
					</div>
				</div>
			)}
		</div>
	);
}
