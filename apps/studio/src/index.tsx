// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Anthers Studio — Phase 1 shell.
 *
 * This page's only job right now is to PROVE the Studio's plumbing before any
 * authoring UI is built (see epic E50 - Creator Studio):
 *   1. Cross-origin isolation — is `self.crossOriginIsolated` true and is
 *      SharedArrayBuffer available? (Requires the service to send COOP + COEP;
 *      it's the precondition for multi-threaded on-device encoding in Phase 2.)
 *   2. Shared auth — a credentialed cross-origin call to the main API
 *      (`anthers.org/api`) recognizes the session set on `anthers.org`, so a
 *      creator logged into the main site is logged into the Studio.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

/** The main API origin (the Studio is a separate origin from the API/consumer site). */
function apiOrigin(): string {
	if (typeof location === "undefined") return "";
	const h = location.hostname;
	if (h === "localhost" || h === "127.0.0.1") return "http://localhost:8000";
	if (h.startsWith("studio.")) return `${location.protocol}//${h.slice("studio.".length)}`;
	return "";
}

interface AuthState {
	loading: boolean;
	ok: boolean;
	status: number | null;
	username: string | null;
	error: string | null;
}

function Check({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 12,
				padding: "14px 16px",
				borderRadius: 10,
				background: "#1b1b1f",
				border: "1px solid #2b2b31",
			}}
		>
			<span style={{ fontSize: 20 }}>{ok ? "✅" : "❌"}</span>
			<div>
				<div style={{ fontWeight: 600 }}>{label}</div>
				{detail && <div style={{ fontSize: 13, color: "#9a9aa2", marginTop: 2 }}>{detail}</div>}
			</div>
		</div>
	);
}

function StudioDiagnostics() {
	const isolated = typeof self !== "undefined" && self.crossOriginIsolated === true;
	const sab = typeof SharedArrayBuffer !== "undefined";
	const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 0;

	const [auth, setAuth] = useState<AuthState>({
		loading: true,
		ok: false,
		status: null,
		username: null,
		error: null,
	});

	useEffect(() => {
		const url = `${apiOrigin()}/api/auth/me`;
		fetch(url, { credentials: "include" })
			.then(async (res) => {
				let username: string | null = null;
				try {
					const body = (await res.json()) as { user?: { username?: string } };
					username = body?.user?.username ?? null;
				} catch {
					// non-JSON / empty body
				}
				setAuth({ loading: false, ok: res.ok, status: res.status, username, error: null });
			})
			.catch((e) => {
				setAuth({
					loading: false,
					ok: false,
					status: null,
					username: null,
					error: e instanceof Error ? e.message : String(e),
				});
			});
	}, []);

	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#0f0f11",
				color: "#e7e7ea",
				fontFamily: "system-ui, sans-serif",
				display: "flex",
				justifyContent: "center",
				padding: "48px 20px",
			}}
		>
			<div style={{ width: "100%", maxWidth: 560 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
					<span style={{ fontSize: 26 }}>🌻</span>
					<h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Anthers Studio</h1>
				</div>
				<p style={{ color: "#9a9aa2", marginTop: 0, marginBottom: 28 }}>
					Phase 1 — proving the isolated shell + shared auth.
				</p>

				<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
					<Check
						label="Cross-origin isolated"
						ok={isolated}
						detail={
							isolated
								? "COOP + COEP active — multi-threaded encoding is unlocked."
								: "self.crossOriginIsolated is false — COOP/COEP not applied."
						}
					/>
					<Check
						label="SharedArrayBuffer available"
						ok={sab}
						detail={sab ? `Detected · ${cores} logical cores` : "Not available in this context."}
					/>
					<Check
						label="API reachable (cross-origin CORS)"
						ok={auth.ok}
						detail={
							auth.loading
								? "Calling /api/auth/me…"
								: auth.error
									? `Blocked / network error: ${auth.error}`
									: `Credentialed cross-origin request succeeded (HTTP ${auth.status}).`
						}
					/>
					<Check
						label="Signed in (shared session with anthers.org)"
						ok={!!auth.username}
						detail={
							auth.loading
								? "…"
								: auth.username
									? `Session recognized — signed in as @${auth.username}.`
									: "Not signed in. Log in on anthers.org, then reload this page."
						}
					/>
				</div>

				<p style={{ color: "#6b6b73", fontSize: 12, marginTop: 28 }}>
					Origin: <code>{typeof location !== "undefined" ? location.origin : "—"}</code> · API:{" "}
					<code>{apiOrigin() || "same-origin"}</code>
				</p>
			</div>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(
	<StrictMode>
		<StudioDiagnostics />
	</StrictMode>,
);
