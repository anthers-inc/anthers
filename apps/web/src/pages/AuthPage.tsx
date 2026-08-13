// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import FormField from "@anthers/web-shared/ui/FormField";
import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

type Mode = "login" | "signup";

// Combined auth surface: one card that swaps between logging in and signing up.
// `/login` mounts it in login mode, `/signup` deep-links straight into signup
// mode (so the marketing "get started" CTAs land on the right card); the prompt
// at the top of the card flips between the two without leaving the page. Both
// cards share a fixed height so toggling doesn't resize/jump, and the swap fades.
export default function AuthPage({ initialMode = "login" }: { initialMode?: Mode }) {
	const { signIn, signUp } = useAuth();
	const navigate = useNavigate();
	const location = useLocation();

	// Where to land after auth: an explicit ?next=, else the route that bounced us
	// here (ProtectedRoute stashes it in location.state.from), else the feed.
	const nextParam = new URLSearchParams(location.search).get("next");
	const from = (location.state as { from?: { pathname: string } })?.from?.pathname;
	const redirectTo = nextParam || from || "/feed";

	const [mode, setMode] = useState<Mode>(initialMode);

	// Login fields
	const [login, setLogin] = useState("");
	const [loginPassword, setLoginPassword] = useState("");

	// Signup fields
	const [username, setUsername] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [passwordConfirm, setPasswordConfirm] = useState("");
	const [acceptTerms, setAcceptTerms] = useState(false);

	const [errors, setErrors] = useState<Record<string, string>>({});
	const [loading, setLoading] = useState(false);

	const switchMode = (next: Mode) => {
		setErrors({});
		setMode(next);
	};

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

	const handleSignup = async (e: React.FormEvent) => {
		e.preventDefault();
		setErrors({});
		if (password !== passwordConfirm) {
			setErrors({ password_confirm: "Passwords do not match" });
			return;
		}
		setLoading(true);
		try {
			await signUp(username, email, password, acceptTerms);
			/*
			 * A brand-new account goes to the first-run state, not to the feed.
			 *
			 * ⚠️ Unless something specific sent them here. An explicit `?next=` or a route
			 * that bounced them to sign in is a person trying to *do* something — a gated
			 * post, a checkout — and interrupting that with a welcome screen loses the
			 * thing they actually wanted. Only the undirected case gets the welcome, which
			 * is exactly the case that has nowhere better to be.
			 */
			navigate(nextParam || from ? redirectTo : "/welcome", { replace: true });
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
				can be placed around it. They're stable siblings of the keyed card, so they
				stay put while the card cross-fades on login↔signup. */}
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
				{/* Fixed height so login/signup are the same size (no resize on toggle);
					keyed on mode so each toggle remounts and fades the card in. */}
				<div
					key={mode}
					data-auth-fade
					className="card relative z-10 h-[32rem] w-full bg-base-200 shadow-lg"
				>
					<div className="card-body justify-center">
						{mode === "login" ? (
							<>
								<h1 className="card-title justify-center text-2xl">Log In</h1>
								{/* Sign-up prompt sits at the top of the card (YNAB-style). Plain
								div, not <p>, so DaisyUI's card-body `p { flex-grow: 1 }` doesn't
								balloon it and shove the form down. */}
								<div className="text-center text-sm text-base-content/70">
									New to Anthers?{" "}
									<button
										type="button"
										className="link link-primary"
										onClick={() => switchMode("signup")}
									>
										Sign up
									</button>
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
							</>
						) : (
							<>
								<h1 className="card-title justify-center text-2xl">Create Account</h1>
								{/* Log-in prompt sits at the top of the card (YNAB-style). Plain div,
								not <p>, so DaisyUI's card-body `p { flex-grow: 1 }` doesn't balloon it. */}
								<div className="text-center text-sm text-base-content/70">
									Already have an account?{" "}
									<button
										type="button"
										className="link link-primary"
										onClick={() => switchMode("login")}
									>
										Log in
									</button>
								</div>
								{errors.general && (
									<div className="alert alert-error text-sm mt-2">
										<span>{errors.general}</span>
									</div>
								)}
								<form onSubmit={handleSignup} className="mt-2 flex flex-col gap-3">
									<FormField label="Username" required error={errors.username}>
										<input
											type="text"
											className="input input-bordered w-full"
											value={username}
											onChange={(e) => setUsername(e.target.value)}
											required
										/>
									</FormField>
									<FormField label="Email" required error={errors.email}>
										<input
											type="email"
											className="input input-bordered w-full"
											value={email}
											onChange={(e) => setEmail(e.target.value)}
											required
										/>
									</FormField>
									<FormField label="Password" required error={errors.password}>
										<input
											type="password"
											className="input input-bordered w-full"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											required
										/>
									</FormField>
									<FormField label="Confirm password" required error={errors.password_confirm}>
										<input
											type="password"
											className="input input-bordered w-full"
											value={passwordConfirm}
											onChange={(e) => setPasswordConfirm(e.target.value)}
											required
										/>
									</FormField>
									{/* Unchecked by default, and the button stays disabled until it isn't.
									    A pre-ticked box is not acceptance, and the 13+ statement is the one
									    thing Anthers asserts about age — it has to be something the person
									    actually did. The API enforces it too; this is the honest surface,
									    not the enforcement. */}
									<label className="flex cursor-pointer items-start gap-3 rounded-lg border border-base-300 p-3 mt-1">
										<input
											type="checkbox"
											className="checkbox checkbox-sm mt-0.5"
											checked={acceptTerms}
											onChange={(e) => setAcceptTerms(e.target.checked)}
										/>
										<span className="text-sm">
											I'm 13 or older, and I agree to the{" "}
											<Link to="/terms" className="link link-primary" target="_blank">
												Terms of Service
											</Link>{" "}
											and{" "}
											<Link to="/privacy" className="link link-primary" target="_blank">
												Privacy Policy
											</Link>
											.
										</span>
									</label>
									<button
										type="submit"
										className="btn btn-primary w-full mt-2"
										disabled={loading || !acceptTerms}
									>
										{loading ? <span className="loading loading-spinner loading-sm" /> : "Sign Up"}
									</button>
								</form>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
