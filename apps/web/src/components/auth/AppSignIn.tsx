// SPDX-License-Identifier: Apache-2.0
/**
 * The app's sign-in screen — the front door of every packaged shell, desktop or phone.
 *
 * 🚨 **Signing in happens in the person's browser, for every identity.** The shell mints a PKCE
 * challenge, opens the authorize page in the system browser, and a one-time code comes back over
 * the shell's own link — `anthers://` on desktop, the verified `https://anthers.org` app link on
 * Android. That is the same OAuth flow the website runs, and it is the shape a packaged app
 * needs: the credential is typed at the server that holds it, and a webview is never the thing
 * asking for it.
 *
 * ⚠️ **There is deliberately no in-app method.** One existed from 2026-10-16 until 2026-10-27 —
 * an emailed code typed into the window — because Anthers accounts had a password door of their
 * own. When every sign-in became OAuth that door went, and an in-app method would have meant
 * either a second credential path or an authorization page inside the webview, which is exactly
 * what the handoff exists to avoid.
 *
 * Browser builds never render this: `RootRedirect` sends a signed-out browser to the marketing
 * page, and `StudioAuthGate` bounces a signed-out browser to the consumer login.
 */
import { useAuth } from "@anthers/web-shared/auth";
import { BrandGlyph } from "@anthers/web-shared/decor/BrandGlyph";
import { MeadowFloor } from "@anthers/web-shared/decor/MeadowFloor";
import {
	awaitSignIn,
	beginSignIn,
	completeSignIn,
	deviceLabel,
	hasPendingSignIn,
	onAuthCode,
	type Persistence,
	takePendingCode,
} from "@anthers/web-shared/desktop";
import { isMobile } from "@anthers/web-shared/rpc";
import FormField from "@anthers/web-shared/ui/FormField";
import LoadingSpinner from "@anthers/web-shared/ui/LoadingSpinner";
import Logo from "@anthers/web-shared/ui/Logo";
import { AtSymbolIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "waiting" | "completing" | "error";

/**
 * Whether what was typed is shaped like a handle at all.
 *
 * The same loose test `/login` uses, and deliberately the same one: this is a routing
 * question, not a validation one, and the server that holds the handle is the authority on
 * whether it exists. Two different spellings of "looks like a handle" between the web login
 * and the app's would be two answers to one question.
 */
const LOOKS_LIKE_HANDLE = /^@?[a-z0-9.-]+\.[a-z0-9-]+$/i;

export default function AppSignIn() {
	const { refreshUser } = useAuth();
	const [phase, setPhase] = useState<Phase>("idle");
	const [error, setError] = useState<string | null>(null);
	const [openedUrl, setOpenedUrl] = useState<string | null>(null);
	const [persistence, setPersistence] = useState<Persistence | null>(null);
	/** What was typed, exactly as `/login` collects it. */
	const [identifier, setIdentifier] = useState("");
	/** The handle the last handoff used, so "Open it again" repeats the same request. */
	const [submittedHandle, setSubmittedHandle] = useState<string | null>(null);
	// Guards against a code arriving twice (cold-start pull racing the live event) —
	// the second redemption would fail, since codes are strictly single-use.
	const redeeming = useRef(false);

	// The redemption. Live only while this screen is up: the sign-in's code comes back
	// here over the shell's own link.
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

	const openBrowser = async (handle: string) => {
		setPhase("waiting");
		setError(null);
		setSubmittedHandle(handle);
		try {
			setOpenedUrl(await beginSignIn(handle, deviceLabel()));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
			return;
		}
		// The browser is only where the password is typed. The shell asks the server whether
		// the enrollment was approved, so the code does not have to find its way back by link.
		await waitForApproval();
	};

	const waitForApproval = useCallback(async () => {
		try {
			const result = await awaitSignIn();
			setPersistence(result.persistence);
			// 🚨 **Refresh only when this app is on screen.** The exchange happens in the shell
			// while the browser is still in front, and Android freezes a backgrounded webview —
			// a request started then is dropped mid-flight, so the sign-in succeeded on the
			// server and the screen never followed. Waiting for the app to be visible puts the
			// re-fetch where it cannot be frozen, which is also where the person can see it
			// happen.
			await waitUntilVisible();
			await refreshUser();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}, [refreshUser]);

	// A launch with an enrollment still open — the app was reclaimed while the person was in
	// the browser, or they switched back after finishing — picks the thread up here.
	useEffect(() => {
		let live = true;
		hasPendingSignIn()
			.then((pending) => {
				if (!pending || !live) return;
				setPhase("waiting");
				void waitForApproval();
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [waitForApproval]);

	/**
	 * Whether this shell asks for a handle before handing off.
	 *
	 * ⚠️ **The phone does; the desktop does not, yet.** The desktop's command still ignores a
	 * handle, so showing the field there would collect an answer nothing uses. When its shell
	 * learns the same parameter, this flag becomes true for both.
	 */
	const handleRequired = isMobile();

	/**
	 * The Continue press: the same check `/login` runs, then the handoff with the handle the
	 * person typed.
	 */
	const submit = (e: React.FormEvent) => {
		e.preventDefault();
		const typed = identifier.trim();
		const bare = typed.replace(/^@/, "").toLocaleLowerCase();
		if (!LOOKS_LIKE_HANDLE.test(typed)) {
			setError(
				typed.includes("@") && typed.includes(".")
					? "Sign in with your handle rather than your email address."
					: "Type your whole handle, like alice.anthers.social.",
			);
			return;
		}
		void openBrowser(bare);
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
			<Logo variant="oneline" className="h-10" />
			<h1 className="card-title justify-center text-2xl">Log In</h1>

			{error && (
				<div className="alert alert-error text-sm mt-2 w-full">
					<span>{error}</span>
				</div>
			)}

			{phase === "waiting" ? (
				<>
					<p className="text-sm text-base-content/60 mt-4">
						Finish signing in in your browser{openedUrl ? "" : " — waiting…"}
					</p>
					{openedUrl && (
						<div className="mt-2 w-full">
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
						className="btn btn-ghost btn-sm mt-3"
						onClick={() => void openBrowser(submittedHandle ?? "")}
					>
						Open it again
					</button>
				</>
			) : handleRequired ? (
				<form onSubmit={submit} className="mt-2 flex w-full flex-col gap-2 text-left" noValidate>
					<FormField
						spaced
						label="Your handle"
						icon={<AtSymbolIcon className="h-5 w-5" />}
						iconName="handle"
						hint={
							<span className="block min-h-[2.875rem]">
								Your identity server confirms it's you, then brings you back here.
							</span>
						}
					>
						<input
							type="text"
							inputMode={identifier.startsWith("@") ? "url" : "email"}
							className="input w-full pl-10"
							autoComplete="username"
							value={identifier}
							onChange={(e) => {
								setIdentifier(e.target.value);
								setError(null);
							}}
							required
						/>
					</FormField>
					<button type="submit" className="btn btn-primary w-full mt-3">
						Continue with your identity server
					</button>
				</form>
			) : (
				<div className="mt-4 w-full">
					<button
						type="button"
						className="btn btn-primary w-full"
						onClick={() => void openBrowser("")}
					>
						Sign in with your identity server
					</button>
				</div>
			)}
		</Shell>
	);
}

/**
 * Resolve once this document is visible, immediately if it already is.
 *
 * 🚨 **Android freezes a backgrounded WebView, and a fetch started in one is dropped rather
 * than failed** — the sign-in exchange runs in the shell while the browser is still in front,
 * so a refresh started then died mid-flight and the screen never followed a sign-in that had
 * succeeded. Waiting for the app to come forward is the same moment the person can see it.
 */
function waitUntilVisible(): Promise<void> {
	if (typeof document === "undefined" || document.visibilityState === "visible") {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const settle = () => {
			if (document.visibilityState !== "visible") return;
			document.removeEventListener("visibilitychange", settle);
			window.removeEventListener("focus", settle);
			resolve();
		};
		document.addEventListener("visibilitychange", settle);
		window.addEventListener("focus", settle);
	});
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		// The shell's front door is a surface rather than a card on a page: no topbar, no
		// footer, and the meadow closing the bottom of the screen. The decoration is the
		// `/login` page's composition, which is why the sprays below are the same glyph in
		// the same corners; on a phone the card and sprays are sized to the viewport.
		<div className="relative flex min-h-dvh flex-col overflow-hidden bg-base-100">
			<main className="safe-top safe-sides flex flex-1 items-center justify-center px-6 py-8">
				<div className="relative w-full max-w-sm">
					{[
						{ corner: "-top-5 -left-5", rot: 0 },
						{ corner: "-top-5 -right-5", rot: 90 },
						{ corner: "-bottom-5 -right-5", rot: 180 },
						{ corner: "-bottom-5 -left-5", rot: 270 },
					].map(({ corner, rot }) => (
						<BrandGlyph
							key={rot}
							name="corner-leafy"
							className={`pointer-events-none absolute z-20 h-20 w-20 text-primary/70 ${corner}`}
							style={{ transform: `rotate(${rot}deg)` }}
						/>
					))}
					<div data-auth-fade className="card relative z-10 bg-base-200/85 shadow-lg">
						<div className="card-body items-center gap-3 text-center">{children}</div>
					</div>
				</div>
			</main>
			{/* The floor is the page's bottom edge here, not a band under a footer, so it
			    sits outside <main> and keeps the last strip of the screen. */}
			<MeadowFloor heightClass="h-24 shrink-0" />
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
