// SPDX-License-Identifier: AGPL-3.0-or-later

import { MATURITY_DISPLAY_CHOICES, type MaturityDisplay } from "@anthers/shared/content-rating";
import { normalizeHandleName } from "@anthers/shared/handles";
import { useAuth } from "@anthers/web-shared/auth";
import { useContentPreferences } from "@anthers/web-shared/content-preferences";
import {
	type DesktopHome,
	desktopHome,
	isDesktop,
	setDesktopHome,
} from "@anthers/web-shared/desktop";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiFetch, client } from "@anthers/web-shared/rpc";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useEffect, useState } from "react";
import BlueskyMark from "../components/auth/BlueskyMark";
import ParentalControlsSection from "../components/settings/ParentalControlsSection";
import { handleStatusLine, handleStatusTone, useHandleAvailability } from "../lib/hosted-handle";
import { generateRecoveryKey, type RecoveryKeypair } from "../lib/recovery-key";
import { getStripe } from "../lib/stripe";
import { cardElementStyle } from "../lib/stripeCard";
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
 * The card field, shown only when there is no card to read.
 *
 * 🚨 **A `SetupIntent`, so no money moves and nothing reaches a statement.** The check reads
 * the card's funding type and nothing else. This must never become a charge — see the route
 * and `beginAdultVerification` for why.
 */
function AdultVerificationCard({ onVerified }: { onVerified: () => Promise<void> }) {
	const stripe = useStripe();
	const elements = useElements();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const submit = async () => {
		if (!stripe || !elements) return;
		const card = elements.getElement(CardElement);
		if (!card) return;
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/adult-access/setup", { method: "POST" });
			if (!res.ok) throw new Error();
			const { clientSecret } = (await res.json()) as { clientSecret: string };

			const { error: stripeError } = await stripe.confirmCardSetup(clientSecret, {
				payment_method: { card },
			});
			// ⚠️ Stripe's own message, because it is the one that says *which* thing about
			// the card was wrong. "That didn't work" would send somebody to re-type a number
			// that was never the problem.
			if (stripeError) {
				setError(stripeError.message ?? "That card couldn't be added.");
				return;
			}
			// The card is attached; the funding check reads it on the next call.
			await onVerified();
		} catch {
			setError("That check couldn't be completed. Please try again shortly.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mt-3 rounded-box border border-base-300 p-3">
			<p className="text-xs text-base-content/60">
				Add a credit card to confirm you're an adult. <strong>You will not be charged</strong> —
				nothing is billed and nothing appears on your statement. We read only whether the card is a
				credit card, and we keep only that the check happened.
			</p>
			<div className="mt-3 rounded-box border border-base-300 bg-base-100 px-3 py-2">
				<CardElement options={{ style: cardElementStyle() }} />
			</div>
			{error && <p className="mt-2 text-sm text-error">{error}</p>}
			<button
				type="button"
				className="btn btn-sm btn-primary mt-3"
				disabled={busy || !stripe}
				onClick={submit}
			>
				{busy ? "Checking…" : "Confirm I'm an adult"}
			</button>
		</div>
	);
}

/**
 * What the reader meets at each rung, and the door to the Adult rung.
 *
 * 🚨 **The two rungs get separate controls, and that separation is the design rather than
 * layout.** A reader who wants difficult work unblurred has said nothing about whether they
 * want explicit work at all, and one control covering both would make them say it (wiki
 * The wiki's *Content Standards*).
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
	// True once the server has said there is no card to read — the ordinary case for
	// somebody who has never paid, which is most of the audience for free Adult work.
	const [needsCard, setNeedsCard] = useState(false);

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
				const body = (await res.json().catch(() => null)) as {
					error?: string;
					code?: string;
				} | null;
				// ⭐ `no_card` is not an error, it is the next step. Somebody who has never
				// paid for anything has no card to read, and that is the ordinary case now
				// that Adult work can be free — so open the card field rather than telling
				// them they are stuck.
				if (body?.code === "no_card") {
					setNeedsCard(true);
					return;
				}
				// The server's own sentence otherwise. Each refusal has a different remedy
				// and one has none, so a generic message here would undo the whole point of
				// them being separate values.
				setError(body?.error ?? "That couldn't be saved.");
				return;
			}
			setNeedsCard(false);
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
						on. Creators set their own price for it, or leave it free, exactly as they would for
						anything else.
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
								cards have no age requirement at all, so they cannot answer it, and{" "}
								<strong>you are not charged anything</strong> either way. We keep only that the
								check happened and when; we never see or store your date of birth, and we never ask
								for ID.
							</p>
							<p className="mt-2 text-xs text-base-content/60">
								If your only card is a debit or prepaid card, this will not let you in and we do not
								have another way to do it. We would rather say so than pretend otherwise.
							</p>
							{needsCard ? (
								<Elements stripe={getStripe()}>
									<AdultVerificationCard
										onVerified={async () => {
											await setAdultAccess(true);
										}}
									/>
								</Elements>
							) : (
								<button
									type="button"
									className="btn btn-sm btn-outline mt-3"
									disabled={busy}
									onClick={() => setAdultAccess(true)}
								>
									Turn Adult content on
								</button>
							)}
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
 * The account's identity on the AT Protocol network, whichever way it got one.
 *
 * 🚨 **Three states, and each one hides the offers that would be wrong in it.** An account can
 * hold a handle Anthers issued, hold one it brought from somewhere else, or hold neither — and
 * an account may have exactly one. Showing both doors to somebody who already walked through a
 * door is how a person ends up with two identities and nothing saying which is theirs, so the
 * card they see is decided here rather than by four separate components each guessing.
 *
 * ⚠️ **Whether an identity is Anthers-issued is derived from the suffix, not from a flag on the
 * account.** `/api/atproto/config` reports the suffix handles hang under, and only Anthers
 * issues names beneath it, so a handle ending in it is one of ours. The alternative is a column
 * that means the same thing and can disagree with the node. **The server does not trust this
 * derivation** — `unlinkAtprotoFromUser` asks `hosted_accounts` directly — so the worst a
 * wrong answer here can do is show a button that then refuses.
 *
 * ⚠️ **One state is deliberately left showing an offer that will be refused**: an account with a
 * credential row and no DID, which is what a provisioning that half-failed leaves behind. The
 * browser cannot see that row and the refusal names the handle it already holds, so the person
 * learns the useful thing either way — and inventing a field to describe a state the docblock on
 * `provisionHostedIdentity` calls unreachable in practice would be paying for it every render.
 */
function IdentitySection() {
	const { user } = useAuth();
	const [hostingOpen, setHostingOpen] = useState(false);
	const [suffix, setSuffix] = useState("");
	const [justIssued, setJustIssued] = useState<string | null>(null);
	const [recovery, setRecovery] = useState<RecoveryKeyState | null>(null);

	useEffect(() => {
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then(({ hostedIdentityOffered, hostedHandleSuffix }) => {
				if (!live) return;
				setHostingOpen(hostedIdentityOffered);
				setSuffix(hostedHandleSuffix);
			})
			.catch(() => {
				/* Unreachable API: the offer stays closed, and what is already linked still shows. */
			});
		return () => {
			live = false;
		};
	}, []);

	// Only asked for once it is known there is an identity to ask about — the endpoint requires
	// a session and answers `hosted: false` for an account with none, which is a round trip
	// worth not making on every settings visit.
	useEffect(() => {
		if (!user?.atprotoDid) return;
		let live = true;
		client.api.atproto["recovery-key"]
			.$get()
			.then((res) => (res.ok ? res.json() : null))
			.then((data) => {
				if (live && data) setRecovery(data as RecoveryKeyState);
			})
			.catch(() => {
				/* Unreachable API: the card says it could not check rather than offering. */
			});
		return () => {
			live = false;
		};
	}, [user?.atprotoDid]);

	const handle = user?.atprotoHandle ?? "";
	const hosted = !!suffix && handle.endsWith(`.${suffix}`);

	return (
		<>
			{hosted && (
				<AnthersHandleCard
					handle={handle}
					justIssued={justIssued}
					holdsRecoveryKey={!!recovery?.didKey}
				/>
			)}
			{/* ⚠️ Waits for the answer rather than rendering the offer meanwhile. Somebody who
			    already holds a key would otherwise be offered another one for the frame between
			    the page loading and the API answering — the same defect as the handle offer above. */}
			{hosted && recovery && <RecoveryKeyCard state={recovery} onSeated={setRecovery} />}
			{/* ⚠️ **`user &&` rather than `!user?.atprotoDid`**, which is also true while the account
			    is still loading. The config answer and the account arrive independently, so without
			    it an account that already holds an identity can be offered another one for the
			    frame between them. */}
			{user && !user.atprotoDid && !hosted && hostingOpen && (
				<AnthersHandleOffer suffix={suffix} onIssued={setJustIssued} />
			)}
			{!hosted && <BlueskySection />}
		</>
	);
}

/** What the API says Anthers did about this account's recovery key. */
interface RecoveryKeyState {
	hosted: boolean;
	didKey: string | null;
	seatedAt: string | null;
}

/**
 * Taking the key that outranks Anthers'.
 *
 * 🚨 **The weight of this card is the point, not decoration.** A key somebody loses is worse
 * than one they never had: it sits at the top of the identity's authority list, where nothing
 * beneath it — including both of Anthers' keys — can remove it or undo what it signs. So this
 * is written to be read before it is used, and the private half is shown beside the field that
 * finishes the job rather than on a screen somebody clicks past.
 *
 * ⚠️ **Anthers never sees the private half.** It is generated in this tab and the only thing
 * sent anywhere is the `did:key:` public half — see `lib/recovery-key.ts`.
 *
 * ⭐ **An abandoned attempt costs nothing, which is what makes the strong warning safe to
 * give.** Nothing is seated until the emailed code comes back, so somebody who reads this,
 * thinks better of it and closes the tab has changed nothing about their identity.
 */
function RecoveryKeyCard({
	state,
	onSeated,
}: {
	state: RecoveryKeyState;
	onSeated: (next: RecoveryKeyState) => void;
}) {
	const [pair, setPair] = useState<RecoveryKeypair | null>(null);
	const [code, setCode] = useState("");
	const [saved, setSaved] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// ⚠️ Generating and asking for the code together, rather than as two presses. The person
	// needs both in front of them anyway, and a flow that mails the code first leaves somebody
	// holding a code for a key that does not exist yet.
	const begin = async () => {
		setError(null);
		setBusy(true);
		try {
			const res = await client.api.atproto["recovery-key"].request.$post();
			const body = await res.json();
			if ("error" in body) {
				setError(body.error);
				return;
			}
			setPair(generateRecoveryKey());
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	const seat = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!pair) return;
		setError(null);
		setBusy(true);
		try {
			const res = await client.api.atproto["recovery-key"].confirm.$post({
				json: { token: code.trim(), didKey: pair.didKey },
			});
			const body = await res.json();
			if ("error" in body) {
				setError(body.error);
				setBusy(false);
				return;
			}
			// The private half goes out of memory here. It was shown once, which is what was
			// promised, and keeping it around would only widen where it can be read from.
			setPair(null);
			setCode("");
			onSeated({ hosted: true, didKey: body.didKey, seatedAt: new Date().toISOString() });
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
			setBusy(false);
		}
	};

	if (state.didKey) {
		return (
			<div className="card bg-base-200">
				<div className="card-body">
					<h3 className="card-title text-lg">Your Recovery Key</h3>
					<div className="flex items-center gap-2">
						<div className="badge badge-success">Held by you</div>
						{state.seatedAt && (
							<span className="text-xs text-base-content/50">
								Taken {new Date(state.seatedAt).toLocaleDateString()}
							</span>
						)}
					</div>
					<p className="text-sm text-base-content/60">
						Your key ranks above both of Anthers'. With it you can move this identity to another
						server without Anthers' cooperation, and Anthers cannot undo that.
					</p>
					<p className="break-all text-xs text-base-content/50">{state.didKey}</p>
					<p className="text-sm text-base-content/60">
						That is the public half, which is on the public record anyway. The private half was
						shown to you once and Anthers has never had a copy — if it is lost, nothing here can
						replace it and nothing can remove it from your identity.
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">A Recovery Key</h3>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				<p className="text-sm text-base-content/60">
					Anthers holds the keys to the identity it issued you. A recovery key is one of your own
					that ranks above them: it lets you move your identity to another server without Anthers'
					cooperation, and against its wishes if it ever came to that.
				</p>
				<p className="text-sm text-base-content/60">
					Anthers never sees it. It is made in this browser, shown to you once, and only its public
					half is sent anywhere.
				</p>

				{!pair ? (
					<>
						{/* 🚨 The one thing somebody must understand before pressing the button, and the
						    reason this is a deliberate step rather than something handed out at signup. */}
						<div className="alert alert-warning text-sm">
							<span>
								Keep it somewhere you will still have in years. A recovery key you lose cannot be
								replaced or removed — it stays at the top of your identity, where neither you nor
								Anthers can use it.
							</span>
						</div>
						<button
							type="button"
							className="btn btn-primary btn-sm w-fit"
							onClick={() => void begin()}
							disabled={busy}
						>
							{busy ? "Working…" : "Take a recovery key"}
						</button>
					</>
				) : (
					<form onSubmit={seat} className="flex flex-col gap-3">
						<div>
							<p className="text-sm font-medium">Your recovery key</p>
							<p className="mt-1 break-all rounded-lg bg-base-300 p-3 font-mono text-xs">
								{pair.privateHex}
							</p>
							<p className="mt-1 text-xs text-base-content/50">
								This is the only time it is shown. Copy it somewhere safe before you go on.
							</p>
						</div>

						<label className="label cursor-pointer justify-start gap-3 py-0">
							<input
								type="checkbox"
								className="checkbox checkbox-sm"
								checked={saved}
								onChange={(e) => setSaved(e.target.checked)}
							/>
							<span className="label-text text-sm">I have saved it somewhere safe.</span>
						</label>

						<div>
							<p className="text-sm text-base-content/60">
								Anthers has emailed you a code. Enter it to put your key in place.
							</p>
							<input
								type="text"
								className="input input-bordered mt-2 w-full max-w-xs"
								value={code}
								onChange={(e) => setCode(e.target.value)}
								placeholder="ABCDE-FGHIJ"
								aria-label="The code Anthers emailed you"
								autoComplete="one-time-code"
								spellCheck={false}
							/>
						</div>

						<button
							type="submit"
							className="btn btn-primary btn-sm w-fit"
							disabled={busy || !saved || !code.trim()}
						>
							{busy ? "Working…" : "Put my key in place"}
						</button>
					</form>
				)}
			</div>
		</div>
	);
}

/**
 * The handle Anthers issued, once somebody has one.
 *
 * ⚠️ **It says who holds the keys, because the honest version of this is the one that has to be
 * said out loud.** The identity is the account holder's and the repository behind it is theirs;
 * what is Anthers' is the pair of keys that can move it. Somebody reading this card should not
 * have to infer that from the absence of a button, and a card that described the name without
 * describing the custody would be selling the good half of the arrangement.
 *
 * 🚨 **There is no unlink here and the omission is the feature.** Unlinking is for an identity
 * that lives somewhere else and carries on without Anthers; this one lives on Anthers' own node
 * and the hub holds the only password to it, so detaching it would leave a person with a
 * repository they can no longer reach. The route refuses it too — see
 * `unlinkAtprotoFromUser` — because a guard that lives only in a component is a guard that
 * lives nowhere.
 */
function AnthersHandleCard({
	handle,
	justIssued,
	holdsRecoveryKey,
}: {
	handle: string;
	justIssued: string | null;
	holdsRecoveryKey: boolean;
}) {
	const { user } = useAuth();
	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Your Anthers Handle</h3>

				{justIssued && (
					<div className="alert alert-success text-sm">
						<span>{justIssued} is yours.</span>
					</div>
				)}

				<div className="flex items-center gap-2">
					<div className="badge badge-success">Issued</div>
					<span className="text-sm font-medium">@{handle}</span>
				</div>
				{user?.atprotoDid && <p className="text-xs text-base-content/50">DID: {user.atprotoDid}</p>}
				<p className="text-sm text-base-content/60">
					This is a name on the AT Protocol network, not just a name on Anthers. You can sign in
					with it, and anything published under it is addressed to you rather than to a row in
					Anthers' database.
				</p>
				<p className="text-sm text-base-content/60">
					Anthers runs the server it lives on and holds keys to it. That is what lets Anthers
					publish on your behalf.{" "}
					{holdsRecoveryKey
						? "Your own key ranks above both of them, so moving this identity is yours to do."
						: "Until you take a recovery key below, Anthers is the one who can move it."}
				</p>
			</div>
		</div>
	);
}

/**
 * Asking Anthers for a handle, for an account that does not have an identity yet.
 *
 * 🚨 **This is not a signup door.** It acts on an account that already exists and is signed in,
 * which is what makes it a different thing from `/subscribe` rather than a second copy of it —
 * and what enforces that is the session the route requires, not that this is buried in
 * settings. `/subscribe` remains the one place an account is minted.
 *
 * ⚠️ **The field and its verdict line are `lib/hosted-handle.ts`'s**, shared with the signup
 * card, so that "we could not check" cannot come to mean one thing here and another there.
 */
function AnthersHandleOffer({
	suffix,
	onIssued,
}: {
	suffix: string;
	onIssued: (handle: string) => void;
}) {
	const { refreshUser } = useAuth();
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const status = useHandleAvailability(name, { open: true, suffix });

	const ask = async (e: React.FormEvent) => {
		e.preventDefault();
		const asked = normalizeHandleName(name, suffix);
		if (!asked) return;
		setError(null);
		setBusy(true);
		try {
			const res = await client.api.atproto.handle.$post({ json: { name: asked } });
			const body = await res.json();
			if ("error" in body) {
				setError(body.error);
				setBusy(false);
				return;
			}
			// ⚠️ **The account is refreshed rather than this card reporting success itself.** What
			// replaces this form is the card drawn from the account, so anything shown here on the
			// strength of the response alone would be a second description of the same fact — and
			// the one that goes stale is always the one nothing else reads.
			onIssued(body.handle);
			await refreshUser();
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">An Anthers Handle</h3>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				<p className="text-sm text-base-content/60">
					Anthers can issue you a name on the AT Protocol network — a handle you sign in with, and
					an identity that is yours rather than a row in Anthers' database. Anthers runs the server
					it lives on and holds the keys to it.
				</p>
				<form onSubmit={ask} className="flex flex-col gap-2">
					<div className="flex items-center gap-2">
						<input
							type="text"
							className="input input-bordered flex-1"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="yourname"
							aria-label="The handle you'd like"
							aria-describedby="anthers-handle-status"
							autoComplete="off"
							spellCheck={false}
							autoCapitalize="none"
						/>
						<span aria-hidden="true" className="shrink-0 text-sm text-base-content/40">
							.{suffix || "anthers.social"}
						</span>
					</div>
					<p
						id="anthers-handle-status"
						aria-live="polite"
						className={`text-xs leading-snug ${handleStatusTone(status)}`}
					>
						{handleStatusLine(status)}
					</p>
					<button
						type="submit"
						className="btn btn-primary btn-sm w-fit"
						// Refused only for what is knowably wrong. A name we could not check still goes
						// through, because the node is the authority and a browser that could not ask
						// has learned nothing about the name.
						disabled={
							busy || !name.trim() || status.status === "invalid" || status.status === "taken"
						}
					>
						{busy ? "Asking…" : "Get this handle"}
					</button>
				</form>
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
	hostedHandles: string[];
}

interface DeletionState {
	scheduledFor: string | null;
	graceDays: number;
	preview: DeletionPreview;
}

/**
 * Your data — the export button and the deletion flow.
 *
 * 🚨 **This section is what makes two published sentences true.** Privacy Policy has said since it
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
 * destroyed, some tombstoned, some anonymized, and some kept with the person detached for
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
			// thing that ends up in shared screenshots and back-button history. Honor that
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
							Nothing has been deleted yet. Canceling puts everything back exactly as it was — there
							is no separate restore.
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
										{/*
										 * Named rather than counted, and last because it is the only line describing
										 * something Anthers cannot fully undo. Everything above is ours to destroy; an
										 * identity is a public record in a directory nobody can delete from, so the
										 * honest sentence says what goes, what is freed, and what stays.
										 */}
										{p.hostedHandles.length > 0 ? (
											<li>
												<strong>The handle Anthers issued you:</strong> {p.hostedHandles.join(", ")}{" "}
												— everything stored in it is deleted, your address comes off it, and the
												name is freed for somebody else. The identity behind the name is a public
												record that nothing can remove, so it stays, empty.
											</li>
										) : null}
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

			{/* The one setting that decides whether a person's name appears in public. */}
			<SupporterListingSection />

			{/* The account's identity on the network — issued here, or brought from elsewhere. */}
			<IdentitySection />

			{/* Signed-in devices — revocation for browsers and the desktop Studio. */}
			<DesktopHomeSection />

			<DevicesSection />

			{/* What the reader meets at each rung, and the door to the Adult rung. */}
			<MatureContentSection />

			{/* Directly under it, because the first thing the pin protects is the section
			    above — and a guardian who has just set those switches is exactly who wants
			    to lock them. */}
			<ParentalControlsSection />

			{/* Blocked accounts — the only place a block can be lifted, since a blocked
			    profile no longer resolves. */}
			<BlockedSection />

			{/* Export and deletion — the controls Privacy Policy and /parents describe. */}
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

/**
 * Whether this person is thanked by name on the public supporters page.
 *
 * ⭐ **Listed by default, and this is the control the promise points at** (Parker,
 * 2026-09-04). The wiki offers "a place on the supporters page, if you want one", and an
 * opt-out default keeps that promise only when the person was told at the moment they
 * started supporting *and* can find the switch afterwards. `/subscribe` does the telling;
 * this is the finding.
 *
 * ⚠️ **Renders nothing for somebody who has never supported.** A switch controlling whether
 * you appear on a page you cannot appear on is a setting that does nothing, and a settings
 * page full of those is how people stop reading them.
 */
function SupporterListingSection() {
	const [listed, setListed] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		apiFetch("/api/subscriptions/supporters/listing")
			.then(async (res) => {
				if (!res.ok) return;
				setListed(((await res.json()) as { listed: boolean }).listed);
			})
			.catch(() => {});
	}, []);

	if (listed === null) return null;

	async function change(next: boolean) {
		setSaving(true);
		const before = listed;
		setListed(next);
		try {
			const res = await apiFetch("/api/subscriptions/supporters/listing", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ listed: next }),
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			// A switch that stays where you put it without saving is worse than one that
			// snaps back, because it tells you a thing about your privacy that is not true.
			setListed(before);
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body">
				<div className="form-control">
					<label className="label cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={listed}
							onChange={(e) => change(e.target.checked)}
							disabled={saving}
						/>
						<div>
							<span className="label-text font-medium">List me on the supporters page</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Your name only — never what you gave. Turning this off takes you off{" "}
								<Link to="/supporters" className="link link-hover">
									the page
								</Link>{" "}
								and changes nothing else.
							</p>
						</div>
					</label>
				</div>
			</div>
		</div>
	);
}
