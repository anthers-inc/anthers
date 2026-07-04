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
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { type Progress, type TranscodeResult, transcodeMultiThreaded } from "./lib/transcode-mt";

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

/** Phase 2 harness: pick a video, encode the ladder multi-threaded, report timings. */
function EncodeBench({ isolated }: { isolated: boolean }) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [progress, setProgress] = useState<Progress | null>(null);
	const [result, setResult] = useState<TranscodeResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [running, setRunning] = useState(false);
	const [srcSize, setSrcSize] = useState(0);

	const run = async (file: File) => {
		setRunning(true);
		setResult(null);
		setError(null);
		setProgress(null);
		setSrcSize(file.size);
		try {
			const res = await transcodeMultiThreaded(file, setProgress);
			setResult(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setRunning(false);
		}
	};

	const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
	const sec = (n: number) => `${n.toFixed(1)}s`;

	return (
		<div
			style={{
				marginTop: 28,
				padding: 18,
				borderRadius: 10,
				background: "#1b1b1f",
				border: "1px solid #2b2b31",
			}}
		>
			<div style={{ fontWeight: 600, marginBottom: 4 }}>Multi-threaded encode test</div>
			<div style={{ fontSize: 13, color: "#9a9aa2", marginBottom: 14 }}>
				Encodes the 480/720/1080p ladder with the multi-threaded core (all cores). Nothing is
				uploaded — this just measures on-device speed.
			</div>

			<input
				ref={inputRef}
				type="file"
				accept="video/*"
				style={{ display: "none" }}
				onChange={(e) => {
					const f = e.target.files?.[0];
					if (f) run(f);
					e.target.value = "";
				}}
			/>
			<button
				type="button"
				disabled={running || !isolated}
				onClick={() => inputRef.current?.click()}
				style={{
					padding: "10px 16px",
					borderRadius: 8,
					border: "none",
					background: isolated ? "#f0b400" : "#3a3a41",
					color: isolated ? "#1a1a1a" : "#8a8a92",
					fontWeight: 600,
					cursor: running || !isolated ? "default" : "pointer",
				}}
			>
				{running ? "Encoding…" : isolated ? "Pick a video to encode" : "Requires isolation"}
			</button>

			{progress && running && (
				<div style={{ marginTop: 14 }}>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							fontSize: 13,
							color: "#9a9aa2",
							marginBottom: 6,
						}}
					>
						<span>{progress.stage}</span>
						<span>
							{progress.percent}%
							{progress.etaSeconds != null && progress.etaSeconds > 0
								? ` · ~${progress.etaSeconds}s left`
								: ""}
						</span>
					</div>
					<div style={{ height: 8, borderRadius: 4, background: "#2b2b31", overflow: "hidden" }}>
						<div style={{ height: "100%", width: `${progress.percent}%`, background: "#f0b400" }} />
					</div>
				</div>
			)}

			{error && (
				<div style={{ marginTop: 14, color: "#ff8a8a", fontSize: 13 }}>Encode failed: {error}</div>
			)}

			{result && (
				<div style={{ marginTop: 16, fontSize: 14 }}>
					<div style={{ fontWeight: 600, marginBottom: 8 }}>
						✅ {sec(result.totalSeconds)} total · {result.width}×{result.height} ·{" "}
						{result.durationSeconds}s clip · source {mb(srcSize)}
					</div>
					<table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
						<tbody>
							{result.variants.map((v) => (
								<tr key={v.name} style={{ borderTop: "1px solid #2b2b31" }}>
									<td style={{ padding: "6px 0", color: "#c7c7cc" }}>{v.name}</td>
									<td style={{ padding: "6px 0", color: "#9a9aa2" }}>
										{v.width}×{v.height}
									</td>
									<td style={{ padding: "6px 0", textAlign: "right" }}>{mb(v.data.byteLength)}</td>
									<td style={{ padding: "6px 0", textAlign: "right", color: "#f0b400" }}>
										{sec(v.seconds)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
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

				<EncodeBench isolated={isolated} />

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
