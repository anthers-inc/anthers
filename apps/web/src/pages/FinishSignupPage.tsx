// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Finishing a signup (route: `/finish`) — the page whose whole job is finishing.
 *
 * 🚨 **It exists because of what the old arrangement read like from the outside.** Signing
 * up used to end where it began: a modal over `/subscribe`, on a page still inviting you to
 * add and drop picks behind it. Through the Bluesky door that was worse — you left for
 * bsky.social, came back to `/subscribe`, and were apparently asked to sign up again with no
 * sign that anything had succeeded. Parker walked it on 2026-08-25 and could not tell
 * whether it had worked.
 *
 * Two things make this better than a modal, and both come from the same move.
 *
 * **The next thing asked of somebody is the only thing in front of them.** `/subscribe` is
 * where the choices get made; pressing *Create My Account* writes them down and brings the
 * person here, where there is nothing to reconsider and one thing to do.
 *
 * **A signup that is written down is resumable.** The pending account holds the picks, so
 * pressing the button and walking away costs nothing: come back in this browser and the
 * cookie finds it, come back in another and a code sent to the address finds it, come back
 * through Bluesky and the identity finds it. 🚨 What resumption is never gated on is
 * *naming* an address or a handle — see `services/pending-signups.ts`, which carries the
 * takeover that closes.
 *
 * ⚠️ **This page must not become a second signup door.** 40.10's rule is a prohibition on a
 * second place *in the UI that mints accounts*, and a page reachable only by already having
 * a pending signup is a continuation of the one door rather than a rival to it. That is a
 * property of the guard below, not of the URL: somebody who navigates here directly with no
 * pending record is sent to `/subscribe`, and there is deliberately no way to start one from
 * this page.
 */

import { amountLabel, PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { EMPTY_PICKS, type SignupPicks, supportTotal } from "@anthers/shared/signup";
import { useAuth } from "@anthers/web-shared/auth";
import { FONTS } from "@anthers/web-shared/fonts";
import { useNavigate } from "@anthers/web-shared/router";
import { client } from "@anthers/web-shared/rpc";
import type { PublicUser } from "@anthers/web-shared/types";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useCallback, useEffect, useRef, useState } from "react";
import BlueskyMark from "../components/auth/BlueskyMark";
import EmailCodeForm from "../components/auth/EmailCodeForm";
import SignupSteps, { signupSteps } from "../components/onboarding/SignupSteps";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../components/subscribe/SubscriptionPaymentModal";

const serif = { fontFamily: FONTS.fraunces };

/** What `GET /api/auth/signup/pending` says about the signup this browser is finishing. */
interface Pending {
	email: string | null;
	addressProved: boolean;
	atprotoHandle: string | null;
	picks: SignupPicks;
	next: string;
}

/**
 * Which of the page's three faces is showing.
 *
 * `address` is asked for only when there is none — a Bluesky signup whose PDS refused the
 * email scope, or one whose owner wants to correct a typo. `code` is the ordinary case.
 * `resumed` is the one that needs no code at all, because the address was proved at `/login`
 * in another browser and asking again would be asking somebody to prove the same fact twice.
 */
type Face = "loading" | "address" | "code" | "resumed";

export default function FinishSignupPage() {
	const { user, isLoading, refreshUser } = useAuth();
	const navigate = useNavigate();

	const [pending, setPending] = useState<Pending | null>(null);
	const [face, setFace] = useState<Face>("loading");
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [creators, setCreators] = useState<PublicUser[]>([]);
	const [charge, setCharge] = useState<{
		anthersSupport: number;
		directed: { creatorId: number; amount: number }[];
		badgeName: string;
		preview: SubscriptionPreview;
	} | null>(null);

	/**
	 * What the account that just came into existence still owes, and where it was headed.
	 *
	 * Refs rather than state because `commit` reads them in the same turn it sets them — a
	 * state update would not have landed, and the account would be left on this page instead
	 * of being sent to onboarding. The same shape `/subscribe` uses, for the same reason.
	 */
	const owedOnboarding = useRef(false);
	const destination = useRef<string | null>(null);

	// ── What this browser is finishing ───────────────────────────────────────
	useEffect(() => {
		if (isLoading) return;

		// 🚨 Somebody already signed in has nothing to finish here. An account that still owes
		// a handle goes to onboarding rather than being shown a code box for an address it has
		// already proved — which is what a reload after verifying looks like.
		if (user) {
			navigate(user.username ? "/" : "/welcome", { replace: true });
			return;
		}

		let live = true;
		client.api.auth.signup.pending
			.$get()
			.then((res) => res.json())
			.then(({ pending: row }) => {
				if (!live) return;
				if (!row) {
					// ⚠️ **The guard that keeps this from being an entry point.** There is nothing
					// to finish, so there is nowhere to be but the page that starts one.
					navigate("/subscribe", { replace: true });
					return;
				}
				setPending(row as Pending);
				setEmail(row.email ?? "");
				setFace(row.addressProved ? "resumed" : row.email ? "code" : "address");
			})
			.catch(() => {
				if (live) setError("We couldn't pick up your signup. Please try again.");
			});
		return () => {
			live = false;
		};
	}, [isLoading, user, navigate]);

	// The creator list, for naming the picks and for the ids the charge needs. Same source
	// `/subscribe` reads; a pick made against a creator this never returns is quotable and
	// unbillable, which is why the charge is built from the intersection rather than the picks.
	useEffect(() => {
		let live = true;
		client.api.accounts.creators
			.$get()
			.then((res) => res.json())
			.then((data) => {
				if (live) setCreators(data.creators as PublicUser[]);
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, []);

	const picks = pending?.picks ?? EMPTY_PICKS;
	const next = sanitizeNextPath(pending?.next || undefined);

	const byUsername = new Map(creators.map((c) => [c.username, c]));
	/**
	 * 🚨 **One list, and the charge and the summary are both built from it.** `/subscribe`
	 * derived what it displayed and what it billed by two routes until 2026-08-16 and quoted
	 * $9 while charging $1. This page shows a total too, so it inherits the rule rather than
	 * the defect.
	 */
	const directed = picks.seed
		.map((username) => byUsername.get(username))
		.filter((creator): creator is PublicUser => !!creator)
		.map((creator) => ({ creatorId: creator.id, amount: PUBLIC_ACCESS_PRICE }));
	const total = supportTotal(picks.anthers, directed);

	/**
	 * Tell the auth context, then go.
	 *
	 * 🚨 **Refreshing the context is what unmounts this page, so it must be the LAST thing.**
	 * `PublicShell` returns a different component type for a signed-in visitor, so the moment
	 * `refreshUser()` resolves React tears this subtree down. `/subscribe` paid for that
	 * lesson with a payment modal that never opened.
	 */
	const leave = useCallback(
		async (path: string) => {
			await refreshUser();
			navigate(path, { replace: true });
		},
		[navigate, refreshUser],
	);

	/**
	 * The account exists and this browser holds a session. Commit what was chosen.
	 *
	 * Following costs nothing, so it is applied straight away rather than waiting on a charge
	 * that may not even happen. Support opens the same confirmation ceremony the inline post
	 * unlock uses — one ceremony, so a charge is described identically wherever it is agreed
	 * to.
	 */
	const commit = useCallback(
		async (result: { picks: SignupPicks | null; next: string | null }) => {
			const chosen = result.picks ?? picks;
			const landing = sanitizeNextPath(result.next ?? undefined) ?? next;
			destination.current = landing;

			const chosenDirected = chosen.seed
				.map((username) => byUsername.get(username))
				.filter((creator): creator is PublicUser => !!creator)
				.map((creator) => ({ creatorId: creator.id, amount: PUBLIC_ACCESS_PRICE }));
			const chosenTotal = supportTotal(chosen.anthers, chosenDirected);

			for (const username of chosen.follow) {
				const creator = byUsername.get(username);
				if (!creator || creator.isFollowing) continue;
				await client.api.accounts.users[":username"].follow.$post({ param: { username } });
			}

			if (chosenTotal === 0) {
				await leave(withNextPath("/welcome", landing));
				return;
			}

			const res = await client.api.subscriptions.preview[":amount"].$get({
				param: { amount: String(chosenTotal) },
			});
			if (!res.ok) {
				// The account is made and signed in, so this is not a failed signup — it is a
				// charge that could not be quoted. Onboarding is still owed either way, and the
				// support can be added from `/subscription` afterwards.
				setError("We couldn't load the charge details — you can add support from Settings.");
				await leave(withNextPath("/welcome", landing));
				return;
			}
			const preview = (await res.json()) as { isCancel: false } & SubscriptionPreview;
			setCharge({
				anthersSupport: chosen.anthers,
				directed: chosenDirected,
				// The honest label is the amount: a commit needn't land on a Badge, and naming
				// one would describe only the Anthers half of this charge.
				badgeName: `${amountLabel(chosenTotal)} a month`,
				preview,
			});
		},
		[byUsername, leave, next, picks],
	);

	/** Shared by the code path and the resumed path: an account now exists. */
	const accountMade = useCallback(
		async (result: {
			needsOnboarding: boolean;
			picks: SignupPicks | null;
			next: string | null;
		}) => {
			owedOnboarding.current = result.needsOnboarding;
			await commit(result);
		},
		[commit],
	);

	// ── Asking for an address ────────────────────────────────────────────────
	const sendCode = async () => {
		const address = email.trim();
		if (!address) {
			setError("Add an email address so we can confirm it's you.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			// Answers 200 whatever happened, deliberately — see the route. So there is nothing
			// to branch on, and the field opens either way.
			await client.api.auth.signup.start.$post({ json: { email: address } });
			setPending((prev) => (prev ? { ...prev, email: address } : prev));
			setFace("code");
		} catch {
			setError("Couldn't send the code. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	const verifyCode = useCallback(
		async (code: string) => {
			const address = pending?.email ?? email.trim();
			const res = await client.api.auth.signup.verify.$post({ json: { email: address, code } });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? "That code didn't work. Check it, or ask for a new one.");
			}
			await accountMade((await res.json()) as Parameters<typeof accountMade>[0]);
		},
		[accountMade, email, pending?.email],
	);

	const finishResumed = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.signup.complete.$post();
			if (!res.ok) {
				setError("We couldn't finish that signup. Start again from the signup page.");
				setBusy(false);
				return;
			}
			await accountMade((await res.json()) as Parameters<typeof accountMade>[0]);
		} catch {
			setError("Something went wrong. Please try again.");
			setBusy(false);
		}
	};

	const abandon = async () => {
		await client.api.auth.signup.cancel.$post().catch(() => {});
		navigate("/subscribe", { replace: true });
	};

	if (face === "loading" || !pending) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<div className="text-center">
					<LoadingSpinner size="lg" />
					<p className="mt-4 text-sm text-base-content/60">Picking up your signup…</p>
				</div>
			</div>
		);
	}

	const steps = signupSteps({
		bluesky: pending.atprotoHandle ? "done" : null,
		address: "current",
		payment: total > 0 ? "todo" : null,
		username: "todo",
	});

	return (
		<SignupSteps
			steps={steps}
			eyebrow="Almost There"
			title={face === "resumed" ? "Pick up where you left off" : "Confirm your email"}
		>
			{/* 🚨 Why an email field is in front of somebody who just authenticated somewhere
			    else. Without this the page reads as a flow that forgot what it was doing —
			    which is how a signup gets abandoned three steps in. */}
			{pending.atprotoHandle && (
				<div className="mt-6 flex items-start gap-3 rounded-xl bg-base-200 p-4 text-left">
					<BlueskyMark className="mt-0.5 h-5 w-5 shrink-0" />
					<p className="text-sm text-base-content/70">
						Bluesky confirmed you as <strong className="break-all">@{pending.atprotoHandle}</strong>
						. Anthers still needs an email address it can reach you at, for receipts and account
						notices — every account is confirmed by a code we send, including this one.
					</p>
				</div>
			)}

			{face === "address" && (
				<form
					className="mt-6"
					onSubmit={(e) => {
						e.preventDefault();
						void sendCode();
					}}
				>
					<label className="label px-0 pb-1" htmlFor="finish-email">
						<span className="text-sm font-semibold">Where should we reach you?</span>
					</label>
					<input
						id="finish-email"
						type="email"
						required
						autoComplete="email"
						autoFocus
						placeholder="you@example.com"
						className="input input-bordered w-full"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
					<button
						type="submit"
						className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
						disabled={busy}
					>
						{busy ? "Sending…" : "Send me a code"}
					</button>
				</form>
			)}

			{face === "code" && (
				<div className="mt-6">
					<p className="mb-5 text-base leading-relaxed text-base-content/65">
						We sent a six-character code to <strong className="break-all">{pending.email}</strong>.
						Enter it and your account is made.
					</p>
					<EmailCodeForm
						cta="Confirm my email"
						busyLabel="Checking…"
						onSubmit={verifyCode}
						onResend={async () => {
							await client.api.auth.signup.start.$post({
								json: { email: pending.email as string },
							});
						}}
						secondary={{ label: "Use a different address", onClick: () => setFace("address") }}
					/>
				</div>
			)}

			{face === "resumed" && (
				<div className="mt-6">
					<p className="text-base leading-relaxed text-base-content/65">
						Your address is confirmed and your choices are still here. One press and the account is
						yours.
					</p>
					<button
						type="button"
						className={`btn btn-primary btn-lg mt-5 w-full ${busy ? "btn-disabled" : ""}`}
						onClick={() => void finishResumed()}
						disabled={busy}
					>
						{busy ? "Working…" : "Create my account"}
					</button>
				</div>
			)}

			{error && <p className="mt-4 text-sm text-error">{error}</p>}

			<ChosenSummary picks={picks} byUsername={byUsername} total={total} />

			<button
				type="button"
				className="mt-6 link text-xs text-base-content/40"
				onClick={() => void abandon()}
			>
				Start over
			</button>

			{charge && (
				<SubscriptionPaymentModal
					anthersSupport={charge.anthersSupport}
					directed={charge.directed}
					badgeName={charge.badgeName}
					preview={charge.preview}
					onComplete={() => {
						setCharge(null);
						// A brand-new account owes a handle before anything else, including before
						// the page that would show off the support it just bought — which is a poor
						// place to discover you have no profile.
						void leave(
							owedOnboarding.current
								? withNextPath("/welcome", destination.current)
								: (destination.current ?? "/subscription"),
						);
					}}
					onClose={() => {
						setCharge(null);
						// The card was declined or dismissed — but the account exists and is signed
						// in, because confirming the address made it. That is the correct outcome and
						// takes no unwinding: they have a free account, and the only thing still owed
						// is the handle.
						void leave(
							owedOnboarding.current
								? withNextPath("/welcome", destination.current)
								: (destination.current ?? "/"),
						);
					}}
				/>
			)}
		</SignupSteps>
	);
}

/**
 * What is waiting on the other side of the code — the picks, read back.
 *
 * ⭐ **This is the other half of the fix.** Getting somebody off `/subscribe` means their
 * choices are no longer in front of them, and a page that asked for a code while saying
 * nothing about what it was for would have traded one kind of disorientation for another.
 * It is a summary and not a control: changing a pick is what *Start over* is for, because a
 * page that can be edited is a page that invites reconsidering at the last step.
 */
function ChosenSummary({
	picks,
	byUsername,
	total,
}: {
	picks: SignupPicks;
	byUsername: Map<string | null, PublicUser>;
	total: number;
}) {
	const nothing = picks.anthers === 0 && picks.follow.length === 0;
	if (nothing) {
		return (
			<p className="mt-8 border-t border-base-content/10 pt-6 text-sm leading-relaxed text-base-content/50">
				A free account, with nothing to pay. That is a complete answer — a free account still pays
				creators for the time you give them.
			</p>
		);
	}

	return (
		<div className="mt-8 border-t border-base-content/10 pt-6">
			<h2 style={serif} className="text-lg font-light">
				What you chose
			</h2>
			<ul className="mt-3 space-y-2 text-sm">
				<li className="flex items-baseline gap-3">
					<span className="min-w-0">
						Your Anthers account
						<span className="block text-xs text-base-content/45">
							{picks.anthers > 0
								? "unlimited Public Access, and support for free access"
								: `${amountLabel(0)} — ten hours of Public Access a month`}
						</span>
					</span>
					<strong className="ml-auto shrink-0 tabular-nums">
						{picks.anthers > 0 ? amountLabel(picks.anthers) : "Free"}
					</strong>
				</li>
				{picks.follow.map((username) => {
					const creator = byUsername.get(username);
					const backing = picks.seed.includes(username);
					return (
						<li key={username} className="flex items-baseline gap-3">
							<span className="min-w-0">
								{creator?.displayName || creator?.username || username}
								<span className="block text-xs text-base-content/45">
									{backing ? "following · supporting" : "following"}
								</span>
							</span>
							<strong className="ml-auto shrink-0 tabular-nums">
								{backing ? amountLabel(PUBLIC_ACCESS_PRICE) : "Free"}
							</strong>
						</li>
					);
				})}
			</ul>
			<p className="mt-4 flex items-baseline gap-3 border-t border-base-content/10 pt-3 text-sm font-semibold">
				<span>A month</span>
				<span className="ml-auto tabular-nums">{total > 0 ? amountLabel(total) : "Free"}</span>
			</p>
		</div>
	);
}
