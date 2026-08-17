// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { sanitizeNextPath } from "@anthers/web-shared/nextPath";
import FormField from "@anthers/web-shared/ui/FormField";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

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
 * The card keeps its fixed height and its botanical corner flourishes — the flourishes
 * are positioned against the card box, so the height is load-bearing for the framing
 * rather than a leftover of the login/signup size-matching it was originally written for.
 */
export default function LoginPage() {
	const { signIn } = useAuth();
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

	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);

	const handleLogin = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrors({});
		setLoading(true);
		try {
			await signIn(login, loginPassword);
			navigate(redirectTo, { replace: true });
		} catch (err) {
			setErrors({
				general: err instanceof Error ? err.message : "Something went wrong. Please try again.",
			});
		} finally {
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
						<form onSubmit={handleLogin} className="mt-2 flex flex-col gap-3">
							<FormField label="Username or Email" required>
								<input
									type="text"
									className="input input-bordered w-full"
									value={login}
									onChange={(e) => setLogin(e.target.value)}
									required
								/>
							</FormField>
							<FormField label="Password" required>
								<input
									type="password"
									className="input input-bordered w-full"
									value={loginPassword}
									onChange={(e) => setLoginPassword(e.target.value)}
									required
								/>
							</FormField>
							<button type="submit" className="btn btn-primary w-full mt-2" disabled={loading}>
								{loading ? <span className="loading loading-spinner loading-sm" /> : "Log In"}
							</button>
						</form>
						{/* An account may hold no password at all — the signup ceremony makes it
						    optional — so an emailed code is the only way those accounts get back
						    in, and this page offered them nothing until 2026-08-17. Saying so is
						    what keeps "optional" from being a trap door.

						    ⚠️ A `div`, not a `p`, for the same reason as the sign-up prompt above:
						    DaisyUI's `card-body p { flex-grow: 1 }` makes any paragraph in here eat
						    the card's slack, which pushes the form off-centre inside the fixed
						    height. This went in as a `p` first and did exactly that. */}
						<div className="mt-1 text-center text-xs leading-relaxed text-base-content/50">
							No password on your account? Sign in with an emailed code from the{" "}
							<Link to="/subscribe" className="link">
								sign-up page
							</Link>{" "}
							— entering an address we already know signs you in.
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
