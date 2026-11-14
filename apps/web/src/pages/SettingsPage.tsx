// SPDX-License-Identifier: Apache-2.0

import { currentCycleKey } from "@anthers/shared/billing-cycle";
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
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@anthers/shared/passwords";
import DiscordCard from "@anthers/web-shared/account/DiscordCard";
import SignedInAccountCard from "@anthers/web-shared/account/SignedInAccountCard";
import { useAuth } from "@anthers/web-shared/auth";
import { useContentPreferences } from "@anthers/web-shared/content-preferences";
import {
	type DesktopHome,
	desktopHome,
	isDesktop,
	setDesktopHome,
} from "@anthers/web-shared/desktop";
import { usePublishingState } from "@anthers/web-shared/publishing";
import { Link, useSearchParams } from "@anthers/web-shared/router";
import { apiFetch, client } from "@anthers/web-shared/rpc";
import { useSidebar } from "@anthers/web-shared/sidebar";
import type { NotificationDeliveryMode } from "@anthers/web-shared/types";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import ActivityDetailsSection from "../components/account/ActivityDetailsSection";
import BadgesSection from "../components/account/BadgesSection";
import PurchasesSection from "../components/account/PurchasesSection";
import TimePoolSection from "../components/account/TimePoolSection";
import BlueskyMark from "../components/auth/BlueskyMark";
import { sidebarRowClass } from "../components/layout/sidebar-row-class";
import MusicPlayerSection from "../components/settings/MusicPlayerSection";
import ParentalControlsSection from "../components/settings/ParentalControlsSection";
import PaymentInfoSection from "../components/settings/PaymentInfoSection";
import { isApplePlatform } from "../lib/platform";
import { generateRecoveryKey, type RecoveryKeypair } from "../lib/recovery-key";
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
 * The tabs render in one fixed order, so this is the only control over where a session
 * lands: sign-in, a fresh tab on `/`, and the mode switch's User side all read the same
 * answer. Account-level rather than per-browser for the reason the theme is — which tab a
 * person arrives on is how they use the site, not a property of a computer.
 *
 * Null = never answered, and the client reads that as Discovery; the column never bakes
 * the default in, so a later default change needs no rows rewritten. A stored `network`
 * from before the tabs merged reads the same way — it is the same tab now.
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
				{/* The merged tab remembers its own recipe separately (Discovery's recipe
				    bar), so this card deliberately says nothing about which stream a reader
				    sees once they land — that would be a second setting wearing this one's
				    clothes. */}

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
								Your Library or Discovery, starting with the one you chose in Settings
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
					{/* The stop the stream commits every feed signal to: previews are the
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
 * Rating Controls — the two rungs, each with the same Hide / Blur / Show control.
 *
 * 🚨 **The two rungs get separate controls, and that separation is the design rather than
 * layout.** A user who wants difficult work unblurred has said nothing about whether they
 * want explicit work at all, and one control covering both would make them say it (the
 * wiki's *Content Standards*).
 *
 * ⭐ **Adult is a normal three-way control now** (Parker, 2026-11-06), not the long
 * explanation it used to carry. It is locked until the account has a payment method to
 * read, and the one sentence beside it names what that method is for; the (i) carries the
 * rest for anybody who wants it.
 *
 * 🚨 **Nothing here may describe paying as an age check.** A payment proves nothing about
 * age — debit and prepaid cards have no age floor. What carries the signal is the card's
 * funding TYPE, because issuers require the primary accountholder of a credit line to be 18.
 * The hoverable says that plainly, including the part where an adult with only a debit card
 * cannot get in and nothing routes around it.
 */
function RatingControlsSection() {
	const { prefs, refresh } = useContentPreferences();
	const { busy, error, setDisplay, setBusy, setError } = useContentDisplayWriter();
	const [proof, setProof] = useState<{
		savedCard: boolean;
		cardIsCredit: boolean;
		payoutReady: boolean;
		canVerify: boolean;
	} | null>(null);

	const loadProof = useCallback(async () => {
		try {
			const res = await apiFetch("/api/accounts/me/adult-access");
			if (!res.ok) return;
			const data = (await res.json()) as {
				paymentProof?: {
					savedCard: boolean;
					cardIsCredit: boolean;
					payoutReady: boolean;
					canVerify: boolean;
				};
			};
			setProof(data.paymentProof ?? null);
		} catch {
			/* The control falls back to its locked reason. */
		}
	}, []);

	useEffect(() => {
		void loadProof();
		const changed = () => void loadProof();
		window.addEventListener("anthers:payment-info-changed", changed);
		return () => window.removeEventListener("anthers:payment-info-changed", changed);
	}, [loadProof]);

	const setAdultAccess = async (on: boolean): Promise<boolean> => {
		setBusy(true);
		setError(null);
		try {
			const res = await apiFetch("/api/accounts/me/adult-access", {
				method: on ? "POST" : "DELETE",
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? "That couldn't be saved.");
				return false;
			}
			await refresh();
			return true;
		} catch {
			setError("That couldn't be saved.");
			return false;
		} finally {
			setBusy(false);
		}
	};

	// The ordinary control when a proof exists; the whole card stays locked, with the
	// reason, when neither a saved credit card nor a creator payout standing is on file.
	const canAttempt = prefs.adultAccess.canReach || proof?.canVerify === true;
	const locked = !prefs.adultAccess.canReach && !canAttempt;

	const chooseAdult = async (value: MaturityDisplay) => {
		if (!prefs.adultAccess.canReach) {
			const verified = await setAdultAccess(true);
			if (!verified) return;
		}
		await setDisplay({ adult: value });
	};

	const lockedReason = proof?.savedCard
		? "The saved card is a debit card, so it cannot verify age. Replace it with a credit card in Account settings, or complete creator payouts."
		: "Save payment info in Account settings to unlock Adult content, or complete creator payouts.";

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body gap-4">
				<div>
					<h3 className="card-title text-lg">Rating Controls</h3>
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
					<DisplayChoice
						name="Mature"
						current={prefs.mature}
						disabled={busy}
						choose={(value) => setDisplay({ mature: value })}
					/>
				</div>

				<div className="border-t border-base-300 pt-4">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<p className="font-medium text-sm">Adult</p>
							<p className="text-xs text-base-content/60">
								Explicit sexual content, or, in visual work such as video and games, extreme
								violence or drug use that is the work's focus. Invisible on Anthers until you turn
								this on.
							</p>
						</div>
						<DisplayChoice
							name="Adult"
							current={prefs.adult}
							disabled={busy}
							locked={locked}
							onLocked={() => setError(lockedReason)}
							choose={(value) => void chooseAdult(value)}
						/>
					</div>

					{locked ? (
						<div className="mt-2">
							<p className="flex flex-wrap items-center gap-1 text-xs text-base-content/60">
								<span>
									{lockedReason}{" "}
									<Link to="/settings?tab=account" className="link">
										Account settings
									</Link>
								</span>
								<InfoHint text="Anthers reads whether the card on your account is a credit card, because card issuers require the primary accountholder of a credit line to be 18. A creator whose payout onboarding is complete has already had their identity and age checked by Stripe, so that counts too and asks for no card. Nothing is charged and nothing appears on your statement, and we keep only that the check happened, when, and which proof it was — we never see or store your date of birth, and we never ask for ID. Debit and prepaid cards have no age requirement, so they cannot answer the card check; if one is your only card and you are not a verified creator, there is no other way to do this today." />
							</p>
						</div>
					) : prefs.adultAccess.canReach ? (
						<div className="mt-2">
							<button
								type="button"
								className="btn btn-ghost btn-xs"
								disabled={busy}
								onClick={() => void setAdultAccess(false)}
							>
								Turn Adult access off
							</button>
						</div>
					) : (
						<p className="mt-2 flex flex-wrap items-center gap-1 text-xs text-base-content/60">
							<span>
								{proof?.payoutReady
									? "Your creator payout verification counts as the age check."
									: "Your saved credit card is the age check — nothing is charged and nothing appears on your statement."}
							</span>
							<InfoHint text="This is a one-time check, not a payment. Anthers reads whether the card is a credit card, because issuers require the primary accountholder of a credit line to be 18; a creator whose payout onboarding is complete has already been identity-checked by Stripe and needs no card. Nothing is charged, nothing appears on your statement, and we keep only that the check happened, when, and which proof it was." />
						</p>
					)}

					{error && <p className="text-sm text-error">{error}</p>}
				</div>
			</div>
		</div>
	);
}

/**
 * Content Controls — the flags a Work may carry, whatever its rating.
 *
 * **Each kind of content gets a control** (Parker, 2026-09-18), for a user who does not mind
 * rated work but wants to avoid one thing. Show by default, because a note may drive a
 * user's own filter and never a platform default. A guardian's lock covers these with the
 * rungs, since they are written by the same writer.
 */
function ContentControlsSection() {
	const { prefs } = useContentPreferences();
	const { busy, error, setDisplay } = useContentDisplayWriter();

	return (
		<div className="card bg-base-200 mb-6">
			<div className="card-body gap-4">
				<div>
					<h3 className="card-title text-lg">Content Controls</h3>
					<p className="text-sm text-base-content/60">
						Hide or blur work that contains any of these, whatever it's rated. Creators mark each
						one for every Work, and work counts as containing it unless its creator marked it Not in
						It.
					</p>
					<p className="text-sm text-base-content/60">
						If you're a creator, this won't apply to how you see your own works around the site.
					</p>
				</div>

				<div className="flex flex-col gap-2">
					{RATING_ROWS.map((row) => (
						<div key={row.note} className="flex flex-wrap items-center justify-between gap-3">
							<span className="text-sm">{row.label}</span>
							<DisplayChoice
								name={row.label}
								current={prefs.notes[row.note]}
								disabled={busy}
								choose={(value) => setDisplay({ notes: { [row.note]: value } })}
							/>
						</div>
					))}
				</div>

				{error && <p className="text-sm text-error">{error}</p>}
			</div>
		</div>
	);
}

/**
 * The one Hide / Blur / Show control, shared by both rungs and every content flag.
 *
 * A `fieldset` with `aria-label` gives each row the group name the browser walk reads
 * (`getByRole("group", { name: "Mature" })`), so the controls cannot drift apart between
 * the ratings card and the flags card.
 */
function DisplayChoice({
	name,
	current,
	disabled,
	locked = false,
	onLocked,
	choose,
}: {
	name: string;
	current: MaturityDisplay;
	disabled: boolean;
	/** The rung cannot be changed until something outside this control changes. The
	 *  buttons keep their selected fill — a dimmed fieldset that erases which value is
	 *  chosen tells the reader less than one that shows it — and a click opens the door
	 *  that unlocks them rather than silently doing nothing. */
	locked?: boolean;
	onLocked?: () => void;
	choose: (value: MaturityDisplay) => void;
}) {
	return (
		<fieldset className="join" aria-label={name} aria-disabled={locked || undefined}>
			{MATURITY_DISPLAY_CHOICES.map((choice) => (
				<button
					key={choice.value}
					type="button"
					className={`btn btn-sm join-item ${current === choice.value ? "btn-primary" : "btn-outline"} ${locked ? "opacity-50" : ""}`}
					aria-pressed={current === choice.value}
					aria-disabled={locked || undefined}
					disabled={disabled}
					title={locked ? "Save payment info to unlock Adult content" : choice.hint}
					onClick={() => {
						if (locked) {
							onLocked?.();
							return;
						}
						choose(choice.value);
					}}
				>
					{choice.label}
				</button>
			))}
		</fieldset>
	);
}

/**
 * The (i) beside the Adult warning: a hoverable and focusable explanation.
 *
 * ⚠️ **The text is in the DOM rather than only in a `title`**, so a keyboard or screen
 * reader reaches the same sentences a mouse does, and the copy can be selected instead of
 * vanishing the moment the pointer moves.
 */
function InfoHint({ text }: { text: string }) {
	const id = useId();
	return (
		<span className="group relative inline-flex">
			<button
				type="button"
				aria-label="About age verification"
				aria-describedby={id}
				className="inline-flex rounded-full text-base-content/50 hover:text-base-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
			>
				<InformationCircleIcon className="h-4 w-4" />
			</button>
			<span
				id={id}
				role="tooltip"
				className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-80 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-box border border-base-300 bg-base-100 p-3 text-left text-xs leading-relaxed text-base-content/70 opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
			>
				{text}
			</span>
		</span>
	);
}

/**
 * The shared save for the content-preference controls: one PATCH, then a refresh of the
 * context every cover and listing reads.
 */
function useContentDisplayWriter() {
	const { refresh } = useContentPreferences();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

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

	return { busy, error, setDisplay, setBusy, setError };
}

/**
 * The two lists behind Discovery's *Don't Show* menu rows.
 *
 * ⭐ **Both lists sit in one card because they answer one question** — what have I asked the
 * stream not to show me — and because the difference between a hide and a block is the
 * copy's job. A reader who expects a block and gets a feed filter is owed that difference in
 * words, so the card says what a hide does *not* do: the Work and the profile still open
 * from a link, still turn up in search, and hiding a creator moves no follow, no Badge and
 * no purchase.
 *
 * ⚠️ **"Show again" is the only control here, and it has to exist.** The tile that hid an
 * entry is gone from Discovery, so this page is the one route back — which is also why the
 * lists are read from the server rather than from anything the stream holds.
 */
function HiddenFromDiscoverySection() {
	const [lists, setLists] = useState<HiddenLists | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [clearing, setClearing] = useState<string | null>(null);

	useEffect(() => {
		apiFetch("/api/accounts/me/hidden")
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error("Failed to load."))))
			.then((data) => setLists(data as HiddenLists))
			.catch(() => setError("Could not load what you've hidden."));
	}, []);

	const showAgain = async (kind: "works" | "creators", id: number) => {
		setClearing(`${kind}-${id}`);
		setError(null);
		try {
			const res = await apiFetch(`/api/accounts/me/hidden/${kind}/${id}`, { method: "DELETE" });
			if (!res.ok) throw new Error("Failed to show that again.");
			if (kind === "works") {
				setLists((prev) => prev && { ...prev, works: prev.works.filter((row) => row.id !== id) });
			} else {
				setLists(
					(prev) => prev && { ...prev, creators: prev.creators.filter((row) => row.id !== id) },
				);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to show that again.");
		} finally {
			setClearing(null);
		}
	};

	const rowClass = "flex items-center gap-3 py-3";

	return (
		<div className="card bg-base-200 mt-6">
			<div className="card-body gap-4">
				<div>
					<h3 className="card-title text-lg">Hidden from Discovery</h3>
					<p className="text-sm text-base-content/60">
						Hiding a Work or a creator keeps them out of Discovery. It isn't a block: both still
						open from a link and still turn up in search, and hiding a creator leaves your follows,
						Badges and purchases exactly as they were.
					</p>
				</div>

				{error && (
					<div className="alert alert-error text-sm">
						<span>{error}</span>
					</div>
				)}

				{lists === null && !error && <p className="text-sm text-base-content/50">Loading…</p>}

				{lists !== null && (
					<>
						<div>
							<h4 className="font-medium">Hidden Works</h4>
							{lists.works.length === 0 ? (
								<p className="text-sm text-base-content/50 mt-2">You haven't hidden any Works.</p>
							) : (
								<ul className="mt-2 divide-y divide-base-300" aria-label="Hidden Works">
									{lists.works.map((work) => (
										<li key={work.id} className={rowClass}>
											{work.thumbnail ? (
												<img
													src={work.thumbnail}
													alt=""
													className="h-10 w-10 shrink-0 rounded object-cover"
												/>
											) : (
												<div
													className="h-10 w-10 shrink-0 rounded bg-base-300"
													aria-hidden="true"
												/>
											)}
											<div className="min-w-0 flex-1">
												<Link
													to={`/works/${work.slug}`}
													className="font-medium link-hover truncate block"
												>
													{work.title || "Untitled Work"}
												</Link>
												<div className="text-xs text-base-content/50 truncate">
													@{work.creatorHandle} · hidden {formatWhen(work.createdAt)}
												</div>
											</div>
											<button
												type="button"
												className="btn btn-ghost btn-xs"
												onClick={() => showAgain("works", work.id)}
												disabled={clearing === `works-${work.id}`}
											>
												{clearing === `works-${work.id}` ? "Showing…" : "Show again"}
											</button>
										</li>
									))}
								</ul>
							)}
						</div>

						<div>
							<h4 className="font-medium">Hidden Creators</h4>
							{lists.creators.length === 0 ? (
								<p className="text-sm text-base-content/50 mt-2">
									You haven't hidden any creators.
								</p>
							) : (
								<ul className="mt-2 divide-y divide-base-300" aria-label="Hidden Creators">
									{lists.creators.map((creator) => (
										<li key={creator.id} className={rowClass}>
											{creator.avatar ? (
												<img
													src={creator.avatar}
													alt=""
													className="h-10 w-10 shrink-0 rounded-full object-cover"
												/>
											) : (
												<div
													className="h-10 w-10 shrink-0 rounded-full bg-base-300"
													aria-hidden="true"
												/>
											)}
											<div className="min-w-0 flex-1">
												<Link
													to={`/@${creator.handle}`}
													className="font-medium link-hover truncate block"
												>
													{creator.displayName || `@${creator.handle}`}
												</Link>
												<div className="text-xs text-base-content/50 truncate">
													@{creator.handle} · hidden {formatWhen(creator.createdAt)}
												</div>
											</div>
											<button
												type="button"
												className="btn btn-ghost btn-xs"
												onClick={() => showAgain("creators", creator.id)}
												disabled={clearing === `creators-${creator.id}`}
											>
												{clearing === `creators-${creator.id}` ? "Showing…" : "Show again"}
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}

interface HiddenWorkRow {
	id: number;
	publicId: number;
	slug: string;
	title: string;
	thumbnail: string | null;
	creatorHandle: string;
	createdAt: string;
}

interface HiddenCreatorRow {
	id: number;
	handle: string;
	displayName: string | null;
	avatar: string | null;
	createdAt: string;
}

/** What `GET /api/accounts/me/hidden` sends: the two lists, oldest first. */
interface HiddenLists {
	works: HiddenWorkRow[];
	creators: HiddenCreatorRow[];
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
				<IdentityServerCard hosted={false} credentialMissing={false} />
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
			<IdentityServerCard hosted credentialMissing={publishing?.hostedCredential === "missing"} />
		</>
	);
}

/**
 * Whether this identity's server is Bluesky's.
 *
 * ⚠️ **A hostname test, and the only thing it decides is which settings page to link.** A Bluesky
 * identity's PDS is `bsky.social` or a shard under `bsky.network`, and Bluesky keeps the credential,
 * the handle and the app list in `bsky.app`'s settings rather than on a page the server serves. A
 * self-hosted server gets no link at all: its settings path is the operator's to choose, and a
 * guess that 404s reads as a broken product.
 */
function isBlueskyHost(host: string): boolean {
	return host === "bsky.social" || host.endsWith(".bsky.network");
}

/**
 * The server holding this identity, and the account page it keeps for its holder.
 *
 * ⭐ **The page belongs to the server, not to Anthers**, and pointing at it is what the reference
 * PDS's account page made possible: a person manages their identity where it lives instead of in
 * whichever app they happen to use, or in the Bluesky app that used to be the only alternative.
 *
 * 🚨 **A hosted identity gets the password door here rather than a link to the server's page.**
 * The credential is the person's, but every hosted account created before that changed was handed
 * a password nobody could type — so the person needs a way to set one before they can use their
 * identity anywhere else. The node's own emailed reset is that way, and Anthers drives it from this
 * card so the person does not have to know the server has a page at all. Anthers keeps a session,
 * never a copy of the password.
 *
 * ⚠️ **The link appears only when the server answers that the page exists.** `pds-health.ts`
 * asks `/account` and remembers the answer per origin, because a link is a claim that there is
 * a page, and a server still on an older release has none.
 */
function IdentityServerCard({
	hosted,
	credentialMissing,
}: {
	hosted: boolean;
	/**
	 * Anthers holds nothing that opens this identity: no session and no password.
	 *
	 * 🚨 **The one state the card can name before anybody tries to write**, and the reason it
	 * exists is that nothing used to name it. A hosted account in it cannot be written to at all,
	 * so every publish, post and listing failed at the write and retried, and the only symptom was
	 * content that never reached the network.
	 *
	 * ⚠️ **`false` is not a promise.** A session the holder's own password reset revoked reads as
	 * present until the node answers; the absence is all this can honestly report.
	 */
	credentialMissing: boolean;
}) {
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
					<>
						<p className="text-sm text-base-content/60">
							Your identity lives on {host}, the server Anthers runs.
						</p>
						{credentialMissing && (
							<div className="rounded-box border border-warning/40 p-3">
								<p className="text-sm">
									Anthers has no way into this identity right now, so nothing you publish, post or
									save reaches the network until it does. Everything already there is untouched.
								</p>
							</div>
						)}
						<HostedPasswordForm handle={user?.handle ?? ""} />
					</>
				) : (
					<>
						<p className="text-sm text-base-content/60">
							Your identity lives on {host}, which Anthers doesn't run.
						</p>
						{/* 🚨 **Three rungs, and the middle one is only honest for Bluesky.** The
						    identity's own server is the authority on the credential, so a link to its
						    account page is the best answer when it publishes one. Bluesky has no such
						    page but does keep the password, the handle and the signed-in apps in its
						    settings, which is where a Bluesky identity is managed. Anybody else's
						    server is left as a name and a sentence, because guessing at a settings
						    path we have never seen is worse than saying where the identity lives. */}
						{state?.server?.accountPage ? (
							<>
								<p className="text-sm text-base-content/60">
									That server keeps an account page of its own, where you change the password on the
									identity, see the devices signed in to it, and revoke any app with access to it.
								</p>
								<a className="btn btn-sm w-fit" href={accountUrl} target="_blank" rel="noreferrer">
									Open {host}/account
								</a>
							</>
						) : isBlueskyHost(host) ? (
							<>
								<p className="text-sm text-base-content/60">
									Bluesky's settings are where the password, the handle and the apps signed in to
									the identity are managed.
								</p>
								<a
									className="btn btn-sm w-fit"
									href="https://bsky.app/settings"
									target="_blank"
									rel="noreferrer"
								>
									Open Bluesky settings
								</a>
							</>
						) : (
							<p className="text-sm text-base-content/60">
								Manage it at that server: the credential, the handle and everything stored in the
								identity belong to it rather than to Anthers.
							</p>
						)}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Setting, or changing, the password on an identity Anthers hosts.
 *
 * 🚨 **The node's reset is the only honest way to do this**, because Anthers does not have the
 * credential to change: `updateAccountPassword` needs a session Anthers may not have and the
 * server has no authenticated "set a new one" for a third party. The emailed token is proof that
 * the person controls the address on the account, which is exactly the proof a reset should need.
 *
 * ⭐ **The password never reaches Anthers' database.** It arrives in one request, is validated by
 * the shared rule, and is used for two calls to the node: the reset, and the session that lets
 * Anthers keep writing the person's records. What the row keeps is that session.
 */
function HostedPasswordForm({ handle }: { handle: string }) {
	const [phase, setPhase] = useState<"idle" | "sent" | "done">("idle");
	const [token, setToken] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const askForCode = useCallback(async () => {
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			const res = await client.api.atproto.password.reset.request.$post();
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? "Couldn't send a code. Please try again.");
				return;
			}
			setPhase("sent");
			setNotice("A code is on its way to the address on your identity.");
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
		} finally {
			setBusy(false);
		}
	}, []);

	const save = useCallback(async () => {
		const problem = passwordProblem(password, { handle });
		if (problem) {
			setError(problem);
			return;
		}
		if (!token.trim()) {
			setError("Enter the code from the email.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.atproto.password.reset.complete.$post({
				json: { token: token.trim(), password },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setError(body.error ?? "That code didn't work. Ask for a new one.");
				return;
			}
			setToken("");
			setPassword("");
			setPhase("done");
			setNotice(null);
		} catch {
			setError("Couldn't reach Anthers. Please try again.");
		} finally {
			setBusy(false);
		}
	}, [handle, password, token]);

	if (phase === "done") {
		return (
			<div className="mt-3">
				<p className="text-sm text-base-content/60">
					Your password is set. Sign in to Bluesky with{" "}
					<strong className="break-all">@{handle}</strong> and this password — Anthers keeps a
					session for your records, not a copy of the password.
				</p>
				<button
					type="button"
					className="btn btn-sm mt-3 w-fit"
					onClick={() => {
						setPhase("idle");
						setNotice(null);
					}}
				>
					Change it again
				</button>
			</div>
		);
	}

	return (
		<div className="mt-3">
			<p className="text-sm text-base-content/60">
				{phase === "idle"
					? `Set or change the password for @${handle}. It works in Bluesky and anywhere else this identity signs in — Anthers keeps a session, not a copy. We'll email a code to the address on the identity first.`
					: "Enter the code from the email, and choose a password."}
			</p>

			{phase === "sent" && (
				<div className="mt-3 space-y-3">
					<label className="label px-0 pb-1" htmlFor="identity-reset-token">
						<span className="text-sm font-semibold">The code from the email</span>
					</label>
					<input
						id="identity-reset-token"
						type="text"
						autoComplete="one-time-code"
						spellCheck={false}
						className="input input-bordered w-full"
						value={token}
						onChange={(e) => {
							setToken(e.target.value);
							setError(null);
						}}
					/>
					<label className="label px-0 pb-1" htmlFor="identity-reset-password">
						<span className="text-sm font-semibold">New password</span>
					</label>
					<input
						id="identity-reset-password"
						type="password"
						autoComplete="new-password"
						minLength={MIN_PASSWORD_LENGTH}
						className="input input-bordered w-full"
						value={password}
						onChange={(e) => {
							setPassword(e.target.value);
							setError(null);
						}}
					/>
					<p className="text-xs leading-tight text-base-content/50">
						At least {MIN_PASSWORD_LENGTH} characters.
					</p>
				</div>
			)}

			{error && <p className="mt-3 text-sm text-error">{error}</p>}
			{notice && <p className="mt-3 text-sm text-base-content/60">{notice}</p>}

			<div className="mt-3 flex items-center gap-2">
				{phase === "idle" ? (
					<button
						type="button"
						className={`btn btn-sm w-fit ${busy ? "btn-disabled" : ""}`}
						onClick={() => void askForCode()}
						disabled={busy}
					>
						{busy ? "Sending…" : "Email me a code"}
					</button>
				) : (
					<>
						<button
							type="button"
							className={`btn btn-primary btn-sm w-fit ${busy ? "btn-disabled" : ""}`}
							onClick={() => void save()}
							disabled={busy}
						>
							{busy ? "Setting…" : "Set my password"}
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm w-fit"
							onClick={() => void askForCode()}
							disabled={busy}
						>
							Send a new code
						</button>
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
								: user.creatorMode
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
						{publishing === "ungranted" && user.creatorMode && state.offered && (
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
 * nothing about what Anthers publishes into it — that is the Studio's publishing card. The
 * framing has drifted onto pages it did not belong on before, so the copy stays here.
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
		collaborations: {
			label: "Collaborations",
			hint: "Somebody invited you to co-own a Badge, or asked you to take its publisher role.",
		},
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
													, and {p.worksWithdrawn} withdrawn rather than destroyed because somebody
													has {p.worksWithdrawn === 1 ? "it" : "them"} in their Library; a saved
													Work outlives the account that made it
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
 * The account settings are grouped into tabs by subject, navigated from the sidebar
 * since 2026-11-06. The tab is carried in the URL as `?tab=` so a link can point somebody
 * at the right one.
 *
 * ⭐ **Badges and Purchases are two tabs since 2026-11-06** (Parker). They shared one tab
 * from 2026-10-23, and the split is the starting point for working through the cards, the
 * layout of the cycle record and the bugs each half carries on its own. Badges is the
 * standing relationship; Purchases is the one-time receipts. Both sit between Experience
 * and Identity.
 *
 * ⭐ **Experience is the appearance-and-playback tab** (Parker, 2026-11-06): the
 * starting tab, the per-browser media preferences, the miniplayer and the keyboard chords
 * are all "how the app feels to use", not facts about the account. The theme is not here —
 * it lives in the signed-in topbar as the same dropdown the marketing shell carries
 * (Parker, 2026-11-13). **Parents** is its own
 * tab at the end because a guardian's controls are written by somebody other than the
 * account holder and deserve to be findable without reading the safety filters first.
 *
 * ⭐ **Time is its own tab below Purchases** (Parker, 2026-11-12): the Time Pool and the
 * activity record it divides by are one subject, and the Badges tab no longer carries a
 * pool table beside its Badge charges.
 */
type SettingsTab =
	| "account"
	| "experience"
	| "badges"
	| "purchases"
	| "time"
	| "identity"
	| "content"
	| "activity"
	| "parents";

const TAB_LABELS: { id: SettingsTab; label: string }[] = [
	{ id: "account", label: "Account" },
	{ id: "experience", label: "Experience" },
	{ id: "badges", label: "Badges" },
	{ id: "purchases", label: "Purchases" },
	{ id: "time", label: "Time" },
	{ id: "identity", label: "Identity & Devices" },
	{ id: "content", label: "Content & Safety" },
	{ id: "activity", label: "Activity & Data" },
	{ id: "parents", label: "Parents" },
];

/**
 * The Time tab's two cards share one month.
 *
 * ⭐ **The state lives here rather than in either card** (Parker, 2026-11-12): the Time Pool
 * breakdown and the Activity Details record below it have to describe the same period, so
 * one control above both is what keeps them from drifting apart. The pool card owns the
 * selector; the activity card receives the result.
 */
function TimeSection() {
	const [cycle, setCycle] = useState(currentCycleKey());
	return (
		<>
			<TimePoolSection cycle={cycle} onCycleChange={setCycle} />
			<ActivityDetailsSection cycle={cycle} />
		</>
	);
}

function isSettingsTab(value: string | null): value is SettingsTab {
	return TAB_LABELS.some((t) => t.id === value);
}

export default function SettingsPage() {
	const { user, refreshUser, grantPublishing } = useAuth();
	const { setPageContent } = useSidebar();
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
		() => settingsParams.get("creator") === "1" && !user?.creatorMode,
	);

	const [creatorMode, setIsCreator] = useState(user?.creatorMode || false);
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

	const selectTab = useCallback(
		(id: SettingsTab) => {
			setSettingsParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					next.set("tab", id);
					return next;
				},
				{ replace: true },
			);
		},
		[setSettingsParams],
	);

	/**
	 * The section list is the sidebar's middle content, the same slot the Library gives its
	 * Lenses (Parker, 2026-11-06). Registering it here rather than rendering a tab row in the
	 * page keeps one navigation vocabulary for the whole signed-in shell, and the page's
	 * content column stays for the settings themselves.
	 */
	useEffect(() => {
		setPageContent(<SettingsSidebar active={activeTab} onSelect={selectTab} />);
		return () => setPageContent(null);
	}, [activeTab, selectTab, setPageContent]);

	const handleCreatorToggle = async (checked: boolean) => {
		setIsCreator(checked);
		setSaving(true);
		setError(null);
		setSuccess(false);

		try {
			const res = await apiFetch("/api/accounts/me", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ creatorMode: checked }),
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

			{visitedTabs.has("account") && (
				<div hidden={activeTab !== "account"}>
					{/* Who this browser is signed in as, and the button that ends it. The header
					    no longer carries an account menu; the sidebar is the door to Settings and
					    both settings pages carry the end of the session. */}
					<SignedInAccountCard className="mb-6" />

					{/* The Discord connection, under the card that says who this is — the two
					    answer "who am I here" and "where else am I known". */}
					<DiscordCard className="mb-6" />

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
										checked={creatorMode}
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

					{/* The one saved payment method — the card and its billing address, read-only
					    everywhere except this page and the Adult control. */}
					<PaymentInfoSection />
				</div>
			)}

			{visitedTabs.has("experience") && (
				<div hidden={activeTab !== "experience"}>
					{/* How the app behaves: the starting tab, the per-browser playback
					    preferences, where audio lives, the chords, and the Music Player lens's
					    own scope. The theme picker is not a settings row — it lives in the
					    topbar (Parker, 2026-11-13).

					    Where a session starts: one tab, chosen here rather than by the nav's
					    arrangement, which is fixed. */}
					<StartingTabSection />

					{/* The per-install playback preferences — the feed-tile preview stop *Your
					    Feed* promises, among the other remembered-by-browser settings. */}
					<MediaPlaySection />

					{/* The account-level playback preference — where audio lives: the
					    persistent footer bar or the page's own player. */}
					<MiniPlayerSection />

					{/* The Music Player lens's scope, moved off the lens's sidebar row. */}
					<MusicPlayerSection />

					{/* The topbar's two chords. Defaults for everybody, rebindable per account. */}
					<KeyboardShortcutsSection />
				</div>
			)}

			{visitedTabs.has("badges") && (
				<div hidden={activeTab !== "badges"}>
					{/* The standing relationship: the Badges this account holds, the cycle's
					    accounting record and the supporters list. Purchases is its own tab
					    beside this one since 2026-11-06. */}
					<BadgesSection />
				</div>
			)}

			{visitedTabs.has("purchases") && (
				<div hidden={activeTab !== "purchases"}>
					{/* The one-time receipts — what this account has bought, and its orders. */}
					<PurchasesSection />
				</div>
			)}

			{visitedTabs.has("time") && (
				<div hidden={activeTab !== "time"}>
					{/* The Time Pool breakdown and the activity record it divides by, sharing one
					    month. Moved off the Badges tab and out of Activity & Data on 2026-11-12. */}
					<TimeSection />
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
					{/* What the user meets at each rung, as two cards: the ratings and the flags. */}
					<RatingControlsSection />
					<ContentControlsSection />

					{/* The reader's own hide lists — the two *Don't Show* rows on a Discovery
					    tile, and the only route back to a hidden entry. */}
					<HiddenFromDiscoverySection />

					{/* Blocked Accounts — the only place a block can be lifted, since a blocked
					    profile no longer resolves. */}
					<BlockedSection />
				</div>
			)}

			{visitedTabs.has("parents") && (
				<div hidden={activeTab !== "parents"}>
					{/* The guardian's pin and the five things it protects. A tab of its own because
					    it is written by somebody other than the account holder (Parker, 2026-11-06). */}
					<ParentalControlsSection />
				</div>
			)}

			{visitedTabs.has("activity") && (
				<div hidden={activeTab !== "activity"}>
					{/* How each kind of notification reaches you — app, email, or both. First on
					    the tab, because it is the settings the most surfaces point at (the email
					    footers and the unsubscribe landing both name this page). */}
					<NotificationsSection />

					{/* Export and deletion — the controls Privacy Policy and /parents describe.
					    The attention record moved to the Time tab on 2026-11-12. */}
					<DataSection />
				</div>
			)}
		</div>
	);
}

/**
 * The settings sections, in the sidebar's middle slot.
 *
 * ⭐ **This replaced the row of tabs at the top of the page** (Parker, 2026-11-06): the rest
 * of the signed-in shell navigates from the sidebar, and a settings page whose sections were
 * a second horizontal nav read as a different application. The list is the page's to
 * register through `useSidebar`, so it exists only while Settings is mounted — the layout
 * owns the divider and the scroll region, exactly as it does for the Library's Lenses.
 */
function SettingsSidebar({
	active,
	onSelect,
}: {
	active: SettingsTab;
	onSelect: (id: SettingsTab) => void;
}) {
	return (
		<div
			role="tablist"
			aria-label="Settings sections"
			aria-orientation="vertical"
			className="flex flex-col gap-0.5"
		>
			{TAB_LABELS.map((tab) => (
				<button
					key={tab.id}
					type="button"
					role="tab"
					aria-selected={active === tab.id}
					className={sidebarRowClass(active === tab.id)}
					onClick={() => onSelect(tab.id)}
				>
					{tab.label}
				</button>
			))}
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
		previousRecipe: {
			label: "Previous recipe",
			hint: "Steps back through Discovery's recipes, wrapping from the first to the last.",
		},
		nextRecipe: {
			label: "Next recipe",
			hint: "Steps forward through Discovery's recipes, wrapping from the last to the first.",
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
