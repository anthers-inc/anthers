// SPDX-License-Identifier: Apache-2.0
/**
 * The hand-rolled error tracker — capture, fingerprint, dedupe, alert on first sight.
 *
 * 🚨 **Why this exists rather than Sentry** (Parker, 2026-10-06): error data stays in the
 * database the Privacy Policy already governs, instead of becoming a third party's event
 * stream. Stack messages can quote user content — an exception message carrying a share
 * token or an email address is ordinary — and the whole point of the tooling decision was
 * to keep that inside our own Postgres. The cost is that everything Sentry's pipeline does
 * beyond capture-dedupe-alert (symbolication, releases UI, issue workflow) is declined
 * here: a browser stack is stored raw and minified, for the Admin module to remap against
 * source maps later — never prettified at write time.
 *
 * The design rule that shapes everything: **a row is an issue, not an occurrence.** The
 * fingerprint (SHA-256 of source + normalized message + top frame names) is the row's
 * identity; every recurrence increments `count` and refreshes `lastSeenAt`. The alert rule
 * follows the noisy-channel lesson: tell the operator **once per fingerprint** — no
 * re-alerting on every occurrence, which trains the operator to ignore the channel
 * (`sendOperationalAlert` already exists and is the one mail path; nothing new sends mail
 * here beyond asking it).
 *
 * **The ingest never 500s.** `captureError` is called from the `app.onError` handler and
 * from the browser-beacon route; both wrap it so a tracker failure logs and continues —
 * a failed capture must never become the error that pages. This module returns plain
 * objects and never throws; every catch is deliberate.
 */
import { createHash } from "node:crypto";
import { db } from "@anthers/db/client";
import { errorEvents } from "@anthers/db/schema";
import { APP_VERSION } from "@anthers/shared/version";
import { eq, sql } from "drizzle-orm";
import { sendOperationalAlert } from "./email.js";

/** Where an error was caught. Browser events arrive through the beacon route, API events through onError. */
export type ErrorSource = "api" | "browser";

/** One stack frame as stored — raw, capped, never symbolicated at write time. */
export interface ErrorFrame {
	/** Function or method name, as the frame named it (minified for browser events). */
	fn: string;
	/** File plus line:column, as the frame reported it. */
	loc: string;
}

/** The environment of the last capture, stored as `sample_context` and overwritten per occurrence. */
export interface ErrorContext {
	/** The request path, redacted — ids and tokens shape-matched out, never stored raw. */
	route?: string;
	/** HTTP method, for an API capture. */
	method?: string;
	/** The user agent that saw the error, for a browser capture. Capped. */
	userAgent?: string;
	/** The release that first rendered this capture's shape. Redundant with the column; kept for the sample. */
	release?: string;
}

/** What one capture is handed, already capped by the caller's own layer. */
export interface CapturedError {
	source: ErrorSource;
	/** The raw message. Normalized (and redacted) here, before it reaches the database. */
	message: string;
	/** Stack text if the caller has it; a browser beacon carries its own parsed frames instead. */
	stack?: string;
	/** Pre-parsed frames from the browser beacon, which arrives as JSON, not stack text. */
	frames?: ErrorFrame[];
	context?: ErrorContext;
}

// ── Caps — every cap here is a spam-resistance decision, not a storage saving ─────────

const MAX_MESSAGE = 500;
const MAX_FRAMES = 10;
const MAX_FRAME_FN = 150;
const MAX_FRAME_LOC = 200;
const MAX_USER_AGENT = 300;
const MAX_ROUTE = 300;

/**
 * Token- and email-shaped substrings, redacted before anything is stored. The beacon and
 * the API capture both run through this: an exception message is the likeliest place a
 * share-link token (`/s/:token`) or a user's email address survives into a stored row.
 * Shapes rather than known prefixes — the tokens are opaque by construction.
 */
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_SHAPE = /\/s\/[A-Za-z0-9_-]{8,}/g;
const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function redact(text: string): string {
	return text
		.replace(EMAIL_SHAPE, "[email]")
		.replace(TOKEN_SHAPE, "/s/[token]")
		.replace(UUID_SHAPE, "[id]");
}

/**
 * Normalize a message for fingerprinting: redact, then flatten per-request variation —
 * numbers that are ids or counts, and quoted strings — so two captures of one defect hash
 * alike. Numbers are replaced in one pass; a message that legitimately distinguishes
 * defects by a number ("HTTP 429" vs "HTTP 500") is rare enough that the fingerprint keeps
 * the frame names, which do distinguish them.
 */
export function normalizeMessage(raw: string): string {
	const capped = redact(String(raw ?? "")).slice(0, MAX_MESSAGE);
	return capped
		.replace(/".*?"/g, '"…"')
		.replace(/\b\d+\b/g, "N")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parse stack text into capped frames, tolerating Firefox (`fn@loc`) and V8 (`at fn (loc)`). */
export function parseStack(stack: string): ErrorFrame[] {
	if (!stack) return [];
	const frames: ErrorFrame[] = [];
	for (const line of String(stack).split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		// V8: "    at fn (loc)" or "    at loc" — Firefox: "fn@loc" or "fn@loc:col"
		const v8 = /^(?:at\s+)(.*?)(?:\s+\((.+)\))?$/;
		const ff = /^(.*?)@(.+)$/;
		let fn = "";
		let loc = "";
		const v8Match = v8.exec(trimmed);
		if (v8Match && trimmed.startsWith("at ")) {
			fn = v8Match[1] || "";
			loc = v8Match[2] || v8Match[1] || "";
			if (v8Match[2]) {
				// "at fn (loc)": group 1 is the fn, group 2 the loc.
				fn = v8Match[1];
				loc = v8Match[2];
			}
		} else {
			const ffMatch = ff.exec(trimmed);
			if (ffMatch) {
				fn = ffMatch[1];
				loc = ffMatch[2];
			}
		}
		if (!loc) continue;
		frames.push({
			fn: fn.slice(0, MAX_FRAME_FN),
			loc: redact(loc).slice(0, MAX_FRAME_LOC),
		});
		if (frames.length >= MAX_FRAMES) break;
	}
	return frames;
}

function fingerprintFor(source: ErrorSource, message: string, frames: ErrorFrame[]): string {
	const hash = createHash("sha256");
	hash.update(source);
	hash.update("\n");
	hash.update(message);
	hash.update("\n");
	for (const frame of frames.slice(0, MAX_FRAMES)) {
		hash.update(frame.fn);
		hash.update("\n");
	}
	return hash.digest("hex").slice(0, 32);
}

/** The alert fire-hose guard: at most one first-seen alert per fingerprint, ever. */
function sampleContextFor(context: ErrorContext | undefined, release: string): ErrorContext {
	if (!context) return release ? { release } : {};
	return {
		...context,
		route: context.route ? context.route.slice(0, MAX_ROUTE) : undefined,
		method: context.method,
		userAgent: context.userAgent ? context.userAgent.slice(0, MAX_USER_AGENT) : undefined,
		release,
	};
}

export interface CaptureResult {
	/** True when this capture was the fingerprint's first — the alerting half is the caller's. */
	firstSeen: boolean;
	fingerprint: string;
	count: number;
}

/**
 * Capture one error. Reads-and-writes its own row; the caller wraps this in try/catch and
 * continues whatever it was doing. Never throws — see the module docblock's ingest rule.
 */
export async function captureError(captured: CapturedError): Promise<CaptureResult | null> {
	const message = normalizeMessage(captured.message);
	if (!message) return null;
	const frames = captured.frames?.length
		? captured.frames.slice(0, MAX_FRAMES)
		: parseStack(captured.stack ?? "");
	const fingerprint = fingerprintFor(captured.source, message, frames);
	const context = sampleContextFor(captured.context, APP_VERSION);

	try {
		const rows = await db
			.insert(errorEvents)
			.values({
				fingerprint,
				source: captured.source,
				message,
				topFrames: JSON.stringify(frames),
				release: APP_VERSION,
				sampleContext: context,
			})
			.onConflictDoUpdate({
				target: errorEvents.fingerprint,
				set: {
					count: sql`${errorEvents.count} + 1`,
					lastSeenAt: new Date(),
					release: APP_VERSION,
					sampleContext: context,
				},
			})
			.returning({
				count: errorEvents.count,
				firstSeenAt: errorEvents.firstSeenAt,
				alertSentAt: errorEvents.alertSentAt,
			});
		const row = rows[0];
		if (!row) return null;
		// firstSeen: the returning count is 1 only on a fresh insert — an update of a
		// count-1 row lands 2, so a stale repeat cannot re-read as first.
		const firstSeen = row.count === 1;
		return { firstSeen, fingerprint, count: row.count };
	} catch (error) {
		// The tracker failing must never become the incident. Log and continue.
		console.error(
			"[error-tracker] capture failed:",
			error instanceof Error ? error.message : error,
		);
		return null;
	}
}

/**
 * Whether this fingerprint should alert now: first-seen always; later, only when the
 * fingerprint has gone quiet long enough that a new sight is news rather than noise. A
 * defect recurring every minute for a week is one conversation, not five thousand.
 */
const RESURFACE_AFTER_MS = 24 * 60 * 60 * 1000;

export function shouldAlert(row: { count: number; alertSentAt: Date | null }): boolean {
	if (row.count === 1) return true;
	if (!row.alertSentAt) return true;
	return Date.now() - row.alertSentAt.getTime() >= RESURFACE_AFTER_MS;
}

/** Mark an alert as sent for a fingerprint, so `shouldAlert`'s callers can record it. */
export async function markAlerted(fingerprint: string): Promise<void> {
	try {
		await db
			.update(errorEvents)
			.set({ alertSentAt: new Date() })
			.where(eq(errorEvents.fingerprint, fingerprint));
	} catch (error) {
		console.error(
			"[error-tracker] alert mark failed:",
			error instanceof Error ? error.message : error,
		);
	}
}

/**
 * Read the row back and decide whether this capture should alert — the second half of
 * `captureError`, split so the capture stays cheap and the alert decision can read
 * `alertSentAt` (which the upsert's returning clause does not carry). Never throws.
 */
export async function alertDue(result: CaptureResult): Promise<boolean> {
	if (!result) return false;
	try {
		const rows = await db
			.select({ count: errorEvents.count, alertSentAt: errorEvents.alertSentAt })
			.from(errorEvents)
			.where(eq(errorEvents.fingerprint, result.fingerprint))
			.limit(1);
		const row = rows[0];
		return row ? shouldAlert(row) : false;
	} catch (error) {
		console.error(
			"[error-tracker] alert check failed:",
			error instanceof Error ? error.message : error,
		);
		return false;
	}
}

/**
 * Fire the operational alert for one captured error and mark it sent. Ask
 * `sendOperationalAlert` once per alert-worthy capture; a mail failure must not fail the
 * handler — the error is already in the database, and the console line below carries it.
 */
export async function alertOperational(
	result: CaptureResult,
	error: unknown,
	req: { method: string; path: string },
): Promise<void> {
	try {
		const name = error instanceof Error ? error.name : "Error";
		await sendOperationalAlert({
			subject: `[anthers] ${name}: firstseen ${result.fingerprint.slice(0, 8)}`,
			html:
				`<p>An error was captured on <code>${redactRoute(req.path)}</code> (${req.method}).</p>` +
				`<p>Fingerprint <code>${result.fingerprint}</code>, occurrence ${result.count}.</p>`,
		});
		await markAlerted(result.fingerprint);
	} catch (mailError) {
		console.error(
			"[error-tracker] alert send failed:",
			mailError instanceof Error ? mailError.message : mailError,
		);
	}
}

/**
 * Redact a request path for storage: uuid- and token-shaped segments out, ids shape-matched
 * out. Route shapes are stored — `/works/n-[id]` — never the addressing that hit them.
 */
export function redactRoute(path: string): string {
	return path
		.replace(UUID_SHAPE, "[id]")
		.replace(/\/\d+(?=\/|$)/g, "/[id]")
		.slice(0, MAX_ROUTE);
}
