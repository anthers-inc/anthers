// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { sanitizeNextPath, withNextPath } from "@anthers/web-shared/nextPath";
import { client } from "@anthers/web-shared/rpc";
import FormField from "@anthers/web-shared/ui/FormField";
import { useCallback, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
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
 * and it is `/subscribe` — an email address, a code, then `/welcome` for the handle and
 * the terms. `/signup` redirects there. The old card asked for username + email +
 * password + confirm before an account existed at all, which is the cost this platform
 * decided not to charge at the moment of decision; keeping it alive as a second door
 * meant two flows that had to agree about terms acceptance, onboarding and where a new
 * account lands, and they had already drifted.
 *
 * So: **do not add a signup form here.** If this page needs a way onward for someone
 * without an account, it is a link to `/subscribe`.
 *
 * 🚨 **The password field is optional, and leaving it empty is a second way IN — never a
 * way to sign up** (2026-08-18). An account may hold no password at all, because the
 * signup ceremony makes one optional, and until now this page could not admit those
 * accounts at all: it pointed them at `/subscribe` in a footnote, which is a signup page
 * wearing a sign-in hat. Submitting with the password box empty now mails a
 * six-character code to the address typed above and opens the same field `/subscribe`
 * uses.
 * - It posts to **`/auth/signin/*`, never `/auth/signup/*`.** The difference is the whole
 *   point: the signup pair *creates an account* for an address it doesn't know, which
 *   would make a mistyped address at the login page mint an account that never saw the
 *   terms. The signin pair refuses.
 * - It needs an **email address**, and says so when given a handle. The code is keyed on
 *   the address (`signup_codes.email`), and resolving a public username to a private
 *   mailbox would let anyone mail anyone by guessing handles.
 * - It is offered to **everyone**, not only to accounts without a password. Whether an
 *   account has one is not something this page may find out, and the emailed code has
 *   been available to every account through `/subscribe` since the ceremony shipped.
 *
 * The card keeps its fixed height and its botanical corner flourishes — the flourishes
 * are positioned against the card box, so the height is load-bearing for the framing
 * rather than a leftover of the login/signup size-matching it was originally written for.
 */
export default function LoginPage() {
	const { signIn, refreshUser } = useAuth();
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

	const [login, setLogin] = useState("");
	const [loginPassword, setLoginPassword] = useState("");
	/** The address a code was just sent to, or null when no code is in flight. */
	const [codeEmail, setCodeEmail] = useState<string | null>(null);

	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);

	/** Ask for a code. Answers the same whatever it found, so there is nothing to branch on. */
	const sendCode = useCallback(async (email: string) => {
		const res = await client.api.auth.signin.start.$post({ json: { email } });
		if (!res.ok) throw new Error("That doesn't look like an email address we can reach.");
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrors({});
		const identifier = login.trim();

		// An empty password is a request for a code, not a failed password. The field is not
		// `required` for exactly this reason — the browser would otherwise refuse to submit
		// and this branch could never be reached.
		if (!loginPassword) {
			if (!LOOKS_LIKE_EMAIL.test(identifier)) {
				setErrors({
					general:
						"Signing in without a password needs your email address — that's where the code goes.",
				});
				return;
			}
			setLoading(true);
			try {
				await sendCode(identifier);
				setCodeEmail(identifier);
			} catch (err) {
				setErrors({
					general: err instanceof Error ? err.message : "Couldn't send the code. Please try again.",
				});
			} finally {
				setLoading(false);
			}
			return;
		}

		setLoading(true);
		try {
			await signIn(identifier, loginPassword);
			navigate(redirectTo, { replace: true });
		} catch (err) {
			setErrors({
				general: err instanceof Error ? err.message : "Something went wrong. Please try again.",
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
			const body = (await res.json()) as { needsOnboarding: boolean };

			setCodeEmail(null);
			await refreshUser();
			// An account that never finished onboarding still owes a handle and the terms,
			// and the emailed code is the only way it can come back at all — so this is the
			// one door that routinely lands on someone who has neither. Where they were
			// heading rides along, exactly as it does through the signup ceremony.
			navigate(body.needsOnboarding ? withNextPath("/welcome", nextParam || from) : redirectTo, {
				replace: true,
			});
		},
		[codeEmail, from, navigate, nextParam, redirectTo, refreshUser],
	);

	const resendCode = useCallback(async () => {
		if (codeEmail) await sendCode(codeEmail);
	}, [codeEmail, sendCode]);

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
				<div data-auth-fade className="card relative z-10 h-[32rem] w-full bg-base-200 shadow-lg">
					<div className="card-body justify-center">
						<h1 className="card-title justify-center text-2xl">Log In</h1>
						{/* Sign-up prompt sits at the top of the card (YNAB-style). Plain div, not
						    <p>, so DaisyUI's card-body `p { flex-grow: 1 }` doesn't balloon it and
						    shove the form down. It is a LINK now rather than a mode toggle — the
						    card it used to flip to no longer exists. */}
						<div className="text-center text-sm text-base-content/70">
							New to Anthers?{" "}
							<Link to="/subscribe" className="link link-primary">
								Sign up
							</Link>
						</div>
						{errors.general && (
							<div className="alert alert-error text-sm mt-2">
								<span>{errors.general}</span>
							</div>
						)}
						<form onSubmit={handleSubmit} className="mt-2 flex flex-col gap-1">
							<FormField label="Username or Email" required>
								<input
									type="text"
									className="input input-bordered w-full"
									autoComplete="username"
									value={login}
									onChange={(e) => setLogin(e.target.value)}
									required
								/>
							</FormField>
							{/* 🚨 Not `required`, and that is the feature rather than a relaxation:
							    the browser refusing to submit an empty box is what would make the
							    code path unreachable. The hint is the only place this page says so,
							    which is why it sits under the field rather than in a footnote. */}
							<FormField
								label="Password"
								hint="Leave it empty and we'll email you a sign-in code instead."
							>
								<input
									type="password"
									className="input input-bordered w-full"
									autoComplete="current-password"
									value={loginPassword}
									onChange={(e) => setLoginPassword(e.target.value)}
								/>
							</FormField>
							{/* The label follows the field, because pressing "Log In" and being told
							    to check your email is a worse surprise than a button that changes. */}
							<button type="submit" className="btn btn-primary w-full mt-3" disabled={loading}>
								{loading ? (
									<span className="loading loading-spinner loading-sm" />
								) : loginPassword ? (
									"Log In"
								) : (
									"Email me a sign-in code"
								)}
							</button>
						</form>
					</div>
				</div>
			</div>

			{codeEmail && (
				<EmailCodeModal
					stepLabel="Sign in without a password"
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
		</div>
	);
}
