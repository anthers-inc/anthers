// SPDX-License-Identifier: Apache-2.0

import {
	currentCycleKey,
	cycleStart,
	daysInCycle,
	previousCycleKey,
} from "@anthers/shared/billing-cycle";
import {
	type ContentNote,
	MATURITY_DISPLAY_CHOICES,
	type MaturityDisplay,
	RATING_ROWS,
} from "@anthers/shared/content-rating";
import {
	BROWSER_RESERVED_CHORDS,
	canonicalChord,
	chordsCollide,
	DEFAULT_KEYBOARD_SHORTCUTS,
	formatChord,
	isPlayerShortcutAction,
	KEYBOARD_SHORTCUT_ACTIONS,
	type KeyboardShortcutAction,
	type KeyboardShortcuts,
	keyFromEvent,
	PAGE_SHORTCUT_ACTIONS,
	PLAYER_SHORTCUT_ACTIONS,
	resolveKeyboardShortcuts,
} from "@anthers/shared/keybindings";
import SignedInAccountCard from "@anthers/web-shared/account/SignedInAccountCard";
import { useAuth } from "@anthers/web-shared/auth";
import { useContentPreferences } from "@anthers/web-shared/content-preferences";
import {
	type DesktopHome,
	desktopHome,
	isDesktop,
	setDesktopHome,
} from "@anthers/web-shared/desktop";
import { profileUrl } from "@anthers/web-shared/profile";
import { usePublishingState } from "@anthers/web-shared/publishing";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiFetch, client } from "@anthers/web-shared/rpc";
import type { NotificationDeliveryMode } from "@anthers/web-shared/types";
import { CardElement, Elements, useElements, useStripe } from "@stripe/react-stripe-js";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	ResponsiveContainer,
	Tooltip,
	type TooltipContentProps,
	XAxis,
	YAxis,
} from "recharts";
import BadgesSection from "../components/account/BadgesSection";
import PurchasesSection from "../components/account/PurchasesSection";
import BlueskyMark from "../components/auth/BlueskyMark";
import BillingAddressSection from "../components/settings/BillingAddressSection";
import ParentalControlsSection from "../components/settings/ParentalControlsSection";
import { isApplePlatform } from "../lib/platform";
import { generateRecoveryKey, type RecoveryKeypair } from "../lib/recovery-key";
import { getStripe } from "../lib/stripe";
import { cardElementStyle } from "../lib/stripeCard";
import { studioUrl } from "../lib/studio";
import {
	setPreviewAudio,
	setPreviewsEnabled,
	usePreviewAudio,
	usePreviewsEnabled,
} from "../lib/tile-preview-settings";
import { DEFAULT_USER_TAB, USER_TABS, type UserTabId } from "../lib/user-tabs";

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
 * Where You Start — the tab a signed-in session opens on (Parker, 2026-10-20).
 *
 * The three tabs render in one fixed order, so this is the only control over where a
 * session lands: sign-in, a fresh tab on `/`, and the mode switch's User side all read
 * the same answer. Account-level rather than per-browser for the reason the theme is —
 * which tab a person arrives on is how they use the site, not a property of a computer.
 *
 * Null = never answered, and the client reads that as Network; the column never bakes
 * the default in, so a later default change needs no rows rewritten.
 */
function StartingTabSection() {
	const { user, refreshUser } = useAuth();
	const current: UserTabId = user?.homeDefaultTab ?? DEFAULT_USER_TAB;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choose = async (tab: UserTabId) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ homeDefaultTab: tab }),
			});
			if (!res.ok) throw new Error();
			await refreshUser();
		} catch {
			setError("That preference couldn't be saved.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Where You Start</h3>
				<p className="text-sm text-base-content/60">
					The tab a session opens on, whether you have just signed in or come back the next day.
					It's saved to your account, so every device starts in the same place.
				</p>

				<fieldset className="form-control mt-2 gap-2">
					<legend className="sr-only">Starting tab</legend>
					{USER_TABS.map((tab) => (
						<label
							key={tab.id}
							className="label whitespace-normal cursor-pointer justify-start gap-3 py-1"
						>
							<input
								type="radio"
								name="home-default-tab"
								className="radio radio-sm"
								checked={current === tab.id}
								onChange={() => choose(tab.id)}
								disabled={busy}
							/>
							<span className="label-text">
								<span className="font-medium">{tab.label}</span>
								<span className="block text-xs text-base-content/50">{tab.blurb}</span>
							</span>
						</label>
					))}
				</fieldset>
				{error && <p className="text-xs text-error mt-1">{error}</p>}
			</div>
		</div>
	);
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
				<h3 className="card-title text-lg">When Anthers Opens</h3>
				<p className="text-sm text-base-content/60">
					Where the app starts. This is set per computer, so you can read here and author somewhere
					else.
				</p>

				<div className="form-control mt-2 gap-2">
					<label className="label whitespace-normal cursor-pointer justify-start gap-3 py-1">
						<input
							type="radio"
							name="desktop-home"
							className="radio radio-sm"
							checked={home === "user"}
							onChange={() => choose("user")}
						/>
						<span className="label-text">
							<span className="font-medium">Your tabs</span>
							<span className="block text-xs text-base-content/50">
								Your Library, Network or Discovery, starting with the one you chose in Settings
							</span>
						</span>
					</label>
					<label className="label whitespace-normal cursor-pointer justify-start gap-3 py-1">
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
 * Media & Play — the per-install playback preferences (Parker, 2026-10-15).
 *
 * These are browser settings rather than account settings: a preference about how
 * *this* browser behaves while browsing, remembered in `localStorage` beside the
 * desktop home and the media volume, which is why the copy says so. New feed and
 * playback preferences join this card rather than growing new ones.
 */
function MediaPlaySection() {
	const previewsEnabled = usePreviewsEnabled();
	const previewAudio = usePreviewAudio();

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Media &amp; Play</h3>
				<p className="text-sm text-base-content/60">
					How playback behaves while you browse. These are remembered in this browser.
				</p>

				<div className="form-control mt-2">
					{/* The stop *Network* commits every feed signal to: previews are the
					    cursor's doing, and they stay that way by being stoppable. Turning this
					    off mid-hover stops the playing preview on the same render. */}
					<label className="label whitespace-normal cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={previewsEnabled}
							onChange={(e) => setPreviewsEnabled(e.target.checked)}
						/>
						<div>
							<span className="label-text font-medium">Play previews as I browse</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Holding the cursor on a feed tile plays the work inside its thumbnail, one tile at a
								time. Turning this off keeps every tile on its poster, and tiles you can still open
								keep their play affordance.
							</p>
						</div>
					</label>
				</div>

				<div className="form-control mt-2">
					{/* The same remembered answer the preview's speaker button flips: sound is
					    the viewer's gesture, never the hover's, so it defaults off and follows
					    the media volume the rest of the players share. */}
					<label className="label whitespace-normal cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={previewAudio}
							onChange={(e) => setPreviewAudio(e.target.checked)}
						/>
						<div>
							<span className="label-text font-medium">Play audio on hover previews</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Hovered previews are silent by default. Turning this on plays them with sound at the
								volume the site's players share, and the speaker button on a preview flips this same
								setting.
							</p>
						</div>
					</label>
				</div>
			</div>
		</div>
	);
}

/**
 * Persistent Miniplayer — an account-level playback preference (Parker, 2026-10-16),
 * unlike the Media & Play card above, which remembers per-browser.
 *
 * Whether pressing play on an audio Work hands playback to the persistent footer bar,
 * which survives navigation, instead of leaving it in the Work page's own player, which
 * dies on it. Account-level on purpose: where a person's playback lives is *how they
 * listen*, so it follows the account beside the theme and the nav order rather than this
 * browser — an embedded frame has no bar, and the Studio preview stays inline regardless.
 */
function MiniPlayerSection() {
	const { user, refreshUser } = useAuth();
	// Null = never answered and means on; the column never bakes the default in.
	const current = user?.persistentMiniplayer ?? true;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const choose = async (on: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ persistentMiniplayer: on }),
			});
			if (!res.ok) throw new Error();
			await refreshUser();
		} catch {
			setError("That preference couldn't be saved.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">The Miniplayer</h3>
				<p className="text-sm text-base-content/60">
					Where audio plays while you browse. This one is saved to your account, so it follows you
					to another device.
				</p>

				<div className="form-control mt-2">
					<label className="label whitespace-normal cursor-pointer justify-start gap-3">
						<input
							type="checkbox"
							className="toggle toggle-primary"
							checked={current}
							onChange={(e) => choose(e.target.checked)}
							disabled={busy}
						/>
						<div>
							<span className="label-text font-medium">Use the persistent miniplayer</span>
							<p className="text-xs text-base-content/50 mt-0.5">
								Audio you play lives in the bar at the foot of the page and keeps playing while you
								browse. Turning this off plays each Work inside its own page, which stops when you
								navigate away.
							</p>
							{error && <p className="text-xs text-error mt-1">{error}</p>}
						</div>
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
	handle: string;
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
 * What the user meets at each rung, and the door to the Adult rung.
 *
 * 🚨 **The two rungs get separate controls, and that separation is the design rather than
 * layout.** A user who wants difficult work unblurred has said nothing about whether they
 * want explicit work at all, and one control covering both would make them say it (wiki
 * The wiki's *Content Standards*).
 *
 * **Each kind of content gets a control too, whatever the rating** (Parker, 2026-09-18), for a
 * user who does not mind rated work but wants to avoid one thing. Show by default, because a note
 * may drive a user's own filter and never a platform default. A guardian's lock covers these
 * with the rungs, since they are written by the same writer.
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

	const setDisplay = async (
		change:
			| { mature: MaturityDisplay }
			| { adult: MaturityDisplay }
			| { notes: Partial<Record<ContentNote, MaturityDisplay>> },
	) => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/content-preferences", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(change),
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

	const displayControl = (
		name: string,
		current: MaturityDisplay,
		choose: (value: MaturityDisplay) => void,
	) => (
		<fieldset className="join" aria-label={name}>
			{MATURITY_DISPLAY_CHOICES.map((choice) => (
				<button
					key={choice.value}
					type="button"
					className={`btn btn-sm join-item ${current === choice.value ? "btn-primary" : "btn-outline"}`}
					aria-pressed={current === choice.value}
					disabled={busy}
					title={choice.hint}
					onClick={() => choose(choice.value)}
				>
					{choice.label}
				</button>
			))}
		</fieldset>
	);
	const rungControl = (rung: "mature" | "adult", current: MaturityDisplay) =>
		displayControl(rung === "mature" ? "Mature" : "Adult", current, (value) =>
			setDisplay(rung === "mature" ? { mature: value } : { adult: value }),
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
							Work made for adults — violence, sex or difficult subjects shown or described rather
							than implied, and writing, music or audio its creator labels explicit. Covered by
							default.
						</p>
					</div>
					{rungControl("mature", prefs.mature)}
				</div>

				<div className="border-t border-base-300 pt-4">
					<p className="font-medium text-sm">Adult</p>
					<p className="text-xs text-base-content/60">
						Explicit sexual content, or, in visual work such as video and games, extreme violence or
						drug use that is the work's focus. You will not see it anywhere on Anthers unless you
						turn this on. Creators set their own price for it, or leave it free, exactly as they
						would for anything else.
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

				<div className="border-t border-base-300 pt-4">
					<p className="font-medium text-sm">Kinds of Content</p>
					<p className="text-xs text-base-content/60">
						Hide or blur work that contains any of these, whatever it's rated. Creators mark each
						one for every Work, and work counts as containing it unless its creator marked it Not in
						It.
					</p>
					<div className="mt-3 flex flex-col gap-2">
						{RATING_ROWS.map((row) => (
							<div key={row.note} className="flex flex-wrap items-center justify-between gap-3">
								<span className="text-sm">{row.label}</span>
								{displayControl(row.label, prefs.notes[row.note], (value) =>
									setDisplay({ notes: { [row.note]: value } }),
								)}
							</div>
						))}
					</div>
				</div>

				{error && <p className="text-sm text-error">{error}</p>}
			</div>
		</div>
	);
}

/**
 * Blocked Accounts — and the only place a block can be lifted.
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
			const res = await apiFetch(`/api/accounts/users/${u.handle}/unblock`, { method: "POST" });
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
				<h3 className="card-title text-lg">Blocked Accounts</h3>
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
									<div className="font-medium truncate">{b.displayName || b.handle}</div>
									<div className="text-xs text-base-content/50 truncate">
										@{b.handle} · blocked {formatWhen(b.createdAt)}
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
 * 🚨 **Every account holds exactly one identity, the one it was created with**, so there are two
 * states and neither offers a second: a handle Anthers issued, or an identity the person brought
 * from another server. Swapping one for the other is not built, and nothing here implies it is.
 *
 * ⚠️ **Whether an identity is Anthers-issued is derived from the publishing route first and the
 * handle suffix second.** `GET /api/atproto/publishing` answers `hosted` from `hosted_accounts`,
 * which is the server's own answer and stays right for a hosted identity that has taken a domain
 * of its own; `/api/atproto/config` reports the suffix only Anthers issues beneath, so it is the
 * fallback while that answer is in flight. The server does not trust either derivation — the
 * recovery-key and domain routes ask `hosted_accounts` directly — so the worst a wrong answer here
 * can do is show a card whose button then refuses.
 */
function IdentitySection() {
	const { user } = useAuth();
	const [suffix, setSuffix] = useState<string | null>(null);
	const [recovery, setRecovery] = useState<RecoveryKeyState | null>(null);
	const publishing = usePublishingState({ enabled: user != null });

	useEffect(() => {
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then(({ hostedHandleSuffix }) => {
				if (live) setSuffix(hostedHandleSuffix);
			})
			.catch(() => {
				/* Unreachable API: the handle still shows, without the cards only a hosted one gets. */
				if (live) setSuffix("");
			});
		return () => {
			live = false;
		};
	}, []);

	useEffect(() => {
		if (!user) return;
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
	}, [user]);

	// ⚠️ Waits for the suffix rather than guessing, so a hosted identity is never shown for a frame
	// as one somebody brought, or the reverse. The publishing route, once it answers, outranks the
	// suffix — see this component's note.
	if (!user || suffix === null) return null;
	const handle = user.handle;
	const hosted = publishing
		? publishing.route === "hosted"
		: !!suffix && handle.endsWith(`.${suffix}`);

	if (!hosted) {
		return (
			<>
				<BroughtIdentityCard handle={handle} did={user.atprotoDid} />
				<IdentityServerCard hosted={false} />
				<ConnectedAppsCard />
			</>
		);
	}
	return (
		<>
			<AnthersHandleCard handle={handle} holdsRecoveryKey={!!recovery?.didKey} />
			{/* ⚠️ Waits for the answer rather than rendering the offer meanwhile. Somebody who
			    already holds a key would otherwise be offered another one for the frame between
			    the page loading and the API answering. */}
			{recovery && <RecoveryKeyCard state={recovery} onSeated={setRecovery} />}
			<DomainHandleCard handle={handle} did={user.atprotoDid} />
			<IdentityServerCard hosted />
		</>
	);
}

/**
 * The server holding this identity, and the account page it keeps for its holder.
 *
 * ⭐ **The page belongs to the server, not to Anthers**, and pointing at it is what the reference
 * PDS's account page made possible: a person manages their identity where it lives instead of in
 * whichever app they happen to use, or in the Bluesky app that used to be the only alternative.
 *
 * 🚨 **A hosted identity gets no link, and the copy says why.** The password on an account
 * Anthers issues is generated for the hub and never given out (`hosted-accounts.ts`), so the page
 * has no way in for the person holding the identity, and changing that password through it would
 * leave the hub's sealed credential stale and stop their records publishing. Anthers' own
 * controls are on this tab.
 *
 * ⚠️ **The link appears only when the server answers that the page exists.** `pds-health.ts`
 * asks `/account` and remembers the answer per origin, because a link is a claim that there is
 * a page, and a server still on an older release has none.
 */
function IdentityServerCard({ hosted }: { hosted: boolean }) {
	const { user } = useAuth();
	const state = usePublishingState({ enabled: !hosted && user != null });

	let host = "";
	let accountUrl = "";
	try {
		const server = new URL(user?.atprotoPdsUrl ?? "");
		host = server.hostname;
		accountUrl = `${server.origin}/account`;
	} catch {
		return null;
	}

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Your Identity Server</h3>

				{hosted ? (
					<p className="text-sm text-base-content/60">
						Your identity lives on {host}, the server Anthers runs. The password on your account was
						generated for Anthers and never given out, so there is no password for you to change,
						and a change would stop the records Anthers writes for you from reaching the network.
					</p>
				) : (
					<>
						<p className="text-sm text-base-content/60">
							Your identity lives on {host}, which Anthers doesn't run.
						</p>
						{state?.server?.accountPage && (
							<>
								<p className="text-sm text-base-content/60">
									That server keeps an account page of its own, where you change the password on the
									identity, see the devices signed in to it, and revoke any app with access to it.
								</p>
								<a className="btn btn-sm w-fit" href={accountUrl} target="_blank" rel="noreferrer">
									Open {host}/account
								</a>
							</>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * The one app Anthers can honestly list for an identity it does not host: itself.
 *
 * 🚨 **The server keeps the authoritative list, and this card is not a second one.** Anthers
 * knows only the grant it holds, so the copy says that, rather than implying the card is
 * everything connected. The identity server's own page is where the full list lives.
 *
 * ⭐ **Disconnecting is the real name for what the route does.** `stopPublishingFor` takes the
 * Works, posts and projects Anthers published out of the repository *before* it revokes, because
 * deleting a record needs the permission being returned, and revoking an OAuth session ends every
 * write rather than only publishing. So the confirm says both halves: the listings go, and so
 * does the permission to write comments, reviews, votes and follows until it is given again.
 *
 * ⚠️ **A hosted identity sees no card.** `hosted_accounts` answers that in `route`, and there is
 * no OAuth client to revoke when the hub holds the account's own keys; the identity server card
 * carries that explanation instead.
 */
function ConnectedAppsCard() {
	const { user, grantPublishing } = useAuth();
	const state = usePublishingState({ enabled: user != null });
	const [disconnected, setDisconnected] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (!user || !state || state.route === "hosted") return null;

	// A revoked session ends every write, so the local answer outranks the state read a moment
	// before the revocation. The next load asks the server and agrees.
	const writing = disconnected ? "ungranted" : state.interactions;
	const publishing = disconnected ? "ungranted" : state.route;

	const disconnect = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/atproto/publishing/stop", { method: "POST" });
			const body = (await res.json().catch(() => null)) as { error?: string } | null;
			if (!res.ok) throw new Error(body?.error ?? "That couldn't be done. Try again.");
			setDisconnected(true);
			setConfirming(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "That couldn't be done. Try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Connected Apps</h3>
				<p className="text-sm text-base-content/60">
					Anthers asks for what it needs once, when your identity is connected. The server holding
					the identity keeps the full list of apps, and this is the one Anthers holds.
				</p>

				{error && (
					<div className="alert alert-error text-sm mt-2">
						<span>{error}</span>
					</div>
				)}

				<ul className="mt-2 divide-y divide-base-300">
					<li className="py-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">Anthers</span>
							<span
								className={`badge badge-sm ${writing === "granted" ? "badge-success" : "badge-error"}`}
							>
								{writing === "granted" ? "Writing" : "No access"}
							</span>
							{publishing === "granted" && (
								<span className="badge badge-sm badge-success">Publishing</span>
							)}
						</div>
						<p className="mt-1 text-xs text-base-content/50">
							{writing === "granted"
								? "Writes your comments, reviews, votes and follows, and accepts credits you're offered."
								: "Anthers can't write your comments, reviews, votes or follows. Signing in with this identity again asks for the permission back."}
						</p>
						<p className="text-xs text-base-content/50">
							{publishing === "granted"
								? "Publishes your Works, posts and projects into your identity."
								: user.isCreator
									? "Anthers has no permission to publish for you."
									: "Publishing is asked for when creator mode is turned on."}
						</p>
					</li>
				</ul>

				{confirming ? (
					<div className="mt-3 rounded-box border border-warning/40 bg-warning/10 p-3">
						<p className="text-sm">
							Anthers will take down the Works, posts and projects it published for you and give its
							permission to write to your identity back. Comments, reviews, votes and follows you
							made stay in your repository, and nothing in your Anthers account is deleted.
						</p>
						<p className="mt-2 text-xs text-base-content/60">
							You can give the permission again whenever you want.
						</p>
						<div className="mt-3 flex flex-wrap gap-2">
							<button
								type="button"
								className="btn btn-sm btn-warning"
								onClick={() => void disconnect()}
								disabled={busy}
							>
								{busy ? "Disconnecting…" : "Disconnect Anthers"}
							</button>
							<button
								type="button"
								className="btn btn-sm btn-ghost"
								onClick={() => setConfirming(false)}
								disabled={busy}
							>
								Cancel
							</button>
						</div>
					</div>
				) : (
					<div className="mt-3 flex flex-wrap items-center gap-3">
						{publishing === "granted" && (
							<button
								type="button"
								className="btn btn-sm btn-outline w-fit"
								onClick={() => setConfirming(true)}
							>
								Disconnect Anthers
							</button>
						)}
						{publishing === "ungranted" && user.isCreator && state.offered && (
							<button
								type="button"
								className="btn btn-sm btn-primary w-fit"
								onClick={() => void grantPublishing()}
							>
								Give Anthers permission
							</button>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Pointing an issued identity at a domain the account holder owns.
 *
 * ⭐ **The instructions come before the field, because that is the order the work happens in.**
 * Nothing can succeed until a DNS record or a well-known file is already published, so a card
 * that led with an input would be asking for something the person cannot yet give. The DID they
 * need is already in the browser, so it is shown up front rather than fetched.
 *
 * ⚠️ **Failing to verify is the ORDINARY outcome and is not an error.** DNS takes time to
 * propagate, so most first attempts do not resolve and the person has done nothing wrong. That
 * comes back as its own state with a *check again*, never as a refusal — a flow that apologized
 * here would be wrong most of the times anybody used it.
 *
 * 🚨 **The node does the verifying, not this page and not the hub.** `updateHandle` refuses a
 * domain that does not already resolve to the DID, which is what makes it impossible for this
 * to leave somebody's identity claiming a name it cannot prove.
 */
function DomainHandleCard({ handle, did }: { handle: string; did: string }) {
	const { refreshUser } = useAuth();
	const [domain, setDomain] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [unproven, setUnproven] = useState(false);
	const [open, setOpen] = useState(false);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		setBusy(true);
		try {
			const res = await client.api.atproto.handle.domain.$post({ json: { handle: domain } });
			const body = await res.json();
			if ("error" in body) {
				setError(body.error);
				setUnproven(false);
				return;
			}
			if (body.status === "unproven") {
				setUnproven(true);
				return;
			}
			setUnproven(false);
			await refreshUser();
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Use a Domain You Own</h3>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				<p className="text-sm text-base-content/60">
					Your handle is <span className="font-medium">@{handle}</span>. You can replace it with a
					domain you own, and your identity, your work and the people following you all come with it
					— a handle is a label, and none of them are keyed on it.
				</p>

				{!open ? (
					<button type="button" className="btn btn-sm w-fit" onClick={() => setOpen(true)}>
						Use my own domain
					</button>
				) : (
					<>
						<p className="text-sm text-base-content/60">
							First, prove the domain is yours by publishing <strong>either</strong> of these. Both
							say the same thing; use whichever your host makes easier.
						</p>
						<ul className="ml-4 list-disc text-sm text-base-content/60">
							<li>
								A DNS <code>TXT</code> record at <code>_atproto.yourdomain.com</code> whose value is{" "}
								<code className="break-all">did={did}</code>
							</li>
							<li>
								A file at{" "}
								<code className="break-all">https://yourdomain.com/.well-known/atproto-did</code>{" "}
								containing <code className="break-all">{did}</code> and nothing else
							</li>
						</ul>

						{/* ⚠️ Not an error state. A DNS record that has not propagated is the normal first
						    answer, so this reads as "not yet" and offers the same button again. */}
						{unproven && (
							<div className="alert alert-info text-sm">
								<span>
									Anthers can't see that yet. DNS changes often take a while to spread — leave it a
									few minutes and check again. Nothing has changed in the meantime.
								</span>
							</div>
						)}

						<form onSubmit={submit} className="flex flex-wrap items-center gap-2">
							<input
								type="text"
								className="input input-bordered flex-1 min-w-48"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
								placeholder="yourdomain.com"
								aria-label="The domain you own"
								autoComplete="off"
								spellCheck={false}
								autoCapitalize="none"
							/>
							<button
								type="submit"
								className="btn btn-primary btn-sm"
								disabled={busy || !domain.trim()}
							>
								{busy ? "Checking…" : unproven ? "Check again" : "Use this domain"}
							</button>
						</form>

						<p className="text-xs text-base-content/50">
							The {handle.split(".").slice(1).join(".")} name you have now goes back to being
							available for somebody else, the same as it would if you closed your account.
						</p>
					</>
				)}
			</div>
		</div>
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

						<label className="label whitespace-normal cursor-pointer justify-start gap-3 py-0">
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
 * Deleting the account is what releases this identity, and there is no other way to part with
 * it: it lives on Anthers' own node and the hub holds the only password to it.
 */
function AnthersHandleCard({
	handle,
	holdsRecoveryKey,
}: {
	handle: string;
	holdsRecoveryKey: boolean;
}) {
	const { user } = useAuth();
	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">Your Anthers Handle</h3>

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
 * The identity an account was created with, when it lives on a server other than Anthers'.
 *
 * ⚠️ **Nothing to do here, and that is accurate rather than unfinished.** The account signs in
 * with this identity and holds no other; there is no unlink because an account cannot exist
 * without its identity, and swapping it for another is not built.
 *
 * ⚠️ **The copy is easy to overclaim.** It names the identity and what it is for, and says
 * nothing about what Anthers publishes into it — that is the Studio's publishing card, and
 * `RETIRED_COPY` exists because that framing has drifted onto pages it did not belong on before.
 */
function BroughtIdentityCard({ handle, did }: { handle: string; did: string }) {
	return (
		<div className="card bg-base-200">
			<div className="card-body">
				<h3 className="card-title text-lg">
					<BlueskyMark />
					Your Identity
				</h3>
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium">
						{handle ? `@${handle}` : "handle unavailable"}
					</span>
				</div>
				<p className="text-xs text-base-content/50">DID: {did}</p>
				<p className="text-sm text-base-content/60">
					Your Anthers account is built on this identity, and it is how you sign in. It lives on
					your own server rather than on Anthers', so it carries on existing whatever happens to
					your Anthers account.
				</p>
			</div>
		</div>
	);
}

interface DeletionPreview {
	follows: number;
	savedItems: number;
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
	exportedAt: string | null;
	hasRecentExport: boolean;
	spaces: number;
}

interface ActivityEntry {
	id: number;
	creatorId: number;
	workId: number | null;
	eventType: string;
	durationSeconds: number;
	startedAt: string | null;
	endedAt: string | null;
	tabVisible: boolean | null;
	elementVisible: boolean | null;
	playing: boolean | null;
	surface: string | null;
	device: string | null;
	workTitle: string | null;
	url: string | null;
}

/**
 * Activity history — a person's own attention ranges, exactly as recorded.
 *
 * This is the answer the Privacy Policy points at: the record of what was watched is
 * not a hidden analytics byproduct, it is the user's own file, and they can read
 * every row of it here. Nothing about the rows is computed for display — what is
 * stored is what is shown, evidence included, which is what makes the record inspectable
 * rather than a summary somebody chose to write.
 *
 * Above that record sits a picture, and the difference between the two is the section's
 * whole design (Parker, 2026-10-13, after the treatments in the Anthers vault's
 * `Internal Wiki/Transient/Activity Graph Mocks 20261013.html`, recorded in the task note
 * that carried the work):
 * a stacked bar per UTC day of a **billing cycle** — defaulting to the current one, the same
 * key `settle-cycle` settles on — with each day's stored ranges added up **per creator, in
 * full**. The picture is computed for display and says so; the drill-down it opens is not
 * computed at all. Two rules keep the picture honest:
 *
 * - **A range counts toward the creator it touched, whole.** Where two ranges overlapped,
 *   the even split between them is a payment calculation, not what happened — a video and
 *   an article at once both happened fully — so the split appears nowhere in the history,
 *   and a day's bars may sum to more than elapsed wall-clock time. The rows the bar opens
 *   are the evidence, whole.
 * - **The UTC day is the bucket, because the cycle is.** The month every account renews on
 *   is keyed in UTC (`@anthers/shared/billing-cycle`), so the picture buckets the same way;
 *   a range belongs to the day it started.
 *
 * The entries are ranges, and each one says so: when it started, when it ended,
 * whether the Work was playing, and which device it came from. Where two ranges
 * overlap (a video in one tab and an article in another), both are listed whole —
 * the even split between them is a payment calculation, not what happened, and a
 * history that showed only the split would be narrating the ledger rather than
 * the activity.
 */
/** The computed picture's shape, from `/attention/history/summary`. */
interface ActivitySummaryDay {
	day: string;
	seconds: number;
	ranges: number;
	creators: { creatorId: number; name: string; seconds: number; ranges: number }[];
}
interface ActivitySummary {
	cycle: string;
	days: ActivitySummaryDay[];
	totals: { seconds: number; creators: number };
}

/** One hue per creator, cycled by the creator's rank in the period; the palette sits inside both themes. */
const CREATOR_COLORS = [
	"var(--color-primary)",
	"var(--color-accent)",
	"oklch(76% 0.11 300)",
	"oklch(70% 0.09 235)",
	"var(--color-secondary)",
	"oklch(78% 0.09 130)",
	"oklch(80% 0.08 30)",
	"oklch(56% 0.05 260)",
];

/** Seconds to the short form the section's copy uses — whole ranges added, never the split. */
function fmtMinutes(seconds: number): string {
	const m = Math.round(seconds / 60);
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	return m % 60 === 0 ? `${h} hr` : `${h} hr ${m % 60} min`;
}

/** How many bars get their own hue before the remainder folds into one "Other creators" slice. */
const MAX_CREATOR_BARS = 8;

function ActivityHistorySection() {
	const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [page, setPage] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const [loading, setLoading] = useState(false);
	// The picture's span — the billing cycle it draws — and, when a bar is open, the
	// day the record below is narrowed to. The record with no day open is the whole
	// record, exactly as the section has always read it.
	const [cycle, setCycle] = useState(currentCycleKey);
	const [summary, setSummary] = useState<ActivitySummary | null>(null);
	const [summaryError, setSummaryError] = useState<boolean>(false);
	const [openDay, setOpenDay] = useState<string | null>(null);

	const load = (p: number, day: string | null) => {
		setLoading(true);
		setError(null);
		apiFetch(`/api/subscriptions/attention/history?page=${p}${day ? `&day=${day}` : ""}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load your activity."))))
			.then((d) => {
				const body = d as { entries: ActivityEntry[]; hasMore: boolean };
				setEntries((prev) => (p === 0 ? body.entries : [...(prev ?? []), ...body.entries]));
				setHasMore(body.hasMore);
				setPage(p);
			})
			.catch((e) => setError(e instanceof Error ? e.message : "Could not load your activity."))
			.finally(() => setLoading(false));
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: load-and-append on mount only; `load` closes over `page`, which the Load More path passes explicitly.
	useEffect(() => load(0, null), []);

	// The summary rides its own endpoint, is computed fresh per cycle, and failing it
	// costs only the picture: the record below is the section, not the graph.
	useEffect(() => {
		setSummary(null);
		let alive = true;
		apiFetch(`/api/subscriptions/attention/history/summary?cycle=${encodeURIComponent(cycle)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad summary"))))
			.then((d) => {
				if (alive) setSummary(d as ActivitySummary);
			})
			.catch(() => {
				if (alive) setSummaryError(true);
			});
		return () => {
			alive = false;
		};
	}, [cycle]);

	const verbFor = (eventType: string) =>
		eventType === "watch"
			? "Watched"
			: eventType === "listen"
				? "Listened to"
				: eventType === "read"
					? "Read"
					: eventType === "play"
						? "Played"
						: "Visited";

	const describeEvidence = (e: ActivityEntry): string => {
		const bits: string[] = [];
		if (e.device) bits.push(e.device === "desktop-shell" ? "desktop app" : e.device);
		if (e.playing === false) bits.push("paused");
		if (e.tabVisible === false) bits.push("in the background");
		return bits.length > 0 ? ` (${bits.join(", ")})` : "";
	};

	// The bars: every day of the cycle in order, gaps included, each day's ranges
	// stacked by creator. The top creators by period total get their own hue and the
	// remainder folds into one slice — a legend never needs a screen of its own.
	const chart = useMemo(() => {
		if (!summary) return null;
		const perCreator = new Map<number, { name: string; seconds: number }>();
		for (const d of summary.days) {
			for (const cr of d.creators) {
				const cur = perCreator.get(cr.creatorId);
				if (cur) cur.seconds += cr.seconds;
				else perCreator.set(cr.creatorId, { name: cr.name, seconds: cr.seconds });
			}
		}
		const ranked = [...perCreator.entries()]
			.sort((a, b) => b[1].seconds - a[1].seconds)
			.slice(0, MAX_CREATOR_BARS);
		const otherSeconds = summary.totals.seconds - ranked.reduce((s, [, cr]) => s + cr.seconds, 0);
		const bars = ranked.map(([id, cr], i) => ({
			key: `c${id}`,
			name: cr.name,
			color: CREATOR_COLORS[i % CREATOR_COLORS.length],
		}));
		if (otherSeconds > 0)
			bars.push({
				key: "kother",
				name: "Other creators",
				color: "color-mix(in oklch, var(--color-base-content) 40%, transparent)",
			});

		const start = cycleStart(cycle);
		const data = [];
		for (let i = 0; i < daysInCycle(cycle); i++) {
			const key = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10);
			const day = summary.days.find((d) => d.day === key);
			// Flat: a bar's dataKey reads `datum[bar.key]` (recharts reads top-level
			// keys only); each bar's range count rides beside it in `q`.
			const q: Record<string, number> = {};
			const datum: {
				dayNum: number;
				day: string;
				seconds: number;
				ranges: number;
				q: Record<string, number>;
				[key: string]: unknown;
			} = {
				dayNum: i + 1,
				day: key,
				seconds: day?.seconds ?? 0,
				ranges: day?.ranges ?? 0,
				q,
			};
			for (const cr of day?.creators ?? []) {
				const bar = bars.find((b) => b.key === `c${cr.creatorId}`);
				const target = bar ? bar.key : "kother";
				datum[target] = ((datum[target] as number | undefined) ?? 0) + cr.seconds;
				q[target] = (q[target] ?? 0) + cr.ranges;
			}
			data.push(datum);
		}
		const byDayNum = new Map(data.map((d) => [d.dayNum, d]));
		return { data, bars, byDayNum };
	}, [cycle, summary]);

	const openChartDay = (label: unknown) => {
		// The axis label arrives as the tick's value — number or its string form.
		const dayNum =
			typeof label === "number" ? label : typeof label === "string" ? Number(label) : NaN;
		if (!Number.isInteger(dayNum)) return;
		const datum = chart?.byDayNum.get(dayNum);
		if (!datum || datum.ranges === 0) return;
		const day = datum.day;
		const next = openDay === day ? null : day;
		setOpenDay(next);
		load(0, next);
	};

	// A span change re-points the picture and releases an open day: the record below
	// reads whole again, since the day it was narrowed to belongs to the other period.
	const changeSpan = (next: string) => {
		setCycle(next);
		setOpenDay(null);
		load(0, null);
	};

	const chartTooltip = useMemo(
		() =>
			function ChartTip({ active, label }: TooltipContentProps) {
				if (!active || !chart || typeof label !== "number") return null;
				const datum = chart.byDayNum.get(label);
				if (!datum) return null;
				return (
					<div className="rounded-lg border border-base-content/30 bg-base-300 px-3 py-2 text-xs shadow-lg">
						<p className="font-semibold">
							{datum.ranges === 0
								? "Nothing recorded"
								: `${fmtMinutes(datum.seconds)} across ${datum.ranges} range${datum.ranges === 1 ? "" : "s"}`}
						</p>
						<ul className="mt-1 space-y-0.5">
							{chart.bars
								.filter((b) => ((datum[b.key] as number | undefined) ?? 0) > 0)
								.map((b) => (
									<li key={b.key}>
										<span
											aria-hidden="true"
											style={{
												display: "inline-block",
												width: 8,
												height: 8,
												borderRadius: 2,
												background: b.color,
												marginRight: 4,
											}}
										/>
										{b.name} — {fmtMinutes(datum[b.key] as number)} · {datum.q[b.key]} range
										{datum.q[b.key] === 1 ? "" : "s"}
									</li>
								))}
						</ul>
						{datum.ranges > 0 && (
							<p className="mt-1 text-base-content/50">click to open this day’s record</p>
						)}
					</div>
				);
			},
		[chart],
	);

	const cycleLabel = (() => {
		const m = Number(cycle.slice(5, 7));
		const months = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];
		return `${months[m - 1]} ${cycle.slice(0, 4)}`;
	})();
	// "Previous" always means the cycle before *now*, however far back a span has been
	// opened — it is a fixed month's name, never a relative step that drifts.
	const prevCycleLabel = (() => {
		const prev = previousCycleKey(currentCycleKey());
		const months = [
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		];
		return `${months[Number(prev.slice(5, 7)) - 1]} ${prev.slice(0, 4)}`;
	})();
	const openDayLabel = openDay
		? (() => {
				const months = [
					"January",
					"February",
					"March",
					"April",
					"May",
					"June",
					"July",
					"August",
					"September",
					"October",
					"November",
					"December",
				];
				return `${months[Number(openDay.slice(5, 7)) - 1]} ${Number(openDay.slice(8, 10))}`;
			})()
		: null;

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Your Activity History</h3>
				<p className="text-sm text-base-content/60">
					Every stretch of time Anthers holds about what you watched, read, heard or played —
					exactly as it is stored. This record is also what the Time Pool divides by and what your
					export contains. Above it, the month is drawn as a picture: computed for display, the same
					credited time the meter spends and the pool pays, split evenly where stretches overlapped,
					added per day and per creator. The record below is the storage itself — open any bar to
					read the ranges its bar stands on.
				</p>

				{summaryError && (
					<p className="text-sm text-base-content/50">
						The month's picture could not load; the record below is unaffected.
					</p>
				)}
				{!summaryError && chart && summary && summary.days.length > 0 && (
					<div
						className="mt-2"
						role="img"
						aria-label={`${cycleLabel}: time per day per creator, computed from your stored activity record`}
					>
						<div className="flex flex-wrap items-baseline justify-between gap-2">
							<p className="text-sm font-semibold">
								{cycleLabel} — {fmtMinutes(summary.totals.seconds)}
							</p>
							<p className="text-xs text-base-content/50">
								computed for display — minutes per UTC day of the billing cycle, from the record
								below
							</p>
						</div>
						<div className="join mt-2">
							<button
								type="button"
								className={`btn btn-xs join-item ${cycle === currentCycleKey() ? "btn-primary" : ""}`}
								onClick={() => changeSpan(currentCycleKey())}
							>
								This billing period
							</button>
							<button
								type="button"
								className={`btn btn-xs join-item ${cycle !== currentCycleKey() ? "btn-primary" : ""}`}
								onClick={() => changeSpan(previousCycleKey(currentCycleKey()))}
							>
								{prevCycleLabel}
							</button>
						</div>
						<div className="mt-3">
							<ResponsiveContainer width="100%" height={190}>
								<BarChart
									data={chart.data}
									margin={{ top: 4, right: 8, bottom: 0, left: 8 }}
									onClick={(state) => openChartDay(state.activeLabel)}
								>
									<CartesianGrid
										stroke="color-mix(in oklch, var(--color-base-content) 12%, transparent)"
										vertical={false}
									/>
									<XAxis
										dataKey="dayNum"
										tickLine={false}
										axisLine={{
											stroke: "color-mix(in oklch, var(--color-base-content) 20%, transparent)",
										}}
										tick={{
											fontSize: 10,
											fill: "color-mix(in oklch, var(--color-base-content) 55%, transparent)",
										}}
										tickFormatter={(n: number) => (n === 1 || n % 5 === 0 ? String(n) : "")}
										allowDecimals={false}
									/>
									<YAxis
										width={30}
										tickLine={false}
										axisLine={false}
										tick={{
											fontSize: 10,
											fill: "color-mix(in oklch, var(--color-base-content) 55%, transparent)",
										}}
										tickFormatter={(s: number) => String(Math.round(s / 60))}
									/>
									<Tooltip
										content={chartTooltip}
										cursor={{
											fill: "color-mix(in oklch, var(--color-base-content) 7%, transparent)",
										}}
									/>
									{chart.bars.map((b) => (
										<Bar
											key={b.key}
											dataKey={b.key}
											name={b.name}
											stackId="a"
											fill={b.color}
											maxBarSize={22}
											radius={0}
											isAnimationActive={false}
										/>
									))}
								</BarChart>
							</ResponsiveContainer>
							<p className="mt-1 text-xs text-base-content/60">
								{chart.bars.map((b) => (
									<span key={b.key} style={{ marginRight: 14 }}>
										<span
											aria-hidden="true"
											style={{
												display: "inline-block",
												width: 9,
												height: 9,
												borderRadius: 3,
												background: b.color,
												marginRight: 5,
											}}
										/>
										{b.name}
									</span>
								))}
							</p>
						</div>
					</div>
				)}
				{!summaryError && summary && summary.days.length === 0 && (
					<p className="text-sm text-base-content/50">Nothing recorded in {cycleLabel} yet.</p>
				)}

				{error && (
					<div className="alert alert-error mt-2">
						<span>{error}</span>
					</div>
				)}
				{openDay && openDayLabel && (
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<span className="badge badge-primary badge-sm">{openDayLabel} — that day’s record</span>
						<button
							type="button"
							className="btn btn-ghost btn-xs"
							onClick={() => {
								setOpenDay(null);
								load(0, null);
							}}
						>
							Show the full record
						</button>
					</div>
				)}
				{entries == null ? (
					<p className="text-sm text-base-content/50">Loading…</p>
				) : entries.length === 0 ? (
					<p className="text-sm text-base-content/50">
						{openDay ? "Nothing recorded that day." : "Nothing recorded yet."}
					</p>
				) : (
					<ul className="mt-2 space-y-1.5">
						{entries.map((e) => (
							<li key={e.id} className="text-sm">
								<span className="text-base-content/70">{formatWhen(e.startedAt)}</span>
								{" — "}
								{verbFor(e.eventType)}{" "}
								{e.url ? (
									<Link to={e.url} className="link">
										{e.workTitle ?? "a Work"}
									</Link>
								) : (
									<span>{e.workTitle ?? "a Work"}</span>
								)}{" "}
								for {Math.max(1, Math.round(e.durationSeconds / 60))} min
								<span className="text-base-content/50">{describeEvidence(e)}</span>
							</li>
						))}
					</ul>
				)}
				{hasMore && (
					<button
						type="button"
						className="btn btn-ghost btn-sm w-fit mt-2"
						disabled={loading}
						onClick={() => load(page + 1, openDay)}
					>
						{loading ? "Loading…" : "Show older"}
					</button>
				)}
			</div>
		</div>
	);
}

/**
 * How each kind of notification reaches you — **app feed, email, or both, per group**
 * (Parker, 2026-10-08).
 *
 * The groups render from the server's resolved answer, never a local copy of the registry:
 * `GET /me` returns every group with its resolved mode, so a group the server has not in
 * its registry cannot render a control for nothing. A group with no stored answer reads
 * `both`, which is the default everything starts at.
 *
 * ⭐ **One write carries the whole map.** Each control sends the complete map it now
 * means — a per-key patch would need a story for "set it back to default", and the page
 * holds the whole state anyway.
 *
 * ⚠️ **The `email`-only column is a deliberate choice the UI does not soften.** A person
 * who picks "email only" for a group has said they read this kind in mail, not in the
 * feed; the in-app record is still written (the service's rule — email-only is not an
 * opt-out of being told, it is an opt-out of the *bell*), and the copy here says so.
 */
function NotificationsSection() {
	type Modes = Record<string, NotificationDeliveryMode>;
	const [modes, setModes] = useState<Modes | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [unsubscribed, setUnsubscribed] = useState<string | null>(null);

	const load = useCallback(() => {
		apiFetch("/api/accounts/me")
			.then(async (res) => {
				if (!res.ok) throw new Error("Could not load your notification settings.");
				const body = (await res.json()) as {
					user: { notificationDelivery?: Modes };
				};
				setModes(body.user.notificationDelivery ?? {});
			})
			.catch((e) =>
				setError(e instanceof Error ? e.message : "Could not load your notification settings."),
			);
	}, []);

	useEffect(() => load(), [load]);

	// The unsubscribe landing arrives here carrying the group it just turned off, so the
	// section acknowledges what the click did — the one moment somebody has acted on this
	// section from outside it.
	const [params, setParams] = useSearchParams();
	useEffect(() => {
		const group = params.get("unsubscribed");
		if (!group) return;
		setUnsubscribed(group);
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("unsubscribed");
				return next;
			},
			{ replace: true },
		);
		load();
	}, [params, setParams, load]);

	async function setMode(group: string, mode: NotificationDeliveryMode) {
		if (!modes) return;
		const before = modes;
		const next = { ...modes, [group]: mode };
		setModes(next); // Optimistic; snap back on refusal.
		setSaving(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ notificationDelivery: next }),
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			setModes(before);
			setError("Couldn't save that. Try again.");
		} finally {
			setSaving(false);
		}
	}

	const GROUP_COPY: Record<string, { label: string; hint: string }> = {
		conversation: {
			label: "Replies and Comments",
			hint: "Somebody replied to your comment, or commented on your post.",
		},
		reviews: { label: "Reviews", hint: "Somebody reviewed a Work of yours." },
		followers: { label: "Followers", hint: "Somebody followed you." },
		credits: { label: "Credits", hint: "You were credited on a Work." },
		reportAnswers: { label: "Report Answers", hint: "What we did about a report you filed." },
	};

	const MODE_LABELS: Record<NotificationDeliveryMode, string> = {
		both: "App & email",
		app: "App only",
		email: "Email only",
	};

	if (modes === null && !error) return null;

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Notifications</h3>
				<p className="text-sm text-base-content/60">
					Every notification lands in your app feed whatever you choose here — these decide whether
					it also arrives by email. Essential notices (money, deadlines, legal) always email and are
					never affected by this page.
				</p>
				{unsubscribed && (
					<div className="alert alert-success mt-2">
						<span>
							Done — you'll no longer get emails for{" "}
							{GROUP_COPY[unsubscribed]?.label.toLowerCase() ?? "that"}; it still shows in your app
							feed.
						</span>
					</div>
				)}
				{error && (
					<div className="alert alert-error mt-2">
						<span>{error}</span>
					</div>
				)}
				{modes !== null && (
					<div className="mt-2 flex flex-col gap-3">
						{Object.keys(GROUP_COPY).map((group) => {
							const copy = GROUP_COPY[group];
							// A group the server does not know renders nothing — a control for a
							// notification that can never arrive is the settings-page dead switch
							// the SupporterListing section's note warns about.
							if (!(group in modes)) return null;
							const mode = modes[group];
							return (
								<div key={group} className="flex flex-wrap items-center gap-x-4 gap-y-1">
									<div className="min-w-48 flex-1">
										<span className="text-sm font-medium">{copy.label}</span>
										<p className="text-xs text-base-content/50">{copy.hint}</p>
									</div>
									<fieldset className="join border-0 p-0 m-0">
										<legend className="sr-only">How {copy.label.toLowerCase()} reach you</legend>
										{(Object.keys(MODE_LABELS) as NotificationDeliveryMode[]).map((m) => (
											<button
												key={m}
												type="button"
												className={`btn btn-xs join-item ${mode === m ? "btn-primary" : "btn-ghost bg-base-300/40"}`}
												aria-pressed={mode === m}
												disabled={saving}
												onClick={() => setMode(group, m)}
											>
												{MODE_LABELS[m]}
											</button>
										))}
									</fieldset>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

interface DeletionState {
	scheduledFor: string | null;
	graceDays: number;
	preview: DeletionPreview;
}

/**
 * Your Data — the export button and the deletion flow.
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
	const [identityExporting, setIdentityExporting] = useState(false);
	const [identityReady, setIdentityReady] = useState(false);
	const [bypass, setBypass] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);

	const load = () => {
		apiFetch("/api/accounts/me/deletion")
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not load your data."))))
			.then((d) => setState(d as DeletionState))
			.catch((e) => setError(e instanceof Error ? e.message : "Could not load your data."));
	};

	// Load on mount only.
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

	const handleIdentityExport = async () => {
		setIdentityExporting(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/export/atproto", { method: "POST" });
			if (!res.ok) throw new Error("Your identity bundle could not be built.");
			const blob = await res.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `anthers-identity-${new Date().toISOString().slice(0, 10)}.zip`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			setIdentityReady(true);
			// The gate now sees a fresh bundle; reload so the confirmation reflects it.
			load();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Your identity bundle could not be built.");
		} finally {
			setIdentityExporting(false);
		}
	};

	const handleDelete = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "DELETE",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ bypassExport: bypass }),
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? "Could not schedule deletion.");
			}
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
				<h3 className="card-title text-lg">Your Data</h3>

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
						Everything Anthers holds about you, as a JSON file. Nothing in it could sign in as you,
						or belongs to someone else.
					</p>
				</div>

				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						className="btn btn-sm"
						onClick={handleIdentityExport}
						disabled={identityExporting}
					>
						{identityExporting ? "Building…" : "Download my identity"}
					</button>
					<p className="text-xs text-base-content/60">
						Your public repository, every space, and the files in them, as a ZIP. This is the copy
						that leaves with you.
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
											{p.follows === 1 ? "" : "s"}, {p.savedItems} saved item
											{p.savedItems === 1 ? "" : "s"}, {p.reviews} review
											{p.reviews === 1 ? "" : "s"}, {p.sessions} session
											{p.sessions === 1 ? "" : "s"}, and {p.viewingEvents} viewing record
											{p.viewingEvents === 1 ? "" : "s"}.
										</li>
										<li>
											<strong>Kept, with your name removed:</strong> {p.posts} post
											{p.posts === 1 ? "" : "s"} and {p.comments} comment
											{p.comments === 1 ? "" : "s"} — so conversations other people took part in
											stay readable.
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
								{p ? (
									<div
										className={`mt-3 rounded-lg p-3 ${
											p.hasRecentExport || identityReady
												? "bg-base-200"
												: "border border-warning/50 bg-warning/10"
										}`}
									>
										{p.hasRecentExport || identityReady ? (
											<p className="text-sm">
												Your identity bundle is ready
												{p.exportedAt
													? ` (taken ${new Date(p.exportedAt).toLocaleDateString()})`
													: ""}
												. It carries the public repository,{" "}
												{p.spaces === 1 ? "your space" : `${p.spaces} spaces`}, and the files in
												them.
											</p>
										) : (
											<>
												<p className="text-sm font-medium">
													The JSON file does not contain your identity.
												</p>
												<p className="mt-1 text-sm text-base-content/80">
													Your public repository, your spaces, and the files in them are destroyed
													with this account. The identity itself stays in the public directory with
													nothing behind it. Take the bundle if you want a copy you can keep or
													move.
												</p>
												<button
													type="button"
													className="btn btn-sm mt-2"
													onClick={handleIdentityExport}
													disabled={identityExporting}
												>
													{identityExporting ? "Building…" : "Download my identity bundle"}
												</button>
												<label className="mt-3 flex items-start gap-2 text-sm">
													<input
														type="checkbox"
														className="checkbox checkbox-sm"
														checked={bypass}
														onChange={(e) => setBypass(e.target.checked)}
													/>
													<span>
														I understand this is the only copy, and I am deleting without it.
													</span>
												</label>
											</>
										)}
									</div>
								) : null}
								<div className="mt-3 flex gap-2">
									<button
										type="button"
										className="btn btn-sm btn-error"
										onClick={handleDelete}
										disabled={busy || !p || (!p.hasRecentExport && !identityReady && !bypass)}
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

/**
 * The account settings are grouped into five tabs by subject, replacing a single
 * scroll of eleven sections. The tab is carried in the URL as `?tab=` so a link can
 * point somebody at the right one.
 *
 * ⭐ **Badges & Purchases joined as a tab on 2026-10-23**, rather than staying a page of its
 * own at `/purchases`. Both halves answer what the account has given, which is a settings
 * question, and the account had two doors for one subject: a menu item for the money and a
 * menu item for everything else. It sits second, between the account's switches and its
 * identity, because a person reviewing what they hold is closer to Settings' own subject
 * than the identity record is.
 */
type SettingsTab = "account" | "purchases" | "identity" | "content" | "activity";

const TAB_LABELS: { id: SettingsTab; label: string }[] = [
	{ id: "account", label: "Account" },
	{ id: "purchases", label: "Badges & Purchases" },
	{ id: "identity", label: "Identity & Devices" },
	{ id: "content", label: "Content & Safety" },
	{ id: "activity", label: "Activity & Data" },
];

function isSettingsTab(value: string | null): value is SettingsTab {
	return TAB_LABELS.some((t) => t.id === value);
}

export default function SettingsPage() {
	const { user, refreshUser, grantPublishing } = useAuth();
	const [settingsParams, setSettingsParams] = useSearchParams();

	/**
	 * The active tab. Defaults to Account.
	 *
	 * ⚠️ **`?creator=1` is an inbound redirect from `StudioAuthGate`, not a tab.** It
	 * asks for the toggle it names, which now lives on the Account tab, so the param
	 * swaps itself for `tab=account` on arrival rather than fighting the tab bar.
	 */
	const tabParam = settingsParams.get("tab");
	const activeTab: SettingsTab = isSettingsTab(tabParam) ? tabParam : "account";

	useEffect(() => {
		if (settingsParams.get("creator") !== "1") return;
		if (tabParam === "account") return;
		setSettingsParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.set("tab", "account");
				next.delete("creator");
				return next;
			},
			{ replace: true },
		);
	}, [settingsParams, tabParam, setSettingsParams]);

	/**
	 * Somebody the Studio's gate sent here, rather than somebody who came to change a setting.
	 *
	 * ⚠️ **The redirect was right and silent.** `StudioAuthGate` bounces a signed-in
	 * non-creator to this page because creator mode is enabled here — but arriving with no
	 * explanation reads as a dead end, and this page has a dozen switches, only one of which
	 * is the one they wanted. Gone as soon as they turn it on, so it never becomes furniture.
	 *
	 * Captured once from the arrival URL: `?creator=1` swaps itself for `tab=account`
	 * immediately (the effect below), so a live re-read of the param would un-explain the
	 * visit the moment the effect ran.
	 */
	const [sentFromStudio] = useState(
		() => settingsParams.get("creator") === "1" && !user?.isCreator,
	);

	const [isCreator, setIsCreator] = useState(user?.isCreator || false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);
	/** The browser is on its way to Bluesky, so say why rather than appearing to hang. */
	const [redirecting, setRedirecting] = useState(false);

	/**
	 * A visited tab stays mounted, hidden with CSS, rather than being unmounted.
	 *
	 * ⚠️ Unmounting threw a tab's loaded state away at every switch, so each visit
	 * re-ran the loads and the page collapsed and grew again as they resolved.
	 * Keeping visited panes mounted makes a switch instant — after the first look
	 * at a tab, nothing refetches and nothing reflows.
	 */
	const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(() => new Set([activeTab]));
	useEffect(() => {
		setVisitedTabs((prev) => (prev.has(activeTab) ? prev : new Set([...prev, activeTab])));
	}, [activeTab]);

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

			// ⭐ **Setting up to publish is the moment to ask for the one permission publishing
			// needs**, rather than leaving it as a switch to discover in the Studio later. This is
			// how permissions work everywhere else: you authorize an application for what it does
			// when you connect it, and then stop thinking about it.
			if (checked && (await handOverToPublishingGrant())) return;

			setSuccess(true);
		} catch (err) {
			setIsCreator(!checked); // revert on failure
			setError(err instanceof Error ? err.message : "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	};

	/**
	 * Send somebody who has just become a creator to grant the publishing permission.
	 *
	 * Answers whether the browser is leaving, so the caller can stop rather than flash a
	 * "settings saved" they will never read.
	 *
	 * ⚠️ **Only when there is actually something to ask for.** An account whose identity Anthers
	 * hosts needs no permission — the credential is already held — and one that has granted it
	 * already is not asked twice. Both are silent, because the honest answer in each case is
	 * that publishing already works.
	 *
	 * ⚠️ **Every failure here is swallowed on purpose.** Becoming a creator succeeded, and a
	 * permission we could not ask for is not a reason to tell somebody their setting did not save.
	 * They cannot publish without it, and the banner at the top of every page says so and asks
	 * again.
	 */
	const handOverToPublishingGrant = async (): Promise<boolean> => {
		try {
			const res = await apiFetch("/api/atproto/publishing");
			if (!res.ok) return false;
			const state = (await res.json()) as { route: string; offered: boolean };
			if (state.route !== "ungranted" || !state.offered) return false;

			setRedirecting(true);
			await grantPublishing();
			return true;
		} catch {
			setRedirecting(false);
			return false;
		}
	};

	// ⚠️ DaisyUI 5's `.label` ships `white-space: nowrap`, meant for labels beside input
	// fields — the labels below carry sentences, so every toggle row adds
	// `whitespace-normal` to let them wrap.
	return (
		<div className="max-w-3xl mx-auto px-4 py-8">
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
			{redirecting && (
				<div className="alert alert-info mb-4">
					<span>
						You're a creator now. Taking you to the server your identity lives on to give Anthers
						permission to publish your Works, posts and projects — you need to give it before you
						can publish anything.
					</span>
				</div>
			)}

			{sentFromStudio && (
				<div className="alert alert-info mb-4">
					<span>
						The Studio is for creators, so we brought you here. Turn on creator mode below and it
						opens.
					</span>
				</div>
			)}

			{/* `tabs-box`, not the retired v4 `tabs-boxed` — the same convention the
			    Library page uses. The row scrolls on a narrow screen now that it carries five
			    labels, the longest of which names two objects. */}
			<div
				role="tablist"
				aria-label="Settings"
				className="tabs tabs-box mb-6 w-fit max-w-full overflow-x-auto"
			>
				{TAB_LABELS.map((t) => (
					<button
						key={t.id}
						type="button"
						role="tab"
						aria-selected={activeTab === t.id}
						className={`tab ${activeTab === t.id ? "tab-active" : ""}`}
						onClick={() =>
							setSettingsParams(
								(prev) => {
									const next = new URLSearchParams(prev);
									next.set("tab", t.id);
									return next;
								},
								{ replace: true },
							)
						}
					>
						{t.label}
					</button>
				))}
			</div>

			{visitedTabs.has("account") && (
				<div hidden={activeTab !== "account"}>
					{/* Who this browser is signed in as, and the button that ends it. The header
					    menu no longer carries Log Out; both settings pages do. */}
					<SignedInAccountCard className="mb-6" />

					{/* Creator mode toggle */}
					<div
						className={`card mb-6 ${sentFromStudio ? "bg-base-200 ring-2 ring-info" : "bg-base-200"}`}
					>
						<div className="card-body">
							<div className="form-control">
								<label className="label whitespace-normal cursor-pointer justify-start gap-3">
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
											Allows you to publish projects and posts — releasing anything also requires a
											completed Stripe payout setup, which at launch reaches only the countries
											Stripe supports for a platform like ours
										</p>
									</div>
								</label>
							</div>
						</div>
					</div>

					{/* Where a session starts: one tab, chosen here rather than by the nav's
					    arrangement, which is fixed. */}
					<StartingTabSection />

					{/* The one setting that decides whether a person's name appears in public. */}
					<SupporterListingSection />

					{/* The saved billing address — the account's one opt-in payment-side record,
					    read-only everywhere except this page. */}
					<BillingAddressSection />

					{/* The per-install playback preferences — the feed-tile preview stop *Your
					    Feed* promises, among the other remembered-by-browser settings. */}
					<MediaPlaySection />

					{/* The account-level playback preference — where audio lives: the
					    persistent footer bar or the page's own player. */}
					<MiniPlayerSection />

					{/* The topbar's two chords. Defaults for everybody, rebindable per account. */}
					<KeyboardShortcutsSection />

					{/* Creator Tools live in the Studio (payouts, connections); Badges are edited
					    on the creator's own profile, beside the ladder supporters meet. */}
					{isCreator && (
						<div className="card bg-base-200 mt-6">
							<div className="card-body">
								<h3 className="card-title text-lg">Creator Tools</h3>
								<p className="text-sm text-base-content/60">
									Manage payouts and platform connections in your Studio. Your Badges are on your
									profile, beside the ladder supporters see.
								</p>
								<div className="flex flex-wrap gap-2">
									<a href={studioUrl("/settings")} className="btn btn-primary btn-sm w-fit">
										Open Studio settings
									</a>
									{user?.handle && (
										<Link
											to={`${profileUrl(user.handle)}?tab=badges`}
											className="btn btn-ghost btn-sm w-fit"
										>
											Edit your Badges
										</Link>
									)}
								</div>
							</div>
						</div>
					)}
				</div>
			)}

			{visitedTabs.has("purchases") && (
				<div hidden={activeTab !== "purchases"}>
					{/* What this account holds and what it has bought — the same two components the
					    old `/purchases` page mounted, now a tab so the account has one address. */}
					<BadgesSection />
					<PurchasesSection />
				</div>
			)}

			{visitedTabs.has("identity") && (
				<div hidden={activeTab !== "identity"}>
					{/* The account's identity on the network — issued here, or brought from elsewhere. */}
					<IdentitySection />

					{/* Signed-in devices — revocation for browsers and the desktop Studio. */}
					<DesktopHomeSection />

					<DevicesSection />
				</div>
			)}

			{visitedTabs.has("content") && (
				<div hidden={activeTab !== "content"}>
					{/* What the user meets at each rung, and the door to the Adult rung. */}
					<MatureContentSection />

					{/* Directly under it, because the first thing the pin protects is the section
					    above — and a guardian who has just set those switches is exactly who wants
					    to lock them. */}
					<ParentalControlsSection />

					{/* Blocked Accounts — the only place a block can be lifted, since a blocked
					    profile no longer resolves. */}
					<BlockedSection />
				</div>
			)}

			{visitedTabs.has("activity") && (
				<div hidden={activeTab !== "activity"}>
					{/* How each kind of notification reaches you — app, email, or both. First on
					    the tab, because it is the settings the most surfaces point at (the email
					    footers and the unsubscribe landing both name this page). */}
					<NotificationsSection />

					{/* The person's own attention record — what the Privacy Policy says they can read. */}
					<ActivityHistorySection />

					{/* Export and deletion — the controls Privacy Policy and /parents describe. */}
					<DataSection />
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
 * started supporting *and* can find the switch afterwards. `/signup` does the telling;
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
					<label className="label whitespace-normal cursor-pointer justify-start gap-3">
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

/**
 * The account's rebindable shortcuts: the search bar's two and a player's two.
 *
 * 🚨 **A chord is validated by the shared grammar before it is saved, and the server
 * validates it again.** The recorder is a convenience; the route is the check. That is
 * also why the card surfaces the server's message instead of inventing its own — a
 * setting that appears to save and does not is the one outcome worth failing loudly on.
 *
 * The scopes are what decide whether a bare key is allowed. Search and Filter are heard
 * across the page and must carry a modifier, or they would eat typing; Full screen and
 * Theater mode are heard by a player that already has focus, where a bare letter is the
 * binding people expect.
 *
 * Recording listens in the capture phase and stops propagation so the bar's own listener
 * (and the browser) never acts on the chord being recorded.
 */
function KeyboardShortcutsSection() {
	const { user, refreshUser } = useAuth();
	const apple = isApplePlatform();
	const stored = useMemo(
		() => resolveKeyboardShortcuts(user?.keyboardShortcuts),
		[user?.keyboardShortcuts],
	);
	const [draft, setDraft] = useState<KeyboardShortcuts>(stored);
	const [recording, setRecording] = useState<KeyboardShortcutAction | null>(null);
	const [saving, setSaving] = useState(false);
	const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);

	useEffect(() => setDraft(stored), [stored]);

	const save = useCallback(
		async (next: KeyboardShortcuts) => {
			setSaving(true);
			setNotice(null);
			try {
				const res = await apiFetch("/api/accounts/me", {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ keyboardShortcuts: next }),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as { error?: unknown };
					throw new Error(
						typeof body.error === "string" ? body.error : "That shortcut could not be saved.",
					);
				}
				setDraft(next);
				await refreshUser();
			} catch (error) {
				setNotice({
					tone: "error",
					text: error instanceof Error ? error.message : "That shortcut could not be saved.",
				});
				setDraft(stored);
			} finally {
				setSaving(false);
			}
		},
		[refreshUser, stored],
	);

	useEffect(() => {
		if (!recording) return;
		const playerScoped = isPlayerShortcutAction(recording);
		const handler = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "Escape") {
				setRecording(null);
				setNotice(null);
				return;
			}
			// A modifier alone is not a chord yet; keep listening for the key after it.
			if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
			const key = keyFromEvent(event);
			if (!key) return;

			const parts: string[] = [];
			// Only Apple has a second modifier worth recording. Off Apple `Mod` resolves
			// to Control, so a Meta press (the Windows key) has no portable spelling and
			// recording it as `Mod` would silently bind Control instead.
			if (apple && event.metaKey) parts.push("Mod");
			// On a Mac, Control and Command are different keys, so the recorder preserves
			// whichever the person pressed. Off Apple they are the same physical key.
			if (event.ctrlKey) parts.push(apple ? "Ctrl" : "Mod");
			if (event.altKey) parts.push("Alt");
			if (event.shiftKey) parts.push("Shift");
			parts.push(key);

			const chord = canonicalChord(parts.join("+"), { bare: playerScoped });
			if (!chord) {
				setNotice({
					tone: "error",
					text: `A page shortcut needs ${apple ? "Command, Control, or Option" : "Ctrl or Alt"} plus one other key.`,
				});
				return;
			}
			const other = KEYBOARD_SHORTCUT_ACTIONS.filter((action) => action !== recording).map(
				(action) => draft[action],
			);
			if (other.some((existing) => chordsCollide(existing, chord))) {
				setNotice({
					tone: "error",
					text: "Another shortcut already uses that combination.",
				});
				return;
			}
			setRecording(null);
			setNotice(null);
			void save({ ...draft, [recording]: chord });
		};
		window.addEventListener("keydown", handler, true);
		return () => window.removeEventListener("keydown", handler, true);
	}, [recording, draft, apple, save]);

	const groups: Array<{ title: string; actions: readonly KeyboardShortcutAction[] }> = [
		{ title: "Anywhere on the page", actions: PAGE_SHORTCUT_ACTIONS },
		{ title: "While a player has focus", actions: PLAYER_SHORTCUT_ACTIONS },
	];

	const rowCopy: Record<KeyboardShortcutAction, { label: string; hint: string }> = {
		search: {
			label: "Search everything",
			hint: "Opens the global search across creators, Works, Projects, Posts, modes, and settings.",
		},
		filter: {
			label: "Filter this view",
			hint: `Rebinding this gives ${formatChord(DEFAULT_KEYBOARD_SHORTCUTS.filter, apple)} back to the browser's find.`,
		},
		sidebar: {
			label: "Toggle the sidebar",
			hint: "Collapses it to its rail on a wide screen, and closes the drawer over the page on a phone.",
		},
		fullscreen: {
			label: "Full screen",
			hint: "Hands the work the whole monitor through the browser's own full-screen mode.",
		},
		theater: {
			label: "Theater mode",
			hint: "Fills the area inside the topbar and sidebar with the work, leaving the rest of the page a scroll away.",
		},
	};

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body">
				<h3 className="card-title text-lg">Keyboard Shortcuts</h3>
				<p className="text-sm text-base-content/60">
					These follow your account, so they work on every device you sign in on. Player shortcuts
					work once the player has focus.
				</p>

				{groups.map((group) => (
					<div key={group.title} className="mt-2">
						<p className="text-xs font-semibold uppercase tracking-wider text-base-content/45">
							{group.title}
						</p>
						<div className="divide-y divide-base-300/50">
							{group.actions.map((action) => {
								const chord = draft[action];
								const isDefault = chord === DEFAULT_KEYBOARD_SHORTCUTS[action];
								const copy = rowCopy[action];
								return (
									<div
										key={action}
										className="flex flex-wrap items-center justify-between gap-2 py-3"
									>
										<div className="min-w-0">
											<p className="text-sm font-medium">{copy.label}</p>
											<p className="text-xs text-base-content/50">{copy.hint}</p>
										</div>
										<div className="flex shrink-0 items-center gap-2">
											<kbd className="kbd kbd-sm">{formatChord(chord, apple)}</kbd>
											<button
												type="button"
												className="btn btn-ghost btn-xs"
												disabled={saving}
												onClick={() => {
													setRecording(action);
													setNotice(null);
												}}
											>
												{recording === action ? "Press keys…" : "Change"}
											</button>
											<button
												type="button"
												className="btn btn-ghost btn-xs"
												disabled={saving || isDefault}
												onClick={() =>
													void save({ ...draft, [action]: DEFAULT_KEYBOARD_SHORTCUTS[action] })
												}
											>
												Reset
											</button>
										</div>
										{BROWSER_RESERVED_CHORDS.has(chord) && (
											<p className="w-full text-xs text-warning">
												Your browser may keep this combination for itself, in which case it will not
												reach Anthers.
											</p>
										)}
									</div>
								);
							})}
						</div>
					</div>
				))}

				<p className="mt-2 text-xs text-base-content/50" aria-live="polite">
					{recording
						? `Press the combination for ${rowCopy[recording].label}. Escape cancels.`
						: ""}
				</p>
				{notice && !recording && (
					<p
						className={`text-xs ${notice.tone === "error" ? "text-error" : "text-base-content/50"}`}
						aria-live="assertive"
					>
						{notice.text}
					</p>
				)}
			</div>
		</div>
	);
}
