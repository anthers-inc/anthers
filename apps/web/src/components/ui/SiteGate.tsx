import { useState, type ReactNode } from "react";

const STORAGE_KEY = "anthers_site_access";

const baseUrl =
	typeof location !== "undefined" &&
	(location.hostname === "localhost" || location.hostname === "127.0.0.1")
		? "http://localhost:8000"
		: "";

type Interest = "user" | "creator" | "both";
type SubmitState = "idle" | "submitting" | "success" | "error";

export default function SiteGate({ children }: { children: ReactNode }) {
	const [authorized, setAuthorized] = useState(
		() => localStorage.getItem(STORAGE_KEY) === "true",
	);

	// Password bypass
	const [showPassword, setShowPassword] = useState(false);
	const [password, setPassword] = useState("");
	const [passwordError, setPasswordError] = useState(false);
	const [passwordLoading, setPasswordLoading] = useState(false);

	// Waitlist form
	const [email, setEmail] = useState("");
	const [interest, setInterest] = useState<Interest>("both");
	const [submitState, setSubmitState] = useState<SubmitState>("idle");

	if (authorized) return <>{children}</>;

	const handlePasswordSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setPasswordLoading(true);
		setPasswordError(false);
		try {
			const res = await fetch(`${baseUrl}/health/gate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password }),
			});
			if (res.ok) {
				localStorage.setItem(STORAGE_KEY, "true");
				setAuthorized(true);
			} else {
				setPasswordError(true);
			}
		} catch {
			setPasswordError(true);
		} finally {
			setPasswordLoading(false);
		}
	};

	const handleWaitlistSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setSubmitState("submitting");
		try {
			const res = await fetch(`${baseUrl}/api/waitlist`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, interest }),
			});
			if (res.ok) {
				setSubmitState("success");
			} else {
				setSubmitState("error");
			}
		} catch {
			setSubmitState("error");
		}
	};

	return (
		<div className="min-h-screen flex flex-col items-center justify-center px-4 py-12">
			{/* Hero content */}
			<div className="max-w-lg w-full text-center">
				<h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-6">
					Anthers
				</h1>

				<p className="text-lg sm:text-xl text-base-content/70 leading-relaxed mb-4">
					A home for creators and the people who love their work.
				</p>

				<p className="text-base text-base-content/50 leading-relaxed mb-10">
					Games, videos, music, and writing — all in one place. Creators
					keep their earnings. No ads, no algorithms working against you.
				</p>

				{/* Waitlist form */}
				<div className="card bg-base-100/80 backdrop-blur-sm shadow-xl">
					<div className="card-body gap-5">
						{submitState === "success" ? (
							<div className="py-4">
								<p className="text-lg font-medium text-success">
									You're on the list.
								</p>
								<p className="text-sm text-base-content/60 mt-2">
									We'll reach out when things are ready.
								</p>
							</div>
						) : (
							<form
								onSubmit={handleWaitlistSubmit}
								className="flex flex-col gap-4"
							>
								<p className="text-sm text-base-content/60">
									We're building something new. Leave your email and
									we'll let you know when we're ready for you.
								</p>

								{/* Email input */}
								<input
									type="email"
									required
									className="input input-bordered w-full"
									placeholder="you@example.com"
									value={email}
									onChange={(e) => {
										setEmail(e.target.value);
										if (submitState === "error")
											setSubmitState("idle");
									}}
								/>

								{/* Interest toggle */}
								<fieldset className="flex flex-col gap-1.5">
									<legend className="text-xs text-base-content/50 text-left">
										I'm interested as a...
									</legend>
									<div className="join w-full">
										{(
											[
												["user", "User"],
												["creator", "Creator"],
												["both", "Both"],
											] as const
										).map(([value, label]) => (
											<button
												key={value}
												type="button"
												className={`join-item btn btn-sm flex-1 ${
													interest === value
														? "btn-primary"
														: "btn-ghost border-base-content/20"
												}`}
												onClick={() => setInterest(value)}
											>
												{label}
											</button>
										))}
									</div>
								</fieldset>

								{submitState === "error" && (
									<p className="text-error text-sm">
										Something went wrong. Please try again.
									</p>
								)}

								<button
									type="submit"
									className="btn btn-primary w-full"
									disabled={submitState === "submitting"}
								>
									{submitState === "submitting"
										? "Submitting..."
										: "Keep Me Posted"}
								</button>
							</form>
						)}
					</div>
				</div>

				{/* Password bypass link */}
				<div className="mt-8">
					{showPassword ? (
						<form
							onSubmit={handlePasswordSubmit}
							className="flex gap-2 max-w-xs mx-auto"
						>
							<input
								type="password"
								className={`input input-bordered input-sm flex-1 ${passwordError ? "input-error" : ""}`}
								placeholder="Password"
								value={password}
								onChange={(e) => {
									setPassword(e.target.value);
									setPasswordError(false);
								}}
								autoFocus
							/>
							<button
								type="submit"
								className="btn btn-ghost btn-sm"
								disabled={passwordLoading}
							>
								{passwordLoading ? "..." : "Enter"}
							</button>
						</form>
					) : (
						<button
							type="button"
							className="text-xs text-base-content/30 hover:text-base-content/50 transition-colors"
							onClick={() => setShowPassword(true)}
						>
							Team access
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
