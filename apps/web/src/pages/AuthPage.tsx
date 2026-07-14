// SPDX-License-Identifier: AGPL-3.0-or-later

import { useAuth } from "@anthers/web-shared/auth";
import FormField from "@anthers/web-shared/ui/FormField";
import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

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
			await signUp(username, email, password);
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
			{/* Fixed height so login/signup are the same size (no resize on toggle);
				keyed on mode so each toggle remounts and fades the card in. */}
			<div
				key={mode}
				data-auth-fade
				className="card bg-base-200 shadow-lg h-[32rem] w-full max-w-md"
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
								<button type="submit" className="btn btn-primary w-full mt-2" disabled={loading}>
									{loading ? <span className="loading loading-spinner loading-sm" /> : "Sign Up"}
								</button>
							</form>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
