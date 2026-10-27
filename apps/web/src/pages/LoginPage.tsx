// SPDX-License-Identifier: Apache-2.0

import { sanitizeNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { usePageTitle } from "@anthers/web-shared/page-title";
import FormField from "@anthers/web-shared/ui/FormField";
import Logo from "@anthers/web-shared/ui/Logo";
import { AtSymbolIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";

/**
 * Whether what was typed is shaped like a handle at all.
 *
 * The same loose philosophy the page has always used: this is a routing question — *is there
 * something to send to an identity server?* — not a validation one. The server that holds the
 * handle is the authority on whether it exists, and its refusal comes back in its own words.
 */
const LOOKS_LIKE_HANDLE = /^@?[a-z0-9.-]+\.[a-z0-9-]+$/i;

/**
 * Signing in to an account that already exists (route: `/login`). Nothing else.
 *
 * 🚨 **This was `AuthPage`, a card that toggled between logging in and a four-field
 * Create Account form, and the form is GONE (2026-08-17).** There is one signup door now
 * and it is `/signup` — an identity (an Anthers handle or Bluesky), then an email address
 * and a code at `/finish`, then `/welcome` for the first-run. `/subscribe` redirects there —
 * it is the same page's old URL, kept resolving because links already sent out name it. The old
 * card asked for a username + email + password + confirm before an account existed at all, which
 * is the cost this platform decided not to charge at the moment of decision; keeping it alive as
 * a second door meant two flows that had to agree about terms acceptance, onboarding and where a
 * new account lands, and they had already drifted.
 *
 * So: **do not add a signup form here.** If this page needs a way onward for someone
 * without an account, it is a link to `/signup`.
 *
 * 🚨 **Every sign-in is OAuth at the identity's own server, Anthers' included (Parker,
 * 2026-10-27).** This page asks for a handle and nothing else, and the browser goes to whichever
 * server holds that identity: `anthers.social` for one Anthers issued, Bluesky or anybody else
 * for a handle that lives elsewhere. The person authenticates there, sees the permission being
 * granted in the server's own words, and comes back with a grant the app turns into its session.
 *
 * ⭐ **Why Anthers' own accounts are not an exception.** Anthers hosts a real authorization
 * server, so a password field here would be a second host asking for a credential it is not the
 * authority on — and the credential belongs at the server that stores its hash, where a reset,
 * a second factor and the consent screen all already live. One door for every identity also
 * means one flow to keep right instead of two that must agree.
 *
 * ⚠️ **There is no email sign-in, and that is a consequence rather than an omission.** An
 * address cannot start an OAuth flow: resolving it to a handle would mean asking Anthers "does
 * this address have an account?" before the person proved anything, which is the enumeration the
 * emailed-code design spent its whole shape refusing. A handle is public, so asking where it
 * lives gives nothing away.
 *
 * 🚨 **The emailed code is recovery and signup, not a login.** A person who cannot remember their
 * password resets it at the server that holds the identity, and the sign-in page there is where
 * that happens; `/finish/resume` is the one other thing a code still does, moving an unfinished
 * signup to another browser.
 *
 * ⚠️ **One field, so there is no second button** (2026-10-09). The separate "Log in with Bluesky"
 * button and its modal are gone — a person who thinks of this page as "where I type my handle"
 * and a person who scans for a button are one person again.
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
	const { signInWithIdentity } = useAuth();
	const location = useLocation();
	const [searchParams] = useSearchParams();

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

	/**
	 * The suspension notice, carried back from the OAuth callback.
	 *
	 * 🚨 **The callback refuses a suspended account rather than signing it in**, because its
	 * sessions authenticate nothing — `validateSession` refuses them — so minting one would
	 * bounce the person here with no explanation. The identity server has just proved who they
	 * are, which is the moment worth telling them, and the card becomes the notice.
	 */
	const suspended = searchParams.get("suspended") === "1";
	const suspendedUntil = searchParams.get("until");

	/** What was typed — a handle, with or without the leading `@`. */
	const [identifier, setIdentifier] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	/**
	 * Hand the browser to the identity's own server.
	 *
	 * ⚠️ **The only failure this can report is failing to start**, and that is deliberate: once
	 * the browser leaves for the identity server, whether the sign-in succeeds is that server's
	 * answer, and it brings the person back with either a grant or its own refusal.
	 */
	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError(null);
		const typed = identifier.trim();
		const bare = typed.replace(/^@/, "").toLocaleLowerCase();

		if (!LOOKS_LIKE_HANDLE.test(typed)) {
			setError(
				typed.includes("@") && typed.includes(".")
					? "Sign in with your handle rather than your email address."
					: "Type your whole handle, like alice.anthers.social.",
			);
			return;
		}

		setLoading(true);
		try {
			await signInWithIdentity(bare, redirectTo);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Couldn't reach your identity server. Please try again.",
			);
			setLoading(false);
		}
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
							/* The suspension interstitial. The identity server just proved who this
							   is, so this is the strongest telling there is — the card becomes the
							   notice. What it deliberately does not do is word a suspension as
							   anything the account did itself (the 51.02 wording rule), and it
							   names the appeal the moderation email already pointed at. */
							<>
								<h1 className="card-title justify-center text-2xl">Account Suspended</h1>
								<div className="text-center text-sm text-base-content/80 space-y-3">
									<p>
										Anthers has suspended this account
										{suspendedUntil
											? ` until ${new Date(suspendedUntil).toLocaleDateString(undefined, { dateStyle: "long" })}`
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
						    monthly Public Access limit in the same breath, per the wiki's *How Anthers
						    Talks About Itself*. */}
								<div className="text-center text-sm text-base-content/70">
									New to Anthers?{" "}
									<Link to="/signup" className="link link-primary">
										Sign up free
									</Link>
								</div>
								{error && (
									<div className="alert alert-error text-sm mt-2">
										<span>{error}</span>
									</div>
								)}
								<form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2" noValidate>
									<FormField
										spaced
										label="Your handle"
										icon={<AtSymbolIcon className="h-5 w-5" />}
										iconName="handle"
										/* 🚨 The hint's space is reserved at its TALLEST reading, and that is
									    load-bearing (Parker, 2026-10-10): the idle hint wraps to two lines
									    (2 × 22.75px, the hint's own `leading-relaxed` line at the card's
									    fixed `max-w-md` width), and every live reading after typing is one
									    — a hint that changed height changed the centered content's height,
									    so the card visibly resized while the person typed. The block span
									    holds the tallest height in every state, so the text is free to
									    change and the space it occupies is not. If the copy grows a third
									    line, this is the number that moves with it. */
										hint={
											<span className="block min-h-[2.875rem]">
												Your identity server confirms it's you, then brings you back here.
											</span>
										}
									>
										{/* 🚨 `type="text"`, and that is load-bearing: the browser's built-in
								    email validation would fire *before* React sees the submit and say
								    "please include an '@' in the email address", which is a message about
								    syntax on a page whose real answer is about what signing in *is*.

								    ⚠️ `inputMode` follows the `@` (2026-10-09): the moment the value starts
								    with one, the person is typing a handle, and the keyboard suits it —
								    dots and letters instead of the email address's autocompletions. */}
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
											onChange={(e) => {
												setIdentifier(e.target.value);
												setError(null);
											}}
											required
										/>
									</FormField>
									{/* ⚠️ `mt-5` over the form's own `gap-2`: the extra air above the
								    Continue button is deliberate (Parker, 2026-10-10). */}
									<button type="submit" className="btn btn-primary w-full mt-5" disabled={loading}>
										{loading ? (
											<span className="loading loading-spinner loading-sm" />
										) : (
											"Continue with your identity server"
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
