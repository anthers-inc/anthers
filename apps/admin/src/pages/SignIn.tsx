// SPDX-License-Identifier: Apache-2.0
/**
 * Signing in to the admin app: an address, then the code sent to it.
 *
 * The first step always says a code is on its way, whether or not the address has an admin account,
 * because the API answers identically either way and this page must not undo that by saying more.
 */
import { apiFetch } from "@anthers/web-shared/rpc";
import { type FormEvent, useState } from "react";
import { useSession } from "../lib/session";

export default function SignIn() {
	const { refresh } = useSession();
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [step, setStep] = useState<"email" | "code">("email");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function sendCode(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const res = await apiFetch("/api/admin/auth/signin/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email }),
		}).catch(() => null);
		setBusy(false);
		if (!res?.ok) {
			setError("Couldn't send a code. Check the address and try again.");
			return;
		}
		setStep("code");
	}

	async function verify(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError(null);
		const res = await apiFetch("/api/admin/auth/signin/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email, code }),
		}).catch(() => null);
		if (!res?.ok) {
			const body = (await res?.json().catch(() => null)) as { error?: string } | null;
			setError(body?.error ?? "That code didn't work. Check it, or ask for a new one.");
			setBusy(false);
			return;
		}
		await refresh();
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-base-200 px-4">
			<div className="w-full max-w-sm rounded-box border border-base-300 bg-base-100 p-6">
				<h1 className="mb-1 text-xl font-bold">Anthers Admin</h1>
				{step === "email" ? (
					<form onSubmit={sendCode} className="space-y-4">
						<p className="text-sm text-base-content/60">
							Sign in with the address your admin account uses, and we'll send you a code.
						</p>
						<label className="form-control block">
							<span className="label-text mb-1 block text-sm">Email Address</span>
							<input
								type="email"
								className="input input-bordered w-full"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								autoComplete="email"
								required
							/>
						</label>
						{error && <p className="text-sm text-error">{error}</p>}
						<button type="submit" className="btn btn-primary w-full" disabled={busy}>
							Send a Code
						</button>
					</form>
				) : (
					<form onSubmit={verify} className="space-y-4">
						<p className="text-sm text-base-content/60">
							If {email} has an admin account, a code is on its way. It expires in ten minutes.
						</p>
						<label className="form-control block">
							<span className="label-text mb-1 block text-sm">Code</span>
							<input
								className="input input-bordered w-full font-mono uppercase tracking-widest"
								value={code}
								onChange={(e) => setCode(e.target.value)}
								maxLength={6}
								autoComplete="one-time-code"
								required
							/>
						</label>
						{error && <p className="text-sm text-error">{error}</p>}
						<button type="submit" className="btn btn-primary w-full" disabled={busy}>
							Sign In
						</button>
						<button
							type="button"
							className="btn btn-ghost btn-sm w-full"
							onClick={() => {
								setStep("email");
								setCode("");
								setError(null);
							}}
						>
							Use a Different Address
						</button>
					</form>
				)}
			</div>
		</div>
	);
}
