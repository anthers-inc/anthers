// SPDX-License-Identifier: AGPL-3.0-or-later
import { MeadowDecor } from "@anthers/web-shared/decor/MeadowDecor";
import { MeadowFloor } from "@anthers/web-shared/decor/MeadowFloor";
import { MeadowVines } from "@anthers/web-shared/decor/MeadowVines";
import { FONTS } from "@anthers/web-shared/fonts";
import Logo from "@anthers/web-shared/ui/Logo";
import { type ReactNode, useState } from "react";

const STORAGE_KEY = "anthers_site_access";

const baseUrl =
	typeof location !== "undefined" &&
	(location.hostname === "localhost" || location.hostname === "127.0.0.1")
		? "http://localhost:8000"
		: "";

type Interest = "user" | "creator" | "both";
type SubmitState = "idle" | "submitting" | "success" | "error";

export default function SiteGate({ children }: { children: ReactNode }) {
	const [authorized, setAuthorized] = useState(() => localStorage.getItem(STORAGE_KEY) === "true");

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
		// The pre-launch gate wears the same Meadow decor as the logged-out site:
		// `relative isolate` scopes the z-order so the hero (z-10) sits below the
		// climbing side vines (z-20), which sit below the grassy floor (z-30) — the
		// exact layering LoggedOutLayout uses. <MeadowDecor> supplies the pollen
		// surface (all three pieces track the live theme via useDecorMode; the
		// pre-paint script in index.html seeds data-theme before this renders).
		<div
			className="relative isolate flex min-h-screen flex-col"
			style={{ fontFamily: FONTS.nunito }}
		>
			<MeadowDecor floor={false} className="flex flex-1 flex-col justify-center">
				{/* Hero content */}
				<div className="mx-auto w-full max-w-3xl px-4 py-12 text-center">
					{/* The logo sits on the bare pollen surface, above the card. */}
					<div className="mb-8 mt-8 flex justify-center">
						<Logo variant="full" className="h-24 sm:h-28" />
					</div>

					{/* Everything below the logo lives in an off-white (base-200) card so it
						reads as a distinct panel above the pollen page surface (base-100). */}
					<div className="card border border-base-content/5 bg-base-200 shadow-xl">
						<div className="card-body gap-6 sm:p-10">
							{/* Intro copy */}
							<div>
								<p className="text-xl sm:text-2xl text-base-content/80 leading-relaxed mb-4 text-justify">
									A new non-profit building a uniquely nurturing ecosystem for creators and their
									communities.
								</p>

								<p className="text-lg text-base-content/65 leading-relaxed mb-4 text-justify">
									Games, videos, music, writing, and more, on an open, distributed network. No
									intrusive ads, no manipulative algorithms, just your direct line to a creative
									internet worth loving again.
								</p>

								<p className="text-lg text-base-content/65 leading-relaxed mb-4 text-justify">
									Supporting it all: a charitable foundation dedicated to lifting new and
									marginalized creators; building a more honest, healthy connection between creators
									and their audiences; and sharing openly the tools to build creative community
									without corporate interference or middlemen.
								</p>

								<p className="text-lg text-base-content/65 leading-relaxed text-justify">
									It's not a crazy idea. We've done this before. All it takes is for someone to put
									people first, and keep profit out of their the equation.
								</p>
							</div>

							{/* Waitlist form */}
							{submitState === "success" ? (
								<div className="py-4">
									<p className="text-xl font-medium text-success">You're on the list.</p>
									<p className="text-base text-base-content/70 mt-2">
										We'll reach out when things are ready.
									</p>
								</div>
							) : (
								<form onSubmit={handleWaitlistSubmit} className="flex flex-col gap-4">
									<p className="text-base text-base-content/70">
										We're excited to share Anthers with you but aren't quite ready yet.
										<br />
										Leave your email and we'll let you know when we're ready for you.
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
											if (submitState === "error") setSubmitState("idle");
										}}
									/>

									{/* Interest toggle */}
									<fieldset className="flex flex-col gap-1.5">
										<legend className="text-sm text-base-content/60 text-left">
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
													className={`join-item btn flex-1 ${
														interest === value
															? "btn-secondary"
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
										<p className="text-error text-base">Something went wrong. Please try again.</p>
									)}

									<button
										type="submit"
										className="btn btn-primary w-2/3 self-center"
										disabled={submitState === "submitting"}
									>
										{submitState === "submitting" ? "Submitting..." : "Keep Me Posted"}
									</button>
								</form>
							)}

							{/* Password bypass link */}
							<div>
								{showPassword ? (
									<form onSubmit={handlePasswordSubmit} className="flex gap-2 max-w-xs mx-auto">
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
										className="text-sm text-base-content/40 hover:text-base-content/60 transition-colors"
										onClick={() => setShowPassword(true)}
									>
										Team access
									</button>
								)}
							</div>
						</div>
					</div>
				</div>
			</MeadowDecor>

			{/* Climbing side vines spanning the whole gate, in front of the hero (z-20)
				but behind the grassy floor below (z-30). The gate's content is narrow
				(max-w-3xl), so it opts into showing vines from lg — the marketing shell
				keeps the default xl to avoid crowding its wider text. */}
			<MeadowVines from="lg" />

			{/* The grassy meadow the gate ends on, same as every logged-out page. */}
			<MeadowFloor />
		</div>
	);
}
