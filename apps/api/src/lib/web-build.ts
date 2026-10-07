// SPDX-License-Identifier: Apache-2.0
/**
 * Helpers shared by the browser-build surface: the path rules, the content types,
 * the play-token codec, and the delivery host guard.
 *
 * 🚨 **These live in one module and are imported, never restated**, because the rules
 * they encode are the ones the delivery route stands on. The upload route validates a
 * path with `buildPathProblem` before it becomes a storage key; the delivery route
 * re-runs the same function on every requested path before it looks the key up — so a
 * path that would escape a build cannot be registered and cannot resolve. The prefix
 * shape itself lives in `services/media-purge.ts` (`webBuildPrefix`), which the upload
 * route and the purge sweep already import.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isPublicDeployment } from "./deployment.js";

/** The characters a build-relative path may not carry, checked segment by segment. */
export function buildPathProblem(value: string): string | null {
	if (value === "") return "Every file needs a name saying where it sits in the build.";
	if (value.startsWith("/") || value.endsWith("/")) {
		return "Paths are relative to the build's root, without leading or trailing slashes.";
	}
	if (value.includes("\\")) return "Paths use forward slashes.";
	if (value.includes("\0")) return "That path contains a character file names cannot carry.";
	// 🚨 A literal `%` is refused because `isOwnStorageRef` and the serve path both meet
	// percent-encoding between this string and a URL: a stored `a%2Fb.js` decodes to two
	// segments at request time and the two ends of the pipeline disagree about which
	// string the file lives under. Refusing keeps the stored path and the requested path
	// the same string, always.
	if (value.includes("%")) return "Paths cannot carry a % sign.";
	const parts = value.split("/");
	if (parts.some((p) => p === "" || p === "." || p === "..")) {
		return "A path in a build cannot climb out of the build with .. or name an empty segment.";
	}
	if (parts.some((p) => p.includes("?") || p.includes("#"))) {
		return "A path in a build cannot carry ? or # — the browser cuts the URL at them.";
	}
	if (value.length > 250) return "That path is too long.";
	return null;
}

/** The content-type of the files a build actually contains. Everything else is octet-stream. */
export function buildFileContentType(filePath: string): string {
	const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
	return (
		{
			".html": "text/html;charset=utf-8",
			".js": "text/javascript",
			".mjs": "text/javascript",
			".wasm": "application/wasm",
			".pck": "application/octet-stream",
			".json": "application/json",
			".css": "text/css",
			".png": "image/png",
			".jpg": "image/jpeg",
			".jpeg": "image/jpeg",
			".svg": "image/svg+xml",
			".ico": "image/x-icon",
			".woff2": "font/woff2",
			".data": "application/octet-stream",
			".zip": "application/zip",
		}[ext] ?? "application/octet-stream"
	);
}

/** Whether a requested path is an HTML document — the kind the save shim rides in. */
export function contentTypeIsHtml(filePath: string): boolean {
	return filePath.toLowerCase().endsWith(".html");
}

/**
 * Inject the save shim into a served entry document, as the FIRST thing in `<head>` —
 * ahead of every engine script, so the shim's message listener exists before the
 * engine's boot pull could miss it.
 *
 * 🚨 **Injection is idempotent and fails open to unmodified content.** A document
 * already carrying the shim (an entry a creator pre-injected in an earlier session —
 * impossible today, but the rule costs one check) is served unchanged; a document with
 * no `<head>` at all gets the shim after `<html>`, or prepended when no `<html>`
 * either. The shim never changes what the build is, only what it can reach.
 */
export function injectSaveShim(html: string, runtime: string, script: string): string {
	if (html.includes("anthers-save-shim")) return html;
	const tag = `<script data-anthers-save-shim>${script}</script>`;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/<html[^>]*>/i, (m) => `${m}${tag}`);
	}
	return `${tag}${html}`;
}

// ── The play token ────────────────────────────────────────────────────────────
//
// The Anthers session never reaches the delivery origin, so the entitlement rides in
// the URL itself: an HMAC-signed payload naming the Work, with an expiry, minted only
// at a moment the gates were just re-checked. This is the same model *How a File
// Reaches You* describes for signed media — an address that expires rather than being
// reusable — carried one step further out, to an origin that never holds the cookie.

type Env = Record<string, string | undefined>;

export interface PlayTokenPayload {
	/** The Work the token plays. The delivery route re-resolves the Work row, so a deleted Work invalidates every outstanding token for it. */
	w: number;
	iat: number;
	exp: number;
}

/** The signing key. Null when a public deployment has none configured — the mint route refuses rather than minting under a secret nobody chose. */
let devEphemeralSecret: Buffer | null = null;

export function webBuildSigningSecret(env: Env = process.env): Buffer | null {
	const raw = env.WEB_BUILD_SIGNING_KEY?.trim();
	if (raw) return Buffer.from(raw, "utf8");
	// A checkout signs with a secret minted at boot: tokens die with the process, which
	// is the right behavior for dev, where nothing is long-lived. A public deployment
	// gets none rather than a generated one — it fails closed, exactly as the admin host
	// does with no `ADMIN_URL`.
	if (!isPublicDeployment(env)) {
		devEphemeralSecret ??= randomBytes(32);
		return devEphemeralSecret;
	}
	return null;
}

function b64url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

export function mintPlayToken(workId: number, ttlSeconds: number, env: Env = process.env): string {
	const secret = webBuildSigningSecret(env);
	if (!secret) throw new Error("a play token cannot be minted without a signing key");
	const now = Math.floor(Date.now() / 1000);
	const payload: PlayTokenPayload = { w: workId, iat: now, exp: now + ttlSeconds };
	const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
	const mac = b64url(createHmac("sha256", secret).update(body).digest());
	return `${body}.${mac}`;
}

/** Verify a presented token, returning its payload — or null for anything else. */
export function verifyPlayToken(token: string, env: Env = process.env): PlayTokenPayload | null {
	const secret = webBuildSigningSecret(env);
	if (!secret) return null;
	const dot = token.lastIndexOf(".");
	if (dot < 0) return null;
	const body = token.slice(0, dot);
	const mac = Buffer.from(token.slice(dot + 1), "base64url");
	const expected = createHmac("sha256", secret).update(body).digest();
	// `timingSafeEqual` throws on a length mismatch, which would itself be a timing
	// channel; a length check first makes the comparison constant-time or nothing.
	if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
	try {
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PlayTokenPayload;
		if (typeof payload.w !== "number" || typeof payload.exp !== "number") return null;
		if (payload.exp * 1000 < Date.now()) return null;
		return payload;
	} catch {
		return null;
	}
}

/**
 * How long one play token lives. Deliberately shorter than the signed-media TTL (six
 * hours): a token here is a *play session's* entitlement — the page mints one per
 * "Play" press, the runtime holds it for its whole session — and a leaked entry URL
 * should outlive its access for an evening, not for six hours of shares.
 */
export const PLAY_TOKEN_TTL_SECONDS = 2 * 60 * 60;

// ── The delivery origin ───────────────────────────────────────────────────────

/**
 * The host a build is served from, for a Work with this publicId.
 *
 * Production: `<publicId>.<BUILD_ORIGIN_SUFFIX>` — one `anthers.run` subdomain per Work.
 *
 * A checkout with the suffix unset serves the build from the API's own host — the
 * documented dev deviation, one origin across every Work, so saves are shared per
 * origin exactly as the harness's are — which the caller knows from the request and
 * this function takes as the second argument. A public deployment without the suffix
 * has no delivery host at all and the mint route refuses — the feature is off, not
 * weakened.
 *
 * Env-injectable like `adminOrigin`, so a test can point the suffix at a `.test`
 * address without a request in hand.
 */
export function buildDeliveryHost(
	publicId: number,
	env: Env = process.env,
	requestHost?: string,
): string | null {
	const suffix = env.BUILD_ORIGIN_SUFFIX?.trim();
	if (suffix) return `${publicId}.${suffix.toLowerCase()}`;
	if (!isPublicDeployment(env) && requestHost) return requestHost;
	return null;
}

/** Whether a request's host is addressed to the delivery origin. */
export function isBuildDeliveryHost(host: string, env: Env = process.env): boolean {
	const suffix = env.BUILD_ORIGIN_SUFFIX?.trim();
	if (suffix) {
		// 🚨 A subdomain label is required before the suffix, so the bare domain and a
		// forged exact match `anthers.run` refuse: nothing Anthers runs as itself is ever
		// served from the delivery origin, and the check is where that starts.
		return (
			host.toLowerCase() !== suffix.toLowerCase() &&
			host.toLowerCase().endsWith(`.${suffix.toLowerCase()}`)
		);
	}
	// A checkout serves delivery from whatever host reached it (the API's own, in dev),
	// the same open-host posture `admin-host.ts` takes without its URL — it is what makes
	// the route testable. A public deployment without the suffix answers nowhere.
	return !isPublicDeployment(env);
}
