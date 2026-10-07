// SPDX-License-Identifier: Apache-2.0
/**
 * The browser error beacon — the client half of the hand-rolled error tracker.
 *
 * 🚨 **The client-side throttle is the primary defense, and the route's rate limit is the
 * net.** A render-loop throwing every frame could POST hundreds of times a second; the
 * server's per-IP limit would catch that, but at the cost of turning one user's crash
 * into an IP-wide outage for real error reports. So this side never sends more than one
 * POST per fingerprint per session, has a hard session cap of five, and drops *silently*
 * when the API is unreachable — including the case where the crash and the outage have
 * one cause, where nothing about the beacon's fate matters anyway (the alerting path that
 * never depended on the page is what carries it).
 *
 * **What is sent is capped and shaped by the server's own vocabulary** — at most ten
 * frames, each two short strings; a message at most 1000 chars. What is never sent: form
 * values, DOM snapshots, storage. The message and stack are all the browser has anyway —
 * `window.onerror`'s event and `unhandledrejection`'s reason — and redaction of
 * token/email/id shapes happens server-side in normalize, *not* here, so the client code
 * stays dumb and the redaction rules have exactly one home to test.
 *
 * **Fingerprinting client-side is deliberately shallow**: message + top frame location,
 * enough to dedupe the session's repeats — the server's normalize-and-hash is the real
 * fingerprint. Frames are sent **raw and minified** (the design stores browser stacks
 * unsymbolicated; the Admin module remaps against source maps later).
 *
 * Install once, at the app root's first effect — `installBrowserErrorCapture()` in
 * `App.tsx`. It is a no-op in tests and dev (nothing watches the dev console), and every
 * failure inside it is swallowed by design: an error *about* error reporting must never
 * become a second error loop.
 */
import { apiFetch } from "@anthers/web-shared/rpc";

/** At most five beacons per session — a session with more than five distinct crashes has told us enough. */
const SESSION_MAX = 5;

interface OutgoingBeacon {
	message: string;
	frames: Array<{ fn: string; loc: string }>;
	path: string;
	userAgent: string;
}

/** The fingerprints this session has already reported — the one-POST-per-fingerprint rule's memory. */
const reported = new Set<string>();
let beaconCount = 0;
let installed = false;

/** A shallow fingerprint: message plus where it fired. The server's hash is the real one. */
function sessionFingerprint(message: string, frames: OutgoingBeacon["frames"]): string {
	return `${message}|${frames.map((f) => f.loc).join(",")}`;
}

/** Turn whatever an event handed us into the beacon's frames — safe against exotic values. */
function framesFromReason(reason: unknown): { message: string; frames: OutgoingBeacon["frames"] } {
	const stack = reason instanceof Error ? (reason.stack ?? "") : "";
	const message =
		reason instanceof Error
			? reason.message
			: typeof reason === "string"
				? reason
				: String(reason ?? "");
	const frames: OutgoingBeacon["frames"] = [];
	for (const line of stack.split("\n").slice(1)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const at = trimmed.startsWith("at ")
			? trimmed.replace(/^at\s+/, "")
			: trimmed.replace(/^\S+@/, "");
		const paren = at.lastIndexOf("(");
		const loc = paren >= 0 ? at.slice(paren + 1).replace(/\)$/, "") : (at.split("@")[1] ?? at);
		const fn = paren >= 0 ? at.slice(0, paren).trim() : (at.split("@")[0] ?? "");
		if (!loc) continue;
		frames.push({ fn: fn.slice(0, 150), loc: loc.slice(0, 200) });
		if (frames.length >= 10) break;
	}
	return {
		message: message.slice(0, 1000),
		frames: frames.length ? frames : [{ fn: "", loc: "unknown" }],
	};
}

/** Fire one beacon — capped before the network is touched, silent on every failure. */
async function sendBeacon(outgoing: OutgoingBeacon): Promise<void> {
	if (beaconCount >= SESSION_MAX) return;
	try {
		await apiFetch("/api/errors/browser", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(outgoing),
		});
		beaconCount += 1;
	} catch {
		// Unreachable API, rate-limited, refused shape — all the same to this side: silent.
	}
}

/** The one install point: global handlers, throttled, and a no-op when called twice. */
export function installBrowserErrorCapture(): void {
	if (installed) return;
	installed = true;

	window.addEventListener("error", (event) => {
		// Script/resource errors without an error object carry nothing worth a POST.
		if (!event.message) return;
		const { message, frames } = framesFromReason(event.error ?? new Error(event.message));
		const fingerprint = sessionFingerprint(message, frames);
		if (reported.has(fingerprint)) return;
		reported.add(fingerprint);
		void sendBeacon({
			message,
			frames,
			path: `${location.pathname}${location.search}`.slice(0, 300),
			userAgent: navigator.userAgent.slice(0, 300),
		});
	});

	window.addEventListener("unhandledrejection", (event) => {
		const { message, frames } = framesFromReason(event.reason);
		const fingerprint = sessionFingerprint(message, frames);
		if (reported.has(fingerprint)) return;
		reported.add(fingerprint);
		void sendBeacon({
			message,
			frames,
			path: `${location.pathname}${location.search}`.slice(0, 300),
			userAgent: navigator.userAgent.slice(0, 300),
		});
	});
}
