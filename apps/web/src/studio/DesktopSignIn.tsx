// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's sign-in screen.
 *
 * 🚨 **Signing in happens in the person's browser, for every identity.** The shell mints a PKCE
 * challenge, opens the authorize page in the system browser, and a one-time code comes back over
 * the `anthers://` scheme. That is the same OAuth flow the website runs, and it is the shape the
 * packaged app needs: the credential is typed at the server that holds it, and a webview is
 * never the thing asking for it.
 *
 * ⚠️ **There is deliberately no in-app method.** One existed from 2026-10-16 until 2026-10-27 —
 * an emailed code typed into the window — because Anthers accounts had a password door of their
 * own. When every sign-in became OAuth that door went, and an in-app method would have meant
 * either a second credential path or an authorization page inside the webview, which is exactly
 * what the handoff exists to avoid.
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

	// The redemption. Live only while this screen is up: the sign-in's code comes back
	// here over the anthers:// scheme.
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

			<p className="text-sm text-base-content/60">
				Sign in through your browser, at the server that holds your identity. This device can be
				revoked any time from Settings → Devices on anthers.org.
			</p>

			{phase === "waiting" ? (
				<>
					<p className="text-sm text-base-content/60 mt-4">
						Finish signing in in your browser{openedUrl ? "" : " — waiting…"}
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
					<button
						type="button"
						className="btn btn-ghost btn-xs mt-3"
						onClick={() => void openBrowser()}
					>
						Open it again
					</button>
				</>
			) : (
				<div className="card-actions mt-4">
					<button
						type="button"
						className="btn btn-primary btn-sm w-full"
						onClick={() => void openBrowser()}
					>
						Sign in with your identity server
					</button>
				</div>
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
