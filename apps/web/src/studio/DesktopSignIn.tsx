// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The desktop app's sign-in screen.
 *
 * No password is ever typed here — that is the point of the browser handoff. The
 * button opens the authorize page in the creator's own browser, where they are
 * usually already signed in, and one confirm click sends a one-time code back over
 * the `anthers://` scheme. See 42.06 § Desktop auth.
 *
 * Browser builds never render this; `StudioAuthGate` bounces to the consumer login.
 */
import { useAuth } from "@anthers/web-shared/auth";
import {
	beginSignIn,
	completeSignIn,
	deviceLabel,
	onAuthCode,
	type Persistence,
	takePendingCode,
} from "@anthers/web-shared/desktop";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "waiting" | "completing" | "error";

export default function DesktopSignIn() {
	const { refreshUser } = useAuth();
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [openedUrl, setOpenedUrl] = useState<string | null>(null);
	const [persistence, setPersistence] = useState<Persistence | null>(null);
	// Guards against a code arriving twice (cold-start pull racing the live event) —
	// the second redemption would fail, since codes are strictly single-use.
	const redeeming = useRef(false);

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
				// flips the gate through to the Studio.
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

	const start = async () => {
		setPhase("waiting");
		setError(null);
		try {
			setOpenedUrl(await beginSignIn(deviceLabel()));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	};

	return (
		<div className="min-h-dvh flex items-center justify-center px-4">
			<div className="card bg-base-200 w-full max-w-md">
				<div className="card-body">
					<h1 className="card-title text-xl">Anthers Studio</h1>

					{phase === "completing" ? (
						<>
							<p className="text-sm text-base-content/60">Finishing sign-in…</p>
							<div className="flex justify-center py-4">
								<LoadingSpinner size="lg" />
							</div>
							{persistence === "memoryOnly" && (
								<div className="alert alert-warning text-sm">
									<span>
										No system keychain was available, so this sign-in lasts until you quit the app.
									</span>
								</div>
							)}
						</>
					) : (
						<>
							<p className="text-sm text-base-content/60">
								Sign in through your browser — you'll never type your password here. You can revoke
								this device any time from Settings → Devices on anthers.org.
							</p>

							{error && (
								<div className="alert alert-error text-sm mt-2">
									<span>{error}</span>
								</div>
							)}

							<div className="card-actions mt-4">
								<button
									type="button"
									className="btn btn-primary btn-sm"
									onClick={start}
									disabled={phase === "waiting"}
								>
									{phase === "waiting" ? "Waiting for your browser…" : "Sign in with Anthers"}
								</button>
							</div>

							{phase === "waiting" && openedUrl && (
								<div className="mt-4">
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
				</div>
			</div>
		</div>
	);
}
