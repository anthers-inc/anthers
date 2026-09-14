// SPDX-License-Identifier: Apache-2.0
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
 * **A signup that is written down is resumable.** The pending account holds the picks and the
 * handle it reserved, so pressing the button and walking away costs nothing for a week: come
 * back in this browser and the cookie finds it, come back in another and a code sent to the
 * address finds it, come back through Bluesky and the identity finds it. 🚨 What resumption is
 * never gated on is *naming* an address or a handle, and a Bluesky identity never crosses on an
 * address proof — it is proved again here — see `services/pending-signups.ts`, which carries the
 * takeover that closes.
 *
 * 🚨 **An account is created only with its identity**, so this page has an identity step: shown
 * whenever the signup holds neither a Bluesky identity nor a requested handle, which is what a
 * signup resumed from a Bluesky start looks like in a new browser, and what a refusal at the last
 * step (a name the node would not issue, an identity that already has an account) leaves behind.
 *
 * ⚠️ **This page must not become a second signup door.** the *Making an Account* page's rule is a prohibition on a
 * second place *in the UI that mints accounts*, and a page reachable only by already having
 * a pending signup is a continuation of the one door rather than a rival to it. That is a
 * property of the guard below, not of the URL: somebody who navigates here directly with no
 * pending record is sent to `/subscribe`, and there is deliberately no way to start one from
 * this page.
 */

import anthersMark from "@anthers/brand/logo/web/mark-60.png";
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
import {
	BlueskyHandleField,
	FIELD_BUTTON_GAP,
	HostedHandleField,
	hostedNameSubmittable,
} from "../components/auth/HandleFields";
import SignupSteps, { signupSteps } from "../components/onboarding/SignupSteps";
import SubscriptionPaymentModal, {
	type SubscriptionPreview,
} from "../components/subscribe/SubscriptionPaymentModal";
import { useHandleAvailability } from "../lib/hosted-handle";

const serif = { fontFamily: FONTS.fraunces };

/** What `GET /api/auth/signup/pending` says about the signup this browser is finishing. */
interface Pending {
	email: string | null;
	/** Whether a code has actually gone out to that address — never merely that we hold one. */
	codeSent: boolean;
	addressProved: boolean;
	/** The Bluesky handle of an identity proved in this browser. */
	atprotoHandle: string | null;
	/** The Bluesky handle a signup was started with, when it has to be proved again here. */
	blueskyHint: string | null;
	/** The handle Anthers has been asked to issue, in full, and held until `expiresAt`. */
	hostedHandle: string | null;
	picks: SignupPicks;
	next: string;
	expiresAt: string;
}

/** What `/signup/verify` and `/signup/complete` answer when a signup cannot be finished yet. */
interface Refusal {
	error: string;
	reason?: string;
	pending?: Pending | null;
}

/**
 * Which of the page's faces is showing.
 *
 * `identity` comes first whenever the signup holds no identity to create its account with.
 * `address` is asked for only when there is none — a Bluesky signup whose PDS refused the
 * email scope, or one whose owner wants to correct a typo. `code` is the ordinary case.
 * `resumed` is the one that needs no code at all, because the address is already proved — at
 * `/login` in another browser, or by a code whose signup could not be finished at the time —
 * and asking again would be asking somebody to prove the same fact twice.
 */
type Face = "loading" | "identity" | "address" | "code" | "resumed";

/**
 * Which face a pending signup calls for.
 *
 * 🚨 **`codeSent` is the discriminator, not `email`, and getting that wrong shipped a page
 * that lied.** The Bluesky door arrives here holding an address nobody has mailed: the PDS
 * supplies it at the OAuth callback, which is *after* the only place that sends a first code.
 * Choosing on `email` alone rendered "we sent a six-character code to …" for an address
 * nothing had been sent to, and left the person waiting on mail that was never coming.
 * Holding an address and having posted to it are different facts.
 *
 * Exported because it is the whole of the bug, and a pure function is the only part of this
 * page a unit test can reach.
 */
export function faceFor(pending: {
	email: string | null;
	codeSent: boolean;
	addressProved: boolean;
	atprotoHandle: string | null;
	hostedHandle: string | null;
}): Exclude<Face, "loading"> {
	if (!pending.atprotoHandle && !pending.hostedHandle) return "identity";
	if (pending.addressProved) return "resumed";
	return pending.email && pending.codeSent ? "code" : "address";
}

export default function FinishSignupPage() {
	const { user, isLoading, refreshUser, signUpWithBluesky } = useAuth();
	const navigate = useNavigate();

	const [pending, setPending] = useState<Pending | null>(null);
	const [face, setFace] = useState<Face>("loading");
	const [email, setEmail] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The identity step's fields, the same two `/subscribe` offers. */
	const [hostedName, setHostedName] = useState("");
	const [hostedRefusal, setHostedRefusal] = useState<string | null>(null);
	const [hostedOpen, setHostedOpen] = useState(false);
	const [hostedSuffix, setHostedSuffix] = useState("");
	const [blueskyHandle, setBlueskyHandle] = useState("");
	const [blueskyRefusal, setBlueskyRefusal] = useState<string | null>(null);
	const hostedStatus = useHandleAvailability(hostedName, {
		open: hostedOpen,
		suffix: hostedSuffix,
	});
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
		/*
		 * 🚨 **Both requests are awaited before this page becomes interactive, and the creator
		 * list is the one that matters.** A pick is stored as a username and the charge needs
		 * the creator's id, so the list is what turns one into the other — and a page that
		 * accepted a code while it was still in flight would either quote support it then
		 * failed to bill, or bill support it never showed. `/subscribe` carries the same
		 * hazard in a milder form (a pick made before the list loaded was quotable and
		 * unbillable); here the whole charge is assembled in one turn, so it is closed by
		 * waiting rather than by reconciling afterwards.
		 */
		Promise.all([
			client.api.auth.signup.pending.$get().then((res) => res.json()),
			client.api.accounts.creators
				.$get()
				.then((res) => res.json())
				.then((data) => data.creators as PublicUser[])
				// A creator list that will not load is not a reason to strand somebody mid-signup:
				// the account is still worth making, and an unresolvable pick simply is not billed.
				.catch(() => [] as PublicUser[]),
		])
			.then(([{ pending: row }, list]) => {
				if (!live) return;
				if (!row) {
					// ⚠️ **The guard that keeps this from being an entry point.** There is nothing
					// to finish, so there is nowhere to be but the page that starts one.
					navigate("/subscribe", { replace: true });
					return;
				}
				setCreators(list);
				setPending(row as Pending);
				// Prefilled either way. When the PDS gave us an address, this is the whole
				// value of having asked for it: the field arrives filled in and one press
				// sends the code.
				setEmail(row.email ?? "");
				setBlueskyHandle(row.blueskyHint ?? "");
				setFace(faceFor(row as Pending));
			})
			.catch(() => {
				if (live) setError("We couldn't pick up your signup. Please try again.");
			});
		return () => {
			live = false;
		};
	}, [isLoading, user, navigate]);

	// Whether Anthers can issue a handle here, and the suffix it hangs under — for the identity
	// step, which offers the same two doors `/subscribe` does.
	useEffect(() => {
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then(({ hostedIdentityOffered, hostedHandleSuffix }) => {
				if (!live) return;
				setHostedOpen(hostedIdentityOffered);
				setHostedSuffix(hostedHandleSuffix);
			})
			.catch(() => {
				/* Unreachable API: the Anthers field stays closed, and Bluesky needs no answer. */
			});
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

	/**
	 * The signup could not be finished yet, and the server has said what it now looks like.
	 *
	 * ⚠️ **The code was right, so this is not an error in the code box.** The address is proved
	 * and the signup is waiting on its identity — chosen again, proved again, or tried again once
	 * Anthers' server answers — and the page moves to the face that asks for exactly that.
	 */
	const refused = useCallback((body: Refusal) => {
		setError(body.error);
		if (body.pending) {
			setPending(body.pending);
			setFace(faceFor(body.pending));
		}
		setBusy(false);
	}, []);

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
				const body = (await res.json().catch(() => ({}))) as Refusal;
				// A refusal that carries the signup back is about the identity, not the code.
				if (body.reason && body.pending !== undefined) {
					refused(body);
					return;
				}
				throw new Error(body.error ?? "That code didn't work. Check it, or ask for a new one.");
			}
			await accountMade((await res.json()) as Parameters<typeof accountMade>[0]);
		},
		[accountMade, email, pending?.email, refused],
	);

	const finishResumed = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await client.api.auth.signup.complete.$post();
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as Partial<Refusal>;
				refused({
					error: body.error ?? "We couldn't finish that signup. Start again from the signup page.",
					pending: body.pending,
				});
				return;
			}
			await accountMade((await res.json()) as Parameters<typeof accountMade>[0]);
		} catch {
			setError("Something went wrong. Please try again.");
			setBusy(false);
		}
	};

	/**
	 * Choose, or change, the handle Anthers issues for this signup — reserving it — and move on.
	 *
	 * ⚠️ A name taken or held for somebody else is refused in the field's own status line, so the
	 * step does not grow and the person can type another straight away.
	 */
	const chooseHostedHandle = async () => {
		const name = hostedName.trim().replace(/^@/, "");
		if (!name) return;
		setBusy(true);
		setHostedRefusal(null);
		setError(null);
		try {
			const res = await client.api.auth.signup.identity.$post({ json: { hostedHandle: name } });
			const body = (await res.json().catch(() => ({}))) as {
				error?: string;
				pending?: Pending | null;
			};
			if (!res.ok || !body.pending) {
				setHostedRefusal(body.error ?? "Couldn't hold that handle. Please try again.");
				return;
			}
			setPending(body.pending);
			setFace(faceFor(body.pending));
		} catch {
			setHostedRefusal("Couldn't reach Anthers. Please try again.");
		} finally {
			setBusy(false);
		}
	};

	/**
	 * Prove a Bluesky identity in this browser. The round trip binds it to this signup at the
	 * callback and comes back to this page, which then finishes without asking for another code
	 * when the address is already proved.
	 */
	const continueWithBluesky = async () => {
		const value = blueskyHandle.trim().replace(/^@/, "");
		if (!value) return;
		setBusy(true);
		setBlueskyRefusal(null);
		try {
			await signUpWithBluesky(value, next);
		} catch (err) {
			setBlueskyRefusal(
				err instanceof Error ? err.message : "Couldn't reach Bluesky. Please try again.",
			);
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

	/**
	 * Whether the address in the field is one the PDS handed us rather than one they typed.
	 *
	 * ⚠️ Read off the pending record rather than off the field, because the field is state the
	 * person can edit — the moment they change it, the copy explaining where it came from is
	 * describing something that is no longer there.
	 */
	const prefilledFromBluesky =
		!!pending.atprotoHandle && !!pending.email && email === pending.email;

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
			title={
				face === "identity"
					? "Choose how you'll be known"
					: face === "resumed"
						? "Pick up where you left off"
						: "Confirm your email"
			}
		>
			{/* 🚨 Why an email field is in front of somebody who just authenticated somewhere
			    else. Without this the page reads as a flow that forgot what it was doing —
			    which is how a signup gets abandoned three steps in. */}
			{pending.atprotoHandle && face !== "resumed" && (
				<div className="mt-6 flex items-start gap-3 rounded-xl bg-base-200 p-4 text-left">
					<BlueskyMark className="mt-0.5 h-5 w-5 shrink-0" />
					<p className="text-sm text-base-content/70">
						Bluesky confirmed you as <strong className="break-all">@{pending.atprotoHandle}</strong>
						. Anthers still needs an email address it can reach you at, for receipts and account
						notices — every account is confirmed by a code we send, including this one.
					</p>
				</div>
			)}

			{/* ⭐ **The same job as the Bluesky panel above, from the other direction.** That one
			    explains why an email field is in front of somebody who just authenticated
			    elsewhere; this one explains why it is in front of somebody who only asked for a
			    name — and says the name is being held, so confirming later is safe. */}
			{pending.hostedHandle && (face === "address" || face === "code") && (
				<div className="mt-6 flex items-start gap-3 rounded-xl bg-base-200 p-4 text-left">
					<img src={anthersMark} alt="" className="mt-0.5 h-5 w-auto shrink-0" />
					<p className="text-sm text-base-content/70">
						<strong className="break-all">@{pending.hostedHandle}</strong> is held for you until{" "}
						{heldUntil(pending.expiresAt)}. It becomes yours once you confirm your email below.
					</p>
				</div>
			)}

			{face === "identity" && (
				<IdentityStep
					blueskyHint={pending.blueskyHint}
					hostedOpen={hostedOpen}
					busy={busy}
					hosted={
						<form
							className="text-left"
							onSubmit={(e) => {
								e.preventDefault();
								void chooseHostedHandle();
							}}
						>
							<HostedHandleField
								id="finish-hosted"
								label="A new handle on Anthers"
								name={hostedName}
								onNameChange={(value) => {
									setHostedName(value);
									setHostedRefusal(null);
								}}
								status={hostedStatus}
								suffix={hostedSuffix}
								refusal={hostedRefusal}
							/>
							<button
								type="submit"
								className={`btn btn-primary ${FIELD_BUTTON_GAP} w-full ${busy ? "btn-disabled" : ""}`}
								disabled={
									busy || !!hostedRefusal || !hostedNameSubmittable(hostedName, hostedStatus)
								}
							>
								Use This Handle
							</button>
						</form>
					}
					bluesky={
						<form
							className="text-left"
							onSubmit={(e) => {
								e.preventDefault();
								void continueWithBluesky();
							}}
						>
							<BlueskyHandleField
								id="finish-bluesky"
								label="Your Bluesky identity"
								value={blueskyHandle}
								onChange={(value) => {
									setBlueskyHandle(value);
									setBlueskyRefusal(null);
								}}
								refusal={blueskyRefusal}
							/>
							<button
								type="submit"
								className={`btn btn-primary ${FIELD_BUTTON_GAP} w-full ${busy ? "btn-disabled" : ""}`}
								disabled={busy || !blueskyHandle.trim()}
							>
								Continue with Bluesky
							</button>
						</form>
					}
				/>
			)}

			{face === "address" && (
				<form
					className="mt-6"
					onSubmit={(e) => {
						e.preventDefault();
						void sendCode();
					}}
				>
					{/* ⭐ **The label says where a prefilled address came from.** An address that
					    appears in a field by itself, on a page you reached by authorizing somewhere
					    else, reads as something the site already knew about you rather than
					    something it was just handed — and the whole reason for asking Bluesky was
					    to save this typing, which only works if the person trusts what they see. */}
					<label className="label px-0 pb-1" htmlFor="finish-email">
						<span className="text-sm font-semibold">
							{prefilledFromBluesky ? "Is this the right address?" : "Where should we reach you?"}
						</span>
					</label>
					<input
						id="finish-email"
						type="email"
						required
						autoComplete="email"
						// biome-ignore lint/a11y/noAutofocus: this step's one field, so arriving here is the intent to fill it in.
						autoFocus
						placeholder="you@example.com"
						className="input input-bordered w-full"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
					{prefilledFromBluesky && (
						<p className="mt-2 text-xs leading-relaxed text-base-content/50">
							Bluesky gave us this one. Change it if you would rather we used another — the code is
							what confirms it either way.
						</p>
					)}
					<button
						type="submit"
						className={`btn btn-primary btn-lg mt-4 w-full ${busy ? "btn-disabled" : ""}`}
						disabled={busy}
					>
						{busy
							? "Sending…"
							: prefilledFromBluesky
								? "Send a code to this address"
								: "Send me a code"}
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

			{/* 🚨 **The identity is shown before anything is created, and that is a security
			    property rather than a courtesy.** A signup resumed by address may carry a handle
			    somebody else typed; asking for it to be confirmed or changed here is what stops a
			    stranger naming the person whose mailbox this is. */}
			{face === "resumed" && (
				<div className="mt-6">
					<p className="text-base leading-relaxed text-base-content/65">
						Your address is confirmed and your choices are still here. Your account will be created
						as{" "}
						<strong className="break-all">@{pending.atprotoHandle ?? pending.hostedHandle}</strong>.
					</p>
					<button
						type="button"
						className={`btn btn-primary btn-lg mt-5 w-full ${busy ? "btn-disabled" : ""}`}
						onClick={() => void finishResumed()}
						disabled={busy}
					>
						{busy ? "Working…" : "Create My Account"}
					</button>
					<button
						type="button"
						className="mt-3 link text-sm text-base-content/60"
						onClick={() => {
							setError(null);
							setFace("identity");
						}}
					>
						Use a different identity
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

/** The day a held handle is released, said the way a person would say it. */
function heldUntil(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

/**
 * The identity step: a handle Anthers issues, or a Bluesky identity proved in this browser.
 *
 * ⚠️ **A signup started with Bluesky leads with Bluesky**, and says which identity it was started
 * as, because that is the one the person most likely wants to continue with — and a stranger's
 * identity named here tells the real owner of the mailbox that somebody else began this signup.
 */
function IdentityStep({
	blueskyHint,
	hostedOpen,
	busy,
	hosted,
	bluesky,
}: {
	blueskyHint: string | null;
	hostedOpen: boolean;
	busy: boolean;
	hosted: React.ReactNode;
	bluesky: React.ReactNode;
}) {
	return (
		<div className="mt-6 space-y-6" aria-busy={busy}>
			<p className="text-base leading-relaxed text-base-content/65">
				{blueskyHint ? (
					<>
						This signup was started as <strong className="break-all">@{blueskyHint}</strong>. Sign
						in with Bluesky here to confirm it's you, or take a handle on Anthers instead.
					</>
				) : (
					"Every Anthers account is an identity on the AT Protocol network. Take a new handle on Anthers, or use the Bluesky identity you already have."
				)}
			</p>
			{blueskyHint ? (
				<>
					{bluesky}
					{hostedOpen && hosted}
				</>
			) : (
				<>
					{hostedOpen && hosted}
					{bluesky}
				</>
			)}
		</div>
	);
}
