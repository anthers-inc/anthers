// SPDX-License-Identifier: Apache-2.0
/**
 * The desktop app's sign-in screen.
 *
 * The default method is the app's own: the person types their email address (or an
 * Anthers handle) and the code their mailbox receives — the same ceremony the site's
 * login page runs, with no browser round trip. The browser handoff stays for the one
 * path that cannot happen in here: Bluesky OAuth runs at bsky.social in a real
 * browser and cannot complete inside this webview. See `apps/api/middleware/bearer.ts`.
 *
 * Browser builds never render this; `StudioAuthGate` bounces to the consumer login.
 */
import { useAuth } from "@anthers/web-shared/auth";
import {
	beginSignIn,
	completeEmailSignIn,
	completeSignIn,
	deviceLabel,
	type EmailContact,
	emailSignInCode,
	onAuthCode,
	type Persistence,
	startEmailSignIn,
	takePendingCode,
} from "@anthers/web-shared/desktop";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "waiting" | "code-sent" | "completing" | "error";

/** Route the typed text to the shape the API resolves: an address, or a hosted handle. */
function contactOf(raw: string): EmailContact | null {
	const typed = raw.trim();
	if (!typed) return null;
	if (typed.includes("@")) {
		return { email: typed.toLowerCase() };
	}
	// No "@": a handle the API resolves to the account's own mailbox. A handle that is
	// not Anthers' resolves to nothing, and the send route says so the way /signin/start
	// always has — with silence — so this screen tells the reader up front that Bluesky
	// identities sign in through the browser below.
	return { handle: typed };
}

export default function DesktopSignIn() {
	const { refreshUser } = useAuth();
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [contact, setContact] = useState<EmailContact | null>(null);
	const [typedAddress, setTypedAddress] = useState("");
	const [typedCode, setTypedCode] = useState("");
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

	const askForCode = async () => {
		const parsed = contactOf(typedAddress);
		if (!parsed) return;
		setError(null);
		setPhase("completing");
		try {
			await startEmailSignIn(deviceLabel());
			await emailSignInCode(parsed);
			setContact(parsed);
			setPhase("code-sent");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	};

	const spendCode = async () => {
		if (!contact) return;
		setPhase("completing");
		try {
			const result = await completeEmailSignIn(contact, typedCode.trim());
			setPersistence(result.persistence);
			await refreshUser();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("code-sent");
		}
	};

	// Computed before JSX, where the union narrows cleanly.
	const sentTo = contact
		? "email" in contact
			? `the inbox at ${contact.email}`
			: `the mailbox for ${contact.handle}`
		: null;

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

			{phase === "code-sent" ? (
				<>
					<p className="text-sm text-base-content/60">
						We sent a sign-in code to {sentTo}. Type it here.
					</p>
					<div className="card-actions mt-4 gap-2">
						<input
							type="text"
							className="input input-sm font-mono tracking-widest uppercase"
							placeholder="Sign-in code"
							value={typedCode}
							onChange={(e) => setTypedCode(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && typedCode.trim()) void spendCode();
							}}
						/>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => void spendCode()}
							disabled={!typedCode.trim()}
						>
							Sign in
						</button>
					</div>
					<button
						type="button"
						className="btn btn-ghost btn-xs mt-3"
						onClick={() => {
							setPhase("idle");
							setContact(null);
							setTypedCode("");
						}}
					>
						Wrong address? Start over
					</button>
				</>
			) : (
				<>
					<p className="text-sm text-base-content/60">
						Sign in with the code your email receives — no password anywhere on Anthers. This device
						can be revoked any time from Settings → Devices on anthers.org.
					</p>

					<div className="card-actions mt-4 gap-2">
						<input
							type="text"
							className="input input-sm"
							placeholder="Email address, or your Anthers handle"
							value={typedAddress}
							onChange={(e) => setTypedAddress(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && typedAddress.trim()) void askForCode();
							}}
						/>
						<button
							type="button"
							className="btn btn-primary btn-sm"
							onClick={() => void askForCode()}
							disabled={!typedAddress.trim()}
						>
							Email me a sign-in code
						</button>
					</div>

					{phase === "idle" && (
						<p className="text-xs text-base-content/50 mt-2">
							An Anthers handle codes to the mailbox your account was issued with; a Bluesky
							identity signs in through your browser instead.
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
						Sign in through your browser instead (Bluesky, or an anthers.org session)
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
