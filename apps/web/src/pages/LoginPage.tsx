// SPDX-License-Identifier: Apache-2.0

import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { usePageTitle } from "@anthers/web-shared/page-title";
import { client } from "@anthers/web-shared/rpc";
import FormField from "@anthers/web-shared/ui/FormField";
import Logo from "@anthers/web-shared/ui/Logo";
import { AtSymbolIcon, EnvelopeIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import BlueskyMark from "../components/auth/BlueskyMark";
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
 * 🚨 **Sign-in is the identity's own credential: the password for an identity Anthers hosts, and
 * OAuth for one it does not (Parker, 2026-09-13; shape corrected 2026-10-26).** The split is the
 * hosting relationship, not the handle. Anthers is the first-party client of its own PDS, so a
 * hosted person types the password they chose here, it goes to `anthers.social` in one request,
 * and the session that answers is kept; there is no second host and no consent screen for a
 * relationship that is already first-party. A person whose identity lives somewhere else signs in
 * at that server through OAuth, because Anthers is a third-party client there and should not ask
 * for their password. The one form asks for an identifier and routes on what it is:
 * - An **email address or an Anthers handle** asks for the password and posts to
 *   **`/api/auth/login`**, never `/auth/signup/*`. The difference is the whole point: the signup
 *   pair *creates an account* for an address it doesn't know, which would make a mistyped address
 *   at the login page mint an account that never saw the terms.
 * - **A handle elsewhere** takes the OAuth door: the browser goes to that identity's own
 *   authorization server, which asks for whatever credential it holds and returns a grant.
 * - An email that belongs to a Bluesky identity fails on the password path, by design. The app
 *   cannot know which server holds an address without asking, and asking before a password is
 *   offered would turn this form into a directory; the refusal says to use the handle.
 *
 * 🚨 **The emailed code is recovery, not a login.** A person who cannot remember the password
 * resets it at the server that holds the identity: `anthers.social`'s own account page for a
 * hosted account, and Bluesky's for a Bluesky one. The link under the password field is that page,
 * and the URL is learned from `/api/atproto/config` rather than written here a second time.
 *
 * 🚨 **OAuth is a way IN and not a way to sign up** (2026-08-22). It signs in any account whose
 * identity resolves, resumes an unfinished signup started with that identity, and answers
 * `signup_disabled` for a handle no account holds rather than minting anything. That refusal is
 * the whole reason the affordance can live on this page at all.
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
	usePageTitle("Log In");
	const { signInWithBluesky, refreshUser } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();

	// Where to land after auth: an explicit ?next=, else the route that bounced us
	// here (ProtectedRoute stashes it in location.state.from), else the default order's
	// first tab, the Library.
	//
	// ⚠️ Both go through `sanitizeNextPath`. The `?next=` half read the parameter raw
	// until 2026-08-17, which is an open redirect waiting for someone to swap `navigate()`
	// for `location.assign()`; `state.from` is set by our own router and is checked anyway,
	// because "this one is ours" is the assumption that stops being true first.
	const nextParam = sanitizeNextPath(new URLSearchParams(location.search).get("next"));
	const from = sanitizeNextPath(
		(location.state as { from?: { pathname: string } })?.from?.pathname,
	);
	const redirectTo = nextParam || from || "/library";

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
	/** The identity server's own reset page, learned from the same answer. */
	const [hostedAccountUrl, setHostedAccountUrl] = useState("");

	useEffect(() => {
		let live = true;
		client.api.atproto.config
			.$get()
			.then((res) => res.json())
			.then((body) => {
				if (live) {
					setHostedSuffix(body.hostedHandleSuffix ?? "");
					setHostedAccountUrl(body.hostedAccountUrl ?? "");
				}
			})
			.catch(() => {
				if (live) setHostedSuffix("");
			});
		return () => {
			live = false;
		};
	}, []);

	/**
	 * What the person is typing, decided as they type it — this page's answer to Bluesky's
	 * auto-detect field.
	 *
	 * ⚠️ **Detection commits late, and that is the affordance.** A complete shape gets its
	 * own drawing — an envelope for an address, the butterfly for a Bluesky handle, a
	 * primary `@` for an Anthers handle — and anything still under construction leans email
	 * unless an `@` leads it, which is the half-formed state a handle-typist passes through
	 * and an address-typist never does. The butterfly is shown only for a *complete*
	 * foreign handle, never mid-word, so it never promises Bluesky to somebody who is only
	 * getting started on an Anthers one.
	 *
	 * ⚠️ **This is the same routing `handleSubmit` runs, derived rather than separated** — one
	 * order of checks, not two that could drift. The suffix may still be loading (null) or
	 * empty (the node is down), and then every handle reads bluesky-or-partial, which is
	 * where all handles were headed before this page knew about suffixes anyway.
	 */
	/**
	 * Whether the handle typed is one this node hosts, asked rather than inferred.
	 *
	 * 🚨 **A suffix test is not the question.** A hosted identity keeps the handle it brought,
	 * and a domain handle does not end in the suffix the node issues — so `anthers.org`, moved
	 * here from Bluesky, was sent down the OAuth door and told Bluesky was about to confirm it.
	 * The suffix still answers instantly for the handles this node issued; everything else asks
	 * the API, on a debounce, and only the answer decides.
	 */
	const [hostedLookup, setHostedLookup] = useState<{ handle: string; hosted: boolean } | null>(
		null,
	);

	useEffect(() => {
		const typed = identifier.trim();
		if (!typed || LOOKS_LIKE_EMAIL.test(typed)) return;
		if (!LOOKS_LIKE_HANDLE.test(typed)) return;
		const bare = typed.replace(/^@/, "").toLocaleLowerCase();
		if (hostedSuffix && bare.endsWith(`.${hostedSuffix}`)) return;

		let live = true;
		const timer = setTimeout(() => {
			client.api.auth["hosted-handle"]
				.$get({ query: { handle: bare } })
				.then((res) => res.json())
				.then((body) => {
					if (live) setHostedLookup({ handle: bare, hosted: body.hosted });
				})
				.catch(() => {
					if (live) setHostedLookup({ handle: bare, hosted: false });
				});
		}, 250);

		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [identifier, hostedSuffix]);

	/** The one answer both the drawing and the submit branch on. */
	const isHostedHandle = (bare: string): boolean =>
		Boolean(hostedSuffix && bare.endsWith(`.${hostedSuffix}`)) ||
		(hostedLookup?.handle === bare && hostedLookup.hosted);

	const trimmed = identifier.trim();
	const signinMode: "idle" | "email" | "handle" | "anthers" | "bluesky" = (() => {
		if (!trimmed) return "idle";
		if (LOOKS_LIKE_EMAIL.test(trimmed)) return "email";
		const bare = trimmed.replace(/^@/, "").toLocaleLowerCase();
		if (isHostedHandle(bare)) return "anthers";
		if (LOOKS_LIKE_HANDLE.test(trimmed)) return "bluesky";
		// A bare word is neither an address nor a handle; "handle" is the drawing and hint that
		// says to finish it, and the submit refuses it in the page's own words.
		return "handle";
	})();

	const SIGNIN_DRAWING = {
		idle: <EnvelopeIcon className="h-5 w-5" />,
		email: <EnvelopeIcon className="h-5 w-5" />,
		handle: <AtSymbolIcon className="h-5 w-5" />,
		anthers: <AtSymbolIcon className="h-5 w-5 text-primary" />,
		bluesky: <BlueskyMark className="h-4.5 w-4.5" />,
	} as const;

	const SIGNIN_HINT: Record<typeof signinMode, string> = {
		idle: "An Anthers handle or email signs in with its password; a Bluesky handle signs in through Bluesky.",
		email:
			"The password for this Anthers identity. A Bluesky identity signs in with its handle instead.",
		handle: "Keep typing the whole handle.",
		anthers: "Your identity's password, chosen when you signed up.",
		bluesky: "Your identity server confirms it's you, then brings you back.",
	};

	const [password, setPassword] = useState("");
	/** The emailed code, only when the node has asked for one. */
	const [authFactorToken, setAuthFactorToken] = useState("");
	const [twoFactor, setTwoFactor] = useState(false);

	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);

	/**
	 * The suspension interstitial, set when the identity signs in but the Anthers account is
	 * suspended. The password was right, so the card becomes the notice rather than a generic
	 * failure. State rather than a route: a suspended account is never signed in, so nothing
	 * protects a `/suspended` page, and the thing being told is bound to this attempt.
	 */
	const [suspended, setSuspended] = useState<{ until: string | null } | null>(null);

	/**
	 * Sign in, or hand the browser to the identity's own server.
	 *
	 * 🚨 **An Anthers handle or an email is a password sign-in; a handle elsewhere is OAuth.**
	 * The split is the hosting relationship. Anthers is the first-party client of its own PDS, so
	 * the password goes to `anthers.social` in one request and the session that answers is kept,
	 * exactly as Bluesky's own client does it. For an identity on somebody else's server Anthers
	 * is a third-party client, so it must not ask for the password; the browser goes to that
	 * server's authorization page.
	 *
	 * ⚠️ **An email that belongs to a Bluesky identity fails on the password path**, by design.
	 * The app cannot know which server holds an address without asking, and asking before a
	 * password is offered would turn this form into a directory. The message says so and points at
	 * the handle.
	 */
	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrors({});
		const typed = identifier.trim();

		if (signinMode === "email" || signinMode === "anthers") {
			if (!password) {
				setErrors({ general: "Enter your password." });
				return;
			}
			setLoading(true);
			try {
				const res = await client.api.auth.login.$post({
					json: {
						identifier: typed,
						password,
						...(twoFactor && authFactorToken.trim()
							? { authFactorToken: authFactorToken.trim() }
							: {}),
					},
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => ({}))) as {
						error?: string;
						reason?: string;
						twoFactor?: boolean;
						suspendedUntil?: string | null;
					};
					if (body.twoFactor) {
						setTwoFactor(true);
						setErrors({ general: body.error ?? "Enter the code sent to your email." });
						setLoading(false);
						return;
					}
					if (body.reason === "account_suspended") {
						setSuspended({ until: body.suspendedUntil ?? null });
						setLoading(false);
						return;
					}
					setErrors({ general: body.error ?? "That handle or password didn't work." });
					setLoading(false);
					return;
				}
				const body = (await res.json()) as { needsOnboarding: boolean };

				// 🚨 The basket fold and the context refresh are LAST, because the refresh
				// unmounts this page. Nothing may be queued after it.
				await mergeIntoServerBasket().catch(() => {});
				await refreshUser();
				navigate(body.needsOnboarding ? withNextPath("/welcome", nextParam || from) : redirectTo, {
					replace: true,
				});
			} catch {
				setErrors({ general: "Couldn't reach Anthers. Please try again." });
				setLoading(false);
			}
			return;
		}

		if (signinMode === "bluesky" && LOOKS_LIKE_HANDLE.test(typed)) {
			const handle = typed.replace(/^@/, "").toLocaleLowerCase();
			setLoading(true);
			try {
				await signInWithBluesky(handle, redirectTo);
			} catch (err) {
				setErrors({
					general:
						err instanceof Error
							? err.message
							: "Couldn't reach your identity server. Please try again.",
				});
				setLoading(false);
			}
			return;
		}

		setErrors({
			general: "Sign in with the email address or the handle on your account.",
		});
	};

	return (
		// Center the card in the main content area. flex-1 fills <main> (which is a
		// flex column), so the card centers between header and footer regardless of
		// viewport height — percentage heights can't do this because the layout's
		// outer container uses min-h-screen (indefinite) rather than a fixed height.
		<div className="flex flex-1 items-center justify-center px-4 py-10">
			{/* Positioning context sized to the card, so the botanical corner flourishes
				can be placed around it.
				
				⚠️ Back at `max-w-md` (2026-10-09, second pass): the widening to `max-w-lg`
				that the paragraph hint asked for is undone by the hint itself — the routing
				hints are now the short, live lines `signinMode` picks, and a 32rem card only
				ever showed off how little fills it. The flourishes are positioned against
				this container, so they move with it. */}
			<div className="relative w-full max-w-md">
				{/* Botanical leaf flourishes bracketing the card's four corners — one asset
					rotated to each corner, so it frames the card without distortion. Purely
					decorative (pointer-events-none) and theme-reactive via currentColor;
					hidden on the smallest screens where they'd crowd the edges.
					
					⚠️ One size smaller with shallower insets (2026-10-09), riding the card's
					height drop: the sprays reach about six rems in from each corner now, and
					the card's clearance below the topmost and above the lowest content must
					stay past that. If the card shrinks again, shrink these first. */}
				{[
					{ corner: "-top-8 -left-8", rot: 0 },
					{ corner: "-top-8 -right-8", rot: 90 },
					{ corner: "-bottom-8 -right-8", rot: 180 },
					{ corner: "-bottom-8 -left-8", rot: 270 },
				].map(({ corner, rot }) => (
					<BrandGlyph
						key={rot}
						name="corner-leafy"
						className={`pointer-events-none absolute z-20 hidden h-32 w-32 text-primary/70 sm:block ${corner}`}
						style={{ transform: `rotate(${rot}deg)` }}
					/>
				))}
				<div
					data-auth-fade
					className="card relative z-10 min-h-[26rem] w-full bg-base-200/85 shadow-lg"
				>
					<div className="card-body justify-center gap-3">
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
								{/* The one-line lockup (`antherslogo_hone`'s web cut) anchors the card's
								    top: since the Meadow footer went, the sign-in page had no mark of
								    Anthers anywhere below the navbar, and this was the empty space to
								    spend it in (Parker, 2026-10-09). The h1 stays — it is the page's
								    heading and the tests pin it — below the logo, at its own size. */}
								<Logo variant="oneline" className="mx-auto h-12" />
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
								<form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2" noValidate>
									<FormField
										spaced
										label="Email or handle"
										icon={SIGNIN_DRAWING[signinMode]}
										iconName={signinMode === "email" ? "email" : signinMode}
										/* 🚨 The hint's space is reserved at its TALLEST reading, and that is
									    load-bearing (Parker, 2026-10-10): the idle hint wraps to two lines
									    (2 × 22.75px, the hint's own `leading-relaxed` line at the card's
									    fixed `max-w-md` width), and every live reading after typing is one
									    — a hint that changed height changed the centered content's height,
									    so the card visibly resized while the person typed. The block span
									    holds the tallest height in every state, so the text is free to
									    change and the space it occupies is not. If the copy grows a third
									    line, this is the number that moves with it. */
										hint={<span className="block min-h-[2.875rem]">{SIGNIN_HINT[signinMode]}</span>}
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
											/* 🚨 No border and one shadow, not two lines (Parker, 2026-10-09):
											   daisyUI's `.input` was quietly drawing its own hairline pairs —
											   a border at base-content/10 the utilities could not beat — and
											   on focus it adds a 2px full-strength outline while zeroing the
											   box-shadow, which is the double ring. So the resting edge is
											   the shadow alone, focus answers with a single primary hairline
											   over the same shadow, and the outline is gone. The important
											   modifiers are load-bearing: the computed style, not the
											   screenshot, is what found both overrides. */
											className="input w-full pl-10 border-transparent! focus:border-primary/70! focus:outline-none! shadow-[0_3px_12px_color-mix(in_oklch,var(--color-base-content)_30%,transparent)]! focus:shadow-[0_3px_12px_color-mix(in_oklch,var(--color-base-content)_30%,transparent)]!"
											autoComplete="username"
											value={identifier}
											onChange={(e) => setIdentifier(e.target.value)}
											required
										/>
									</FormField>
									{(signinMode === "email" || signinMode === "anthers") && (
										<>
											<label className="label px-0 pb-1" htmlFor="login-password">
												<span className="text-sm font-semibold">Password</span>
											</label>
											<input
												id="login-password"
												type="password"
												autoComplete="current-password"
												className="input input-bordered w-full"
												value={password}
												onChange={(e) => {
													setPassword(e.target.value);
													setErrors({});
												}}
												required
											/>
											{twoFactor && (
												<>
													<label className="label px-0 pb-1" htmlFor="login-factor">
														<span className="text-sm font-semibold">Email code</span>
													</label>
													<input
														id="login-factor"
														type="text"
														inputMode="numeric"
														autoComplete="one-time-code"
														className="input input-bordered w-full"
														value={authFactorToken}
														onChange={(e) => {
															setAuthFactorToken(e.target.value);
															setErrors({});
														}}
													/>
												</>
											)}
											{/* The reset belongs to the server that holds the identity. The URL is the
											    node's answer, not a second copy of the host written here. */}
											{hostedAccountUrl && (
												<a
													className="link self-end text-xs text-base-content/55"
													href={`${hostedAccountUrl}/reset-password`}
													target="_blank"
													rel="noreferrer"
												>
													Forgot your password?
												</a>
											)}
										</>
									)}
									{/* ⚠️ `mt-5` over the form's own `gap-2`: the extra air above the
								    Continue button is deliberate (Parker, 2026-10-10). */}
									<button type="submit" className="btn btn-primary w-full mt-5" disabled={loading}>
										{loading ? (
											<span className="loading loading-spinner loading-sm" />
										) : signinMode === "bluesky" ? (
											"Continue with your identity server"
										) : (
											"Sign in"
										)}
									</button>
								</form>
								{/* The one thing an emailed code still does: move an unfinished signup to
								    this browser. It is a link to the signup ceremony, never a second way
								    to sign in. */}
								<div className="text-center text-xs text-base-content/55">
									<Link to="/finish/resume" className="link">
										Finishing a signup from another device?
									</Link>
								</div>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
