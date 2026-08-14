// SPDX-License-Identifier: AGPL-3.0-or-later
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { MeadowFloor } from "@anthers/web-shared/decor/MeadowFloor";
import { MeadowVines } from "@anthers/web-shared/decor/MeadowVines";
import { FONTS } from "@anthers/web-shared/fonts";
import { apiFetch } from "@anthers/web-shared/rpc";
import Logo from "@anthers/web-shared/ui/Logo";
import { type ReactNode, useEffect, useState } from "react";

const STORAGE_KEY = "anthers_site_access";
const INVITE_PARAM = "invite";

type Interest = "user" | "creator" | "both";
type SubmitState = "idle" | "submitting" | "success" | "error";

// Lift the invite key out of the URL and rewrite the address bar without it.
// The key is a shared secret we mail out in links, so it shouldn't linger where
// it can be screenshotted, bookmarked, or pasted back to someone else — it has
// done its job the moment we've read it. Runs at module load, before
// <BrowserRouter> mounts and reads location, so the router only ever sees the
// cleaned URL and the rest of the app can ignore the param entirely.
function takeInviteKeyFromUrl(): string | null {
	if (typeof location === "undefined") return null;
	const url = new URL(location.href);
	const key = url.searchParams.get(INVITE_PARAM);
	if (key === null) return null;
	url.searchParams.delete(INVITE_PARAM);
	history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
	return key;
}

const inviteKey = takeInviteKeyFromUrl();

async function redeemInviteKey(key: string): Promise<boolean> {
	try {
		const res = await apiFetch("/health/gate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ invite: key }),
		});
		return res.ok;
	} catch {
		return false;
	}
}

export default function SiteGate({ children }: { children: ReactNode }) {
	const [authorized, setAuthorized] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");
	// An invite key can only be checked by the server, so hold everything back
	// while that's in flight — rendering the gate first would flash the wall at
	// someone whose link is about to open it.
	const [redeeming, setRedeeming] = useState(() => !authorized && inviteKey !== null);
	const [inviteRejected, setInviteRejected] = useState(false);

	useEffect(() => {
		if (!redeeming || inviteKey === null) return;
		let cancelled = false;
		redeemInviteKey(inviteKey).then((ok) => {
			if (cancelled) return;
			// A redeemed key writes the same flag the password does, so the visitor
			// stays in on later visits without the link.
			if (ok) {
				localStorage.setItem(STORAGE_KEY, "true");
				setAuthorized(true);
			} else {
				setInviteRejected(true);
			}
			setRedeeming(false);
		});
		return () => {
			cancelled = true;
		};
	}, [redeeming]);

	if (authorized) return <>{children}</>;
	if (redeeming) return null;
	return <SiteGatePanel onAuthorized={() => setAuthorized(true)} inviteRejected={inviteRejected} />;
}

// The pre-launch gate's presentation and its password/waitlist forms, kept
// self-contained so it can render in two places: as the wall (mounted by
// <SiteGate> above when unauthorized) and on its own /site-gate route, so the
// look can be tinkered with locally without clearing the anthers_site_access
// flag. `onAuthorized` fires only in the wall case — on the route it's a no-op.
export function SiteGatePanel({
	onAuthorized,
	inviteRejected,
}: {
	onAuthorized?: () => void;
	inviteRejected?: boolean;
}) {
	// Password bypass. Someone who arrived on a dead invite link was expecting to
	// be let in, so open the password field for them rather than making them hunt
	// for it behind the early-access link.
	const [showPassword, setShowPassword] = useState(!!inviteRejected);
	const [password, setPassword] = useState("");
	const [passwordError, setPasswordError] = useState(false);
	const [passwordLoading, setPasswordLoading] = useState(false);

	// Waitlist form
	const [email, setEmail] = useState("");
	const [interest, setInterest] = useState<Interest>("both");
	const [submitState, setSubmitState] = useState<SubmitState>("idle");

	const handlePasswordSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setPasswordLoading(true);
		setPasswordError(false);
		try {
			const res = await apiFetch("/health/gate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			if (res.ok) {
				localStorage.setItem(STORAGE_KEY, "true");
				onAuthorized?.();
			} else {
				setPasswordError(true);
			}
		} catch {
			setPasswordError(true);
		} finally {
			setPasswordLoading(false);
		}
	};

	const handleWaitlistSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSubmitState("submitting");
		try {
			const res = await apiFetch("/api/waitlist", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, interest }),
			});
			if (res.ok) {
				setSubmitState("success");
			} else {
				setSubmitState("error");
			}
		} catch {
			setSubmitState("error");
		}
	};

	return (
		// The pre-launch gate wears the same Meadow decor as the logged-out site.
		// `relative isolate` scopes the z-order. The panel is pinned to the viewport
		// (`h-dvh overflow-hidden`) with the grassy floor always a flex item at the
		// bottom. The content area (<MeadowDecor>) is the flex-1 middle and scrolls
		// INTERNALLY (overflow-y:auto) when the card is taller than the space above the
		// grass — so on small phones / short windows the card scrolls with the grass
		// staying put, and on roomy screens the card just centers (my-auto) with no
		// scrollbar. MeadowDecor bakes in its own `min-h-screen`, overridden to
		// `minHeight: 0` (inline beats the class) so it fills only the flex-1 middle.
		//
		// z-order: the pollen sits at the back; the climbing side vines + drifting bees
		// ride a z-[5] layer above the pollen but BEHIND the card (z-10) so no bees land
		// on the card; the grassy floor (z-30) caps the very bottom, in front of it all.
		<div
			className="relative isolate flex h-dvh flex-col overflow-hidden"
			style={{ fontFamily: FONTS.nunito }}
		>
			<MeadowDecor
				floor={false}
				className="flex flex-1 flex-col [&>div]:my-auto"
				style={{ minHeight: 0, overflowX: "hidden", overflowY: "auto" }}
			>
				{/* Hero content. MeadowDecor centers its content wrapper with auto margins
					(the `[&>div]:my-auto` above): it sits centered when it fits the space
					above the grass (desktop, tall phones) and top-aligns + scrolls when it
					doesn't (small phones, short windows), with no clipped top. */}
				<div className="mx-auto w-full max-w-3xl px-4 py-6 text-center sm:py-2">
					{/* The logo sits on the bare pollen surface, above the card. The big top
						margin is desktop-only (it centers nicely there); on mobile the hero's
						own top padding handles the spacing. */}
					<div className="mb-6 flex justify-center sm:mt-8">
						<Logo variant="full" className="h-20 sm:h-28" />
					</div>

					{/* Everything below the logo lives in an off-white (base-200) card so it
						reads as a distinct panel above the pollen page surface (base-100). */}
					<div className="card border border-base-content/5 bg-base-200 shadow-lg">
						<div className="card-body gap-4 p-6 sm:p-10">
							{/* Intro copy */}
							<div>
								<p className="text-lg text-base-content/65 leading-relaxed mb-3 text-left sm:text-justify">
									<b>Anthers</b> is a non-profit creative garden for everyone: a peaceful place for
									videos, games, music, writing, crafts, services, and more, all on an open-source,
									ad-free platform.
								</p>

								{/* The middle two paragraphs are desktop-only (`hidden sm:block`): on phones
									we drop them so the gate stays short and the waitlist form is reachable
									with minimal scrolling. */}
								<div className="hidden sm:block">
									<p className="text-lg text-base-content/65 leading-relaxed mb-3 text-left sm:text-justify">
										No more intrusive advertisements or data brokers. No more manipulative
										algorithms. Just a harmonious ecosystem where we can all nurture a creative
										internet worth loving again.
									</p>

									<p className="text-lg text-base-content/65 leading-relaxed mb-3 text-left sm:text-justify">
										Supporting it all: a non-profit dedicated to lifting up new and marginalized
										creators; building honest, healthy connection between creators and their
										audiences without corporate interference or middlemen; and making great creative
										and educational content available to all, for free, forever.
									</p>
								</div>

								<p className="text-lg text-base-content/65 leading-relaxed mb-3 text-left sm:text-justify">
									We can make the creative internet a better place. <b>Let's do it together.</b>
								</p>
							</div>

							{/* Waitlist form */}
							{submitState === "success" ? (
								<div className="py-4">
									<p className="text-xl font-medium text-success">You're on the list.</p>
									<p className="text-base text-base-content/70 mt-2">
										We'll reach out when things are ready.
									</p>
								</div>
							) : (
								<form onSubmit={handleWaitlistSubmit} className="flex flex-col gap-4">
									<p className="text-base text-base-content/50">
										We're excited to share Anthers with you but aren't quite ready yet. Leave your
										email and we'll let you know when we're ready for you.
									</p>

									{/* Email input */}
									<input
										type="email"
										required
										className="input input-bordered w-full"
										placeholder="you@example.com"
										value={email}
										onChange={(e) => {
											setEmail(e.target.value);
											if (submitState === "error") setSubmitState("idle");
										}}
									/>

									{/* Interest toggle */}
									<fieldset className="flex flex-col gap-1.5">
										<legend className="text-sm text-base-content/60 text-left">
											I'm interested as a...
										</legend>
										<div className="join w-full">
											{(
												[
													["user", "User"],
													["creator", "Creator"],
													["both", "Both"],
												] as const
											).map(([value, label]) => (
												<button
													key={value}
													type="button"
													className={`join-item btn flex-1 ${
														interest === value
															? "btn-secondary"
															: "btn-ghost border-base-content/20"
													}`}
													onClick={() => setInterest(value)}
												>
													{label}
												</button>
											))}
										</div>
									</fieldset>

									{submitState === "error" && (
										<p className="text-error text-base">Something went wrong. Please try again.</p>
									)}

									<button
										type="submit"
										className="btn btn-primary w-2/3 self-center"
										disabled={submitState === "submitting"}
									>
										{submitState === "submitting" ? "Submitting..." : "Keep Me Posted"}
									</button>
								</form>
							)}

							{/* Password bypass link */}
							<div>
								{inviteRejected && (
									<p className="mb-3 text-sm text-warning">That early-access link isn't valid.</p>
								)}
								{showPassword ? (
									<form onSubmit={handlePasswordSubmit} className="flex gap-2 max-w-xs mx-auto">
										<input
											type="password"
											className={`input input-bordered input-sm flex-1 ${passwordError ? "input-error" : ""}`}
											placeholder="Password"
											value={password}
											onChange={(e) => {
												setPassword(e.target.value);
												setPasswordError(false);
											}}
											autoFocus
										/>
										<button
											type="submit"
											className="btn btn-ghost btn-sm"
											disabled={passwordLoading}
										>
											{passwordLoading ? "..." : "Enter"}
										</button>
									</form>
								) : (
									<button
										type="button"
										className="mt-2 text-xs text-base-content/40 hover:text-base-content/90 transition-colors"
										onClick={() => setShowPassword(true)}
									>
										Click Here for Early Access (Password Required)
									</button>
								)}
							</div>
						</div>
					</div>
				</div>
			</MeadowDecor>

			{/* Climbing side vines + drifting bees spanning the whole gate. Wrapped in a
				z-[5] layer so they sit above the pollen but BEHIND the card (z-10) — the
				gate's card is narrow, so bees would otherwise drift over its text. The
				gate opts into showing vines from lg (narrow content); the marketing shell
				keeps the default xl to avoid crowding its wider text. */}
			<div className="pointer-events-none absolute inset-0 z-[5]">
				<MeadowVines from="lg" />
			</div>

			{/* The grassy meadow the gate ends on, same as every logged-out page — a
				slightly shorter band here so the single-viewport panel fits standard
				monitors without scrolling. */}
			<MeadowFloor heightClass="h-36" />
		</div>
	);
}
