// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's sign-in screen.
 *
 * The default method is the app's own: the person types the handle or address on their identity
 * and the password they chose for it. ⭐ **That is the same first-party door the website's login
 * page is**, expressed as a PKCE enrollment rather than a cookie — Anthers hosts the identity, so
 * it is the client of its own server and asks for the password it is entitled to. The shell
 * sends it in one request, redeems the code itself and keeps the session; the password is never
 * stored.
 *
 * ⚠️ **A Bluesky identity comes through the browser handoff instead**, below. Anthers is a
 * third-party client of that server, so it must not ask for the password; the browser goes to
 * that identity's own authorization page and a code comes back over `anthers://`.
 *
 * Browser builds never render this; `StudioAuthGate` bounces to the consumer login.
 */
import { useAuth } from "@anthers/web-shared/auth";
import {
	beginSignIn,
	completeSignIn,
	deviceLabel,
	onAuthCode,
	type PasswordSignInOutcome,
	type Persistence,
	passwordSignIn,
	startPasswordSignIn,
	takePendingCode,
} from "@anthers/web-shared/desktop";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "waiting" | "completing" | "two-factor" | "error";

export default function DesktopSignIn() {
	const { refreshUser } = useAuth();
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [identifier, setIdentifier] = useState("");
	const [password, setPassword] = useState("");
	const [factorCode, setFactorCode] = useState("");
	const [openedUrl, setOpenedUrl] = useState<string | null>(null);
	const [persistence, setPersistence] = useState<Persistence | null>(null);
	// Guards against a code arriving twice (cold-start pull racing the live event) —
	// the second redemption would fail, since codes are strictly single-use.
	const redeeming = useRef(false);

	// The browser-handoff redemption. Live only while this screen is up: a Bluesky
	// sign-in's code comes back here over the anthers:// scheme.
	useEffect(() => {
		const redeem = async (code: string) => {
			if (redeeming.current) return;
			redeeming.current = true;
			setPhase("completing");
			setError(null);
			try {
				const result = await completeSignIn(code);
				setPersistence(result.persistence);
				// The token is live in the shell now, so this re-fetch authenticates and
				// flips the gate through to the app.
				await refreshUser();
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setPhase("error");
				redeeming.current = false;
			}
		};

		// A link that arrived before this mounted (cold start), then live ones.
		takePendingCode()
			.then((code) => {
				if (code) redeem(code);
			})
			.catch(() => {});
		return onAuthCode(redeem);
	}, [refreshUser]);

	/**
	 * Sign in, or ask the server for the emailed code it wants as a second factor.
	 *
	 * ⚠️ **The password stays in this component's state and never leaves for anywhere but the
	 * API**, which sends it to the identity server and keeps only the session that answers.
	 */
	const signIn = async (withFactor: boolean) => {
		if (!identifier.trim() || !password) return;
		setError(null);
		setPhase("completing");
		try {
			// The enrollment is minted once per attempt; a second-factor retry reuses it, because
			// replacing it would orphan the challenge the code was issued against.
			if (!withFactor) await startPasswordSignIn(deviceLabel());
			const outcome: PasswordSignInOutcome = await passwordSignIn({
				identifier: identifier.trim(),
				password,
				...(withFactor && factorCode.trim() ? { authFactorToken: factorCode.trim() } : {}),
			});
			if (outcome.status === "two-factor") {
				setPhase("two-factor");
				return;
			}
			setPersistence(outcome.persistence);
			await refreshUser();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			// A refused second factor keeps its field on screen; a refused first attempt does not.
			setPhase(withFactor ? "two-factor" : "error");
		}
	};

	const openBrowser = async () => {
		setPhase("waiting");
		setError(null);
		try {
			setOpenedUrl(await beginSignIn(deviceLabel()));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	};

	if (phase === "completing") {
		return (
			<Shell>
				<p className="text-sm text-base-content/60">Finishing sign-in…</p>
				<div className="flex justify-center py-4">
					<LoadingSpinner size="lg" />
				</div>
				{persistence === "memoryOnly" && <KeychainNote />}
			</Shell>
		);
	}

	return (
		<Shell>
			<h1 className="card-title text-xl">Anthers</h1>

			{error && (
				<div className="alert alert-error text-sm mt-2">
					<span>{error}</span>
				</div>
			)}

			{phase === "two-factor" ? (
				<>
					<p className="text-sm text-base-content/60">
						That password was right, and this account asks for a code as well. Type the one that
						arrives by email.
					</p>
					<div className="card-actions mt-4 gap-2">
						<input
							type="text"
							inputMode="numeric"
							autoComplete="one-time-code"
							className="input input-sm font-mono tracking-widest uppercase"
							placeholder="Email code"
							value={factorCode}
							onChange={(e) => setFactorCode(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && factorCode.trim()) void signIn(true);
							}}
						/>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => void signIn(true)}
							disabled={!factorCode.trim()}
						>
							Sign in
						</button>
					</div>
					<button
						type="button"
						className="btn btn-ghost btn-xs mt-3"
						onClick={() => {
							setPhase("idle");
							setFactorCode("");
						}}
					>
						Start over
					</button>
				</>
			) : (
				<>
					<p className="text-sm text-base-content/60">
						Sign in with the password you chose for your Anthers identity. This device can be
						revoked any time from Settings → Devices on anthers.org.
					</p>

					<div className="card-actions mt-4 gap-2">
						<input
							type="text"
							autoComplete="username"
							className="input input-sm w-full"
							placeholder="Anthers handle or email"
							value={identifier}
							onChange={(e) => setIdentifier(e.target.value)}
						/>
						<input
							type="password"
							autoComplete="current-password"
							className="input input-sm w-full"
							placeholder="Password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && password) void signIn(false);
							}}
						/>
						<button
							type="button"
							className="btn btn-primary btn-sm w-full"
							onClick={() => void signIn(false)}
							disabled={!identifier.trim() || !password}
						>
							Sign in
						</button>
					</div>

					{phase === "idle" && (
						<p className="text-xs text-base-content/50 mt-2">
							A Bluesky identity signs in through your browser instead, at the server that holds it.
						</p>
					)}

					{phase === "waiting" && (
						<>
							<p className="text-sm text-base-content/60 mt-4">
								Confirm sign-in in your browser{openedUrl ? "" : " — waiting…"}
							</p>
							{openedUrl && (
								<div className="mt-2">
									<p className="text-xs text-base-content/50">
										Browser didn't open? Paste this in yourself:
									</p>
									<code className="text-xs break-all select-all block mt-1 p-2 rounded bg-base-300">
										{openedUrl}
									</code>
								</div>
							)}
						</>
					)}

					<button
						type="button"
						className="btn btn-ghost btn-xs mt-3"
						onClick={() => void openBrowser()}
						disabled={phase === "waiting"}
					>
						Sign in through your browser instead (Bluesky)
					</button>
				</>
			)}
		</Shell>
	);
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-dvh flex items-center justify-center px-4">
			<div className="card bg-base-200 w-full max-w-md">
				<div className="card-body">{children}</div>
			</div>
		</div>
	);
}

function KeychainNote() {
	return (
		<div className="alert alert-warning text-sm">
			<span>No system keychain was available, so this sign-in lasts until you quit the app.</span>
		</div>
	);
}
