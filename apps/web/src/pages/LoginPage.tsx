// SPDX-License-Identifier: Apache-2.0

import { sanitizeNextPath, withNextPath } from "@anthers/shared/next-path";
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { client } from "@anthers/web-shared/rpc";
import FormField from "@anthers/web-shared/ui/FormField";
import { useCallback, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import BlueskyHandleModal from "../components/auth/BlueskyHandleModal";
import BlueskyMark from "../components/auth/BlueskyMark";
import EmailCodeModal from "../components/auth/EmailCodeModal";

/**
 * The shape of an address, loosely — enough to tell "alice" from "alice@example.com".
 *
 * Deliberately not a validating regex: the server's `z.string().email()` is the ruling
 * check and this only has to answer *"is the person trying to give us an email at all?"*,
 * because the two branches below need different things from them. Anything that gets past
 * this and fails at the API comes back as an ordinary refusal.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Signing in to an account that already exists (route: `/login`). Nothing else.
 *
 * 🚨 **This was `AuthPage`, a card that toggled between logging in and a four-field
 * Create Account form, and the form is GONE (2026-08-17).** There is one signup door now
 * and it is `/subscribe` — an identity (an Anthers handle or Bluesky), then an email address
 * and a code at `/finish`, then `/welcome` for the first-run. `/signup` redirects there. The old card asked for a username + email +
 * password + confirm before an account existed at all, which is the cost this platform
 * decided not to charge at the moment of decision; keeping it alive as a second door
 * meant two flows that had to agree about terms acceptance, onboarding and where a new
 * account lands, and they had already drifted.
 *
 * So: **do not add a signup form here.** If this page needs a way onward for someone
 * without an account, it is a link to `/subscribe`.
 *
 * 🚨 **Sign-in is the emailed code and nothing else (Parker, 2026-09-13).** No account
 * holds a password, so there is no password field on this page and no route it could post
 * to: the one form here asks for an email address, mails it a six-character code, and opens
 * the same code field `/subscribe` uses.
 * - It posts to **`/auth/signin/*`, never `/auth/signup/*`.** The difference is the whole
 *   point: the signup pair *creates an account* for an address it doesn't know, which
 *   would make a mistyped address at the login page mint an account that never saw the
 *   terms. The signin pair refuses.
 * - It needs an **email address**, and this page asks for nothing else. The code is keyed
 *   on the address (`signup_codes.email`), and resolving a public handle to a private
 *   mailbox would let anyone mail anyone by guessing handles.
 *
 * 🚨 **Bluesky is a third way IN and is not a third way to sign up either** (2026-08-22).
 * It signs in an account whose identity is a Bluesky one, resumes an unfinished signup started
 * with that identity, and answers `signup_disabled` for a handle no account holds rather than
 * minting anything. That refusal is the whole reason the affordance can live on this page at
 * all, and it is why the button is disclosed rather than given equal billing with the form: the
 * only people it works for are people who signed up with Bluesky. Offering it as a way to
 * *join* would be the second signup door this page spent a deletion getting rid of.
 *
 * 🚨 **The card's height is decoration, and it is load-bearing decoration.** The botanical
 * flourishes are positioned against the card box and each spray reaches roughly seven rems
 * in from its corner, so the empty space above and below the centered content is what keeps
 * a leaf off the buttons. At `h-[32rem]` the old content cleared the bottom pair by a
 * fraction of a rem — which is why adding the Bluesky row put a spray straight through it,
 * and why the handle prompt is a modal instead of an inline field. Two rules follow: the
 * height is a **minimum** now, because a card that cannot grow spills its content the
 * moment a form gains an error line; and anything added to the card body has to be paid
 * for in height, at twice its own, since the content is centered.
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

	const [email, setEmail] = useState("");
	/** The address a code was just sent to, or null when no code is in flight. */
	const [codeEmail, setCodeEmail] = useState<string | null>(null);

	/** Whether the handle prompt is open. Closed until someone asks for it. */
	const [blueskyOpen, setBlueskyOpen] = useState(false);

	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);

	/** Ask for a code. Answers the same whatever it found, so there is nothing to branch on. */
	const sendCode = useCallback(async (address: string) => {
		const res = await client.api.auth.signin.start.$post({ json: { email: address } });
		if (!res.ok) throw new Error("That doesn't look like an email address we can reach.");
	}, []);

	/**
	 * Ask for the code — the whole of what this form does. A wrong-looking address is
	 * refused here, loosely; anything that gets past the shape check and fails at the
	 * API comes back as an ordinary refusal.
	 */
	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrors({});
		const address = email.trim();

		if (!LOOKS_LIKE_EMAIL.test(address)) {
			setErrors({
				general: "Sign-in is by emailed code, so it needs your email address.",
			});
			return;
		}
		setLoading(true);
		try {
			await sendCode(address);
			setCodeEmail(address);
		} catch (err) {
			setErrors({
				general: err instanceof Error ? err.message : "Couldn't send the code. Please try again.",
			});
		} finally {
			setLoading(false);
		}
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
	 * `/subscribe`, where work queued after the refresh landed on an unmounted component
	 * and simply never happened. Nothing may follow the `navigate` below.
	 */
	const verifyCode = useCallback(
		async (code: string) => {
			const res = await client.api.auth.signin.verify.$post({
				json: { email: codeEmail ?? "", code },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(body.error ?? "That code didn't work. Check it, or ask for a new one.");
			}
			const body = (await res.json()) as { resume: boolean; needsOnboarding?: boolean };

			setCodeEmail(null);

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

			await refreshUser();
			// An account that never finished onboarding still owes the terms, so this door
			// has to be able to land there. Where they were heading rides along, exactly as
			// it does through the signup ceremony.
			navigate(body.needsOnboarding ? withNextPath("/welcome", nextParam || from) : redirectTo, {
				replace: true,
			});
		},
		[codeEmail, from, navigate, nextParam, redirectTo, refreshUser],
	);

	const resendCode = useCallback(async () => {
		if (codeEmail) await sendCode(codeEmail);
	}, [codeEmail, sendCode]);

	/**
	 * Hand the browser to Bluesky, carrying wherever this sign-in interrupted.
	 *
	 * ⚠️ It throws rather than reporting, because the modal shows the message in its own
	 * field — and it never resolves in any useful sense, since `signInWithBluesky` sets
	 * `window.location` and the page is already leaving.
	 */
	const startBluesky = useCallback(
		(handle: string) => signInWithBluesky(handle, redirectTo),
		[signInWithBluesky, redirectTo],
	);

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
							<Link to="/subscribe" className="link link-primary">
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
								label="Email"
								hint="We'll email you a six-character sign-in code — that's how signing in works."
							>
								{/* 🚨 `type="text"`, and that is load-bearing: the browser's built-in
								    email validation would fire *before* React sees the submit and say
								    "please include an '@' in the email address", which is a message about
								    syntax on a page whose real answer is about what signing in *is*. The
								    loose shape check above is the one whose sentence shows. */}
								<input
									type="text"
									inputMode="email"
									className="input input-bordered w-full"
									autoComplete="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
								/>
							</FormField>
							<button type="submit" className="btn btn-primary w-full mt-3" disabled={loading}>
								{loading ? (
									<span className="loading loading-spinner loading-sm" />
								) : (
									"Email me a sign-in code"
								)}
							</button>
						</form>

						{/* ── Bluesky ────────────────────────────────────────────────────
						    Below the divider rather than beside the form, because it only
						    works for an account that has already linked an identity — a
						    prominent button that refuses most of the people who press it is
						    worse than a quiet one. The divider says "or", not "or sign up
						    with", deliberately. The handle itself is asked for in a modal;
						    see `BlueskyHandleModal` for why it cannot be inline. */}
						<div className="divider my-1 text-xs text-base-content/50">or</div>
						<button
							type="button"
							className="btn btn-outline w-full"
							onClick={() => setBlueskyOpen(true)}
						>
							<BlueskyMark className="h-4 w-4" />
							Log in with Bluesky
						</button>
					</div>
				</div>
			</div>

			{codeEmail && (
				<EmailCodeModal
					stepLabel="Sign in with an emailed code"
					lede={
						<>
							If there's an Anthers account for <strong className="break-all">{codeEmail}</strong>,
							a six-character code is on its way. Enter it and you're in.
						</>
					}
					cta="Sign me in"
					busyLabel="Checking…"
					onSubmit={verifyCode}
					onResend={resendCode}
					onClose={() => setCodeEmail(null)}
				/>
			)}

			{blueskyOpen && (
				<BlueskyHandleModal onSubmit={startBluesky} onClose={() => setBlueskyOpen(false)} />
			)}
		</div>
	);
}
