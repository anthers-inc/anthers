// SPDX-License-Identifier: Apache-2.0

import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { client } from "@anthers/web-shared/rpc";
import FormField from "@anthers/web-shared/ui/FormField";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import EmailCodeModal from "../components/auth/EmailCodeModal";
import { mergeIntoServerBasket } from "../lib/basket";

/**
 * The shape of an address, loosely — enough to tell "alice" from "alice@example.com".
 *
 * Deliberately not a validating regex: the server's `z.string().email()` is the ruling
 * check and this only has to answer *"is the person trying to give us an email at all?"*,
 * because the email and handle branches below need different things from them. Anything
 * that gets past this and fails at the API comes back as an ordinary refusal.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether what was typed reads as a handle rather than an address.
 *
 * The same loose philosophy as `LOOKS_LIKE_EMAIL`: this is a routing question — *which
 * door does the typed thing belong to?* — not a validation one. It is reached only with
 * something that is not an Anthers handle (the hosted-suffix check in `handleSubmit` runs
 * first), so the only thing this has to recognize is a domain-shaped string
 * (`alice.bsky.social`, `example.com`). A handle that doesn't resolve is refused by the
 * ATProto flow itself, in its own words.
 */
const LOOKS_LIKE_HANDLE = /^@?[a-z0-9.-]+\.[a-z0-9-]+$/i;

/**
 * Signing in to an account that already exists (route: `/login`). Nothing else.
 *
 * 🚨 **This was `AuthPage`, a card that toggled between logging in and a four-field
 * Create Account form, and the form is GONE (2026-08-17).** There is one signup door now
 * and it is `/signup` — an identity (an Anthers handle or Bluesky), then an email address
 * and a code at `/finish`, then `/welcome` for the first-run. `/subscribe` redirects there —
 * it is the same page's old URL, kept resolving because links already sent out name it. The old card asked for a username + email +
 * password + confirm before an account existed at all, which is the cost this platform
 * decided not to charge at the moment of decision; keeping it alive as a second door
 * meant two flows that had to agree about terms acceptance, onboarding and where a new
 * account lands, and they had already drifted.
 *
 * So: **do not add a signup form here.** If this page needs a way onward for someone
 * without an account, it is a link to `/signup`.
 *
 * 🚨 **Sign-in is the emailed code, or the account's own identity brought back through
 * OAuth — nothing else (Parker, 2026-09-13; handle routing Parker, 2026-10-09).** No
 * account holds a password, so there is no password field on this page and no route it
 * could post to. The one form asks for an identifier and routes on what it is:
 * - An **email address** posts to **`/auth/signin/start`, never `/auth/signup/*`**, keyed
 *   on the address. The difference is the whole point: the signup pair *creates an
 *   account* for an address it doesn't know, which would make a mistyped address at the
 *   login page mint an account that never saw the terms. The signin pair refuses.
 * - An **Anthers handle** — one ending in the suffix Anthers' own node reports, like
 *   `janedoe.anthers.social` — posts the same start route keyed on the handle, and the
 *   route resolves it to the mailbox the holder gave at signup: the code lands in their
 *   inbox with every throttle the address path already has. The resolution is
 *   server-side, and the browser never learns the address — it spends the code keyed on
 *   the handle, and `/signin/verify` re-resolves the same way.
 * - Any **other handle** — a Bluesky handle most of all — takes the OAuth door.
 *
 * The old objection to resolving handles to mailboxes stands for every handle Anthers
 * did not issue: a public handle is never turned into an address by Anthers' machinery,
 * because guessing one to trigger mail at its holder is a door this page should not make
 * quiet. What the hosted case deliberately accepts is that handles are public — a typist
 * can trigger one throttle-limited email to a hosted account without knowing its
 * mailbox — and the per-IP send limit plus the per-address resend throttle are what
 * bound that. The start route answers byte-identically either way, so there is nothing
 * to enumerate in the response.
 *
 * 🚨 **Bluesky OAuth is a way IN and not a way to sign up** (2026-08-22). It signs in an
 * account whose identity is a Bluesky one, resumes an unfinished signup started with that
 * identity, and answers `signup_disabled` for a handle no account holds rather than
 * minting anything. That refusal is the whole reason the affordance can live on this page
 * at all: the only people it works for are people who signed up with Bluesky.
 *
 * ⚠️ **One field decides all three routes, so there is no second button** (2026-10-09). The
 * separate "Log in with Bluesky" button and its modal are gone — a person who thinks of this
 * page as "where I type my identifier" and a person who scans for a button are one person
 * again, and what they type is the only thing the page had ever routed on anyway.
 *
 * 🚨 **The card's height is decoration, and it is load-bearing decoration.** The botanical
 * flourishes are positioned against the card box and each spray reaches roughly seven rems
 * in from its corner, so the empty space above and below the centered content is what keeps
 * a leaf off the buttons. Two rules follow: the height is a **minimum**, because a card that
 * cannot grow spills its content the moment a form gains an error line; and anything added
 * to the card body has to be paid for in height, at twice its own, since the content is
 * centered.
 */
export default function LoginPage() {
	const { signInWithBluesky, refreshUser } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();

	// Where to land after auth: an explicit ?next=, else the route that bounced us
	// here (ProtectedRoute stashes it in location.state.from), else the feed.
	//
	// ⚠️ Both go through `sanitizeNextPath`. The `?next=` half read the parameter raw
	// until 2026-08-17, which is an open redirect waiting for someone to swap `navigate()`
	// for `location.assign()`; `state.from` is set by our own router and is checked anyway,
	// because "this one is ours" is the assumption that stops being true first.
	const nextParam = sanitizeNextPath(new URLSearchParams(location.search).get("next"));
	const from = sanitizeNextPath(
		(location.state as { from?: { pathname: string } })?.from?.pathname,
	);
	const redirectTo = nextParam || from || "/feed";

	/** Whatever was typed — an address or a handle; the routing below decides which. */
	const [identifier, setIdentifier] = useState("");

	/**
	 * The suffix a hosted handle hangs under, as the session's node reports it.
	 *
	 * Learned from `/api/atproto/config` and never hard-coded: it is `anthers.social` in
	 * production and `.test` on a local network, and a second copy of that answer is how
	 * an Anthers handle starts getting handed to the wrong door. Null means "not asked
	 * yet" and "" means "the node did not answer" — either way the hosted-suffix check
	 * below matches nothing and every handle falls through to the OAuth door, which is
	 * where every handle went before this page knew about suffixes at all.
	 */
	const [hostedSuffix, setHostedSuffix] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then((body) => {
				if (live) setHostedSuffix(body.hostedHandleSuffix ?? "");
			})
			.catch(() => {
				if (live) setHostedSuffix("");
			});
		return () => {
			live = false;
		};
	}, []);

	/** Where a code was just sent and how the browser will spend it, or null when none is in flight. */
	const [sentCode, setSentCode] = useState<{
		/** What the modal shows: the address typed, or the handle the code was asked for. */
		shown: string;
		/** The keys the verify route spends it by — the handle for a hosted-handle sign-in. */
		verify: { email: string } | { handle: string };
	} | null>(null);

	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);

	/**
	 * The suspension interstitial, set when the code verifies but the account is
	 * suspended. The holder has just proved the mailbox — the strongest telling
	 * available — so the card itself becomes the notice rather than a generic failure.
	 * State rather than a route: a suspended account is never signed in, so nothing
	 * protects a `/suspended` page, and the thing being told is bound to this attempt.
	 */
	const [suspended, setSuspended] = useState<{ until: string | null } | null>(null);

	/** Ask for a code, keyed on an address or on the handle the route resolves. Answers the same whatever it found. */
	const sendCode = useCallback(async (target: { email: string } | { handle: string }) => {
		const res = await client.api.auth.signin.start.$post({ json: target });
		if (!res.ok) throw new Error("That doesn't look like an address or handle we can reach.");
	}, []);

	/**
	 * Route the typed identifier — one field, three ways in.
	 *
	 * An address gets the emailed code keyed on the address; a handle ending in the
	 * hosted suffix gets the same emailed code, keyed on the handle for the route to
	 * resolve; any other handle is handed to Bluesky OAuth, which never resolves in any
	 * useful sense since it sets `window.location` and the page is already leaving when
	 * it succeeds. Anything shaped like neither is asked for here, in the page's own
	 * words rather than the browser's — the same reason the input is `type="text"`.
	 *
	 * ⚠️ **The hosted-suffix check runs before the shape check**, because an Anthers
	 * handle is domain-shaped too and would otherwise take the Bluesky door. The suffix
	 * may be unknown (config not loaded) or empty (the node is down), and then every
	 * handle falls through to OAuth — which is where all handles went before this page
	 * routed on the suffix, and a wrong guess there is refused in the flow's own words.
	 */
	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrors({});
		const typed = identifier.trim();

		if (LOOKS_LIKE_EMAIL.test(typed)) {
			setLoading(true);
			try {
				await sendCode({ email: typed });
				setSentCode({ shown: typed, verify: { email: typed } });
			} catch (err) {
				setErrors({
					general: err instanceof Error ? err.message : "Couldn't send the code. Please try again.",
				});
			} finally {
				setLoading(false);
			}
			return;
		}

		// A handle, however it was written — the leading `@` is how people write one, not
		// part of it.
		const handle = typed.replace(/^@/, "");

		if (hostedSuffix && handle.toLocaleLowerCase().endsWith(`.${hostedSuffix}`)) {
			setLoading(true);
			try {
				await sendCode({ handle });
				setSentCode({ shown: `@${handle}`, verify: { handle } });
			} catch (err) {
				setErrors({
					general: err instanceof Error ? err.message : "Couldn't send the code. Please try again.",
				});
			} finally {
				setLoading(false);
			}
			return;
		}

		if (LOOKS_LIKE_HANDLE.test(typed)) {
			// The OAuth flow. Its refusals (`signInWithBluesky` throws its message into
			// the field below) are the page's own words for a handle that leads nowhere.
			setLoading(true);
			try {
				await signInWithBluesky(handle, redirectTo);
			} catch (err) {
				setErrors({
					general: err instanceof Error ? err.message : "Couldn't reach Bluesky. Please try again.",
				});
				setLoading(false);
			}
			return;
		}

		setErrors({
			general: "Sign in with the email address or the handle on your account.",
		});
	};

	/**
	 * Spend the code.
	 *
	 * Throws on refusal — `EmailCodeModal` shows the message in the field and clears the
	 * boxes. On success the session cookie is already set, so the only thing left is to
	 * tell the auth context and go.
	 *
	 * ⚠️ **Refreshing the context is the LAST thing, because it unmounts this page.**
	 * `/login` renders inside `PublicShell`, which returns `LoggedOutLayout` or
	 * `LoggedInLayout` by auth state — different component types, so React tears the
	 * subtree down the moment `refreshUser()` resolves. That cost a real bug on
	 * `/signup`, where work queued after the refresh landed on an unmounted component
	 * and simply never happened. Nothing may follow the `navigate` below.
	 */
	const verifyCode = useCallback(
		async (code: string) => {
			if (!sentCode) return;
			const res = await client.api.auth.signin.verify.$post({
				json: { ...sentCode.verify, code },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
					reason?: string;
					suspendedUntil?: string | null;
				};
				// The code proved the mailbox and the account is suspended: the answer is
				// the truth, told here, rather than a failure thrown back into the code field.
				if (body.reason === "account_suspended") {
					setSentCode(null);
					setSuspended({ until: body.suspendedUntil ?? null });
					return;
				}
				throw new Error(body.error ?? "That code didn't work. Check it, or ask for a new one.");
			}
			const body = (await res.json()) as { resume: boolean; needsOnboarding?: boolean };

			setSentCode(null);

			// 🚨 **A signup somebody started elsewhere and never finished, and this door still
			// created nothing.** The code proved the mailbox, which is the only thing
			// resumption may ever be gated on, so the server handed the pending signup to this
			// browser — and `/finish` is where it becomes an account, on the signup pair where
			// minting belongs. Deliberately no `refreshUser()`: nobody is signed in yet, and
			// there is nothing new for the context to learn.
			if (body.resume) {
				navigate("/finish", { replace: true });
				return;
			}

			// The anonymous scratch basket folds into the account's server-side basket now
			// — before the context refresh tears this subtree down (see the warning below:
			// NOTHING may be queued after `refreshUser()`). A failed merge keeps the scratch
			// for a later attempt; the buyer's filled basket is never dropped to a blip.
			await mergeIntoServerBasket().catch(() => {});

			await refreshUser();
			// An account that never finished onboarding still owes the terms, so this door
			// has to be able to land there. Where they were heading rides along, exactly as
			// it does through the signup ceremony.
			navigate(body.needsOnboarding ? withNextPath("/welcome", nextParam || from) : redirectTo, {
				replace: true,
			});
		},
		[sentCode, from, navigate, nextParam, redirectTo, refreshUser],
	);

	const resendCode = useCallback(async () => {
		if (sentCode) await sendCode(sentCode.verify);
	}, [sendCode, sentCode]);

	return (
		// Center the card in the main content area. flex-1 fills <main> (which is a
		// flex column), so the card centers between header and footer regardless of
		// viewport height — percentage heights can't do this because the layout's
		// outer container uses min-h-screen (indefinite) rather than a fixed height.
		<div className="flex flex-1 items-center justify-center px-4 py-10">
			{/* Positioning context sized to the card, so the botanical corner flourishes
				can be placed around it. */}
			<div className="relative w-full max-w-md">
				{/* Botanical leaf flourishes bracketing the card's four corners — one asset
					rotated to each corner, so it frames the card without distortion. Purely
					decorative (pointer-events-none) and theme-reactive via currentColor;
					hidden on the smallest screens where they'd crowd the edges. */}
				{[
					{ corner: "-top-9 -left-9", rot: 0 },
					{ corner: "-top-9 -right-9", rot: 90 },
					{ corner: "-bottom-9 -right-9", rot: 180 },
					{ corner: "-bottom-9 -left-9", rot: 270 },
				].map(({ corner, rot }) => (
					<BrandGlyph
						key={rot}
						name="corner-leafy"
						className={`pointer-events-none absolute z-20 hidden h-36 w-36 text-primary/70 sm:block ${corner}`}
						style={{ transform: `rotate(${rot}deg)` }}
					/>
				))}
				<div
					data-auth-fade
					className="card relative z-10 min-h-[38rem] w-full bg-base-200 shadow-lg"
				>
					<div className="card-body justify-center">
						{suspended ? (
							/* The suspension interstitial. The code just proved the mailbox, so this
							   is the strongest telling there is — the card becomes the notice.
							   What it deliberately does not do is word a suspension as anything
							   the account did itself (the 51.02 wording rule), and it names the
							   appeal the moderation email already pointed at. */
							<>
								<h1 className="card-title justify-center text-2xl">Account Suspended</h1>
								<div className="text-center text-sm text-base-content/80 space-y-3">
									<p>
										Anthers has suspended this account
										{suspended.until
											? ` until ${new Date(suspended.until).toLocaleDateString(undefined, { dateStyle: "long" })}`
											: ""}
										. While suspended you can't sign in, and your presence and works aren't shown
										publicly.
									</p>
									<p>
										We emailed the reason to you. If you believe this is a mistake, reply to that
										email to appeal.
									</p>
								</div>
								<Link to="/" className="btn btn-primary w-full mt-4">
									Back to Anthers
								</Link>
							</>
						) : (
							<>
								<h1 className="card-title justify-center text-2xl">Log In</h1>
								{/* Sign-up prompt sits at the top of the card (YNAB-style). Plain div, not
						    <p>, so DaisyUI's card-body `p { flex-grow: 1 }` doesn't balloon it and
						    shove the form down. It is a LINK now rather than a mode toggle — the
						    card it used to flip to no longer exists.

						    ⚠️ **"Sign up free", matching the navbar** (2026-08-22). This is the door
						    somebody without an account is most likely to arrive at by mistake — they
						    came to log in and cannot — so it is the second-best place after the
						    navbar to say that joining costs nothing. The destination page states the
						    monthly Public Access limit in the same breath, per the wiki's *How Anthers Talks About Itself*. */}
								<div className="text-center text-sm text-base-content/70">
									New to Anthers?{" "}
									<Link to="/signup" className="link link-primary">
										Sign up free
									</Link>
								</div>
								{errors.general && (
									<div className="alert alert-error text-sm mt-2">
										<span>{errors.general}</span>
									</div>
								)}
								<form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-1" noValidate>
									<FormField
										label="Email (jane@doe.com) or Handle (@janedoe.anthers.social)"
										hint="Enter your email or Anthers handle to sign in with an emailed code. Enter your Bluesky handle to sign in with OAuth."
									>
										{/* 🚨 `type="text"`, and that is load-bearing: the browser's built-in
								    email validation would fire *before* React sees the submit and say
								    "please include an '@' in the email address", which is a message about
								    syntax on a page whose real answer is about what signing in *is*. The
								    loose shape checks in `handleSubmit` are the ones whose sentences show.

								    ⚠️ `inputMode` follows the `@` (2026-10-09): the moment the value starts
								    with one, the person is typing a handle, and the keyboard suits it —
								    dots and letters instead of the email address's autocompletions. It is
								    a keyboard answer, not a routing one: what was typed still routes on
								    submit, exactly as it always did. */}
										<input
											type="text"
											inputMode={identifier.startsWith("@") ? "url" : "email"}
											className="input input-bordered w-full"
											autoComplete="username"
											value={identifier}
											onChange={(e) => setIdentifier(e.target.value)}
											required
										/>
									</FormField>
									<button type="submit" className="btn btn-primary w-full mt-3" disabled={loading}>
										{loading ? <span className="loading loading-spinner loading-sm" /> : "Continue"}
									</button>
								</form>
							</>
						)}
					</div>
				</div>
			</div>

			{sentCode && (
				<EmailCodeModal
					stepLabel="Sign in with an emailed code"
					lede={
						<>
							If there's an Anthers account for{" "}
							<strong className="break-all">{sentCode.shown}</strong>, a six-character code is on
							its way. Enter it and you're in.
						</>
					}
					cta="Sign me in"
					busyLabel="Checking…"
					onSubmit={verifyCode}
					onResend={resendCode}
					onClose={() => setSentCode(null)}
				/>
			)}
		</div>
	);
}
