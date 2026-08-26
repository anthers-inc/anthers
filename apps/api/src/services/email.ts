// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Transactional email via Resend.
 *
 * Centralizes outbound email. When RESEND_API_KEY is unset (typical for local
 * dev), sends become no-ops that log to the console; senders that carry an
 * actionable link also log the link so the flow can still be completed locally.
 *
 * The default sender is on the Resend-verified anthers.org domain; override with
 * EMAIL_FROM (must also be on a Resend-verified domain). The onboarding@resend.dev
 * sandbox sender only delivers to the Resend account owner, so it can't be used
 * for real user email.
 */
import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM ?? "Anthers <noreply@anthers.org>";

/** Base URL of the web frontend, for links users click (verify email, etc.). */
function frontendUrl(): string {
	return (process.env.FRONTEND_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

let cached: Resend | null = null;
function resendClient(): Resend | null {
	const key = process.env.RESEND_API_KEY;
	if (!key) return null;
	cached ??= new Resend(key);
	return cached;
}

interface SendArgs {
	to: string;
	subject: string;
	html: string;
}

/**
 * What became of a send.
 *
 * 🚨 **An object rather than a boolean, deliberately, and every call site was updated
 * rather than given a compatible shim.** A `{ sent }` object is always truthy, so an
 * un-updated `if (!sent)` would have silently started treating every failure as a
 * success — on the escalation path, where a failure is an alert nobody got. Changing the
 * type so the compiler names all three call sites is the point; a shim that kept them
 * compiling is the version of this change that ships a bug.
 */
export interface SendResult {
	/** Whether the provider accepted the message. NOT whether it arrived. */
	sent: boolean;
	/**
	 * The provider's id for the message, when there is one.
	 *
	 * ⭐ **This is what makes delivery checkable at all.** Without it, "the alert was
	 * sent" can only ever mean *we handed it to Resend and it did not complain*, which is
	 * a claim about our side of a network call. With it, {@link emailDeliveryStatus} can
	 * ask what actually happened to the message — which is the difference between a test
	 * that ends at our boundary and one that ends at the mailbox.
	 */
	messageId: string | null;
}

/** Dispatch an email. `sent` is provider acceptance, never delivery — see {@link SendResult}. */
export async function sendEmail({ to, subject, html }: SendArgs): Promise<SendResult> {
	// Never send from the test runner, even with a key present.
	//
	// Sign-up sends a verification email inline, so with a local `RESEND_API_KEY` every
	// test that registers a user made a real HTTPS call to Resend — dozens per run, on a
	// path with no timeout of its own. When one of those was slow the test hit Bun's 5s
	// limit, and because the first test in a file usually establishes the session the
	// rest use, one slow request failed five tests. That read as five unrelated flakes,
	// including in a pure-Zod test that never touched the network.
	//
	// Nothing is lost by skipping: callers already log the verification link for local
	// use, and the address is `@example.com`, which Resend rejects with a 422 anyway. A
	// suite whose outcome depends on a third party's latency is not testing our code.
	if (process.env.NODE_ENV === "test") {
		console.warn(`[email] test run — not sending "${subject}" to ${to}`);
		return { sent: false, messageId: null };
	}
	const client = resendClient();
	if (!client) {
		console.warn(`[email] RESEND_API_KEY unset — skipped "${subject}" to ${to}`);
		return { sent: false, messageId: null };
	}
	try {
		const { data, error } = await client.emails.send({ from: FROM, to, subject, html });
		if (error) {
			console.error(`[email] send to ${to} failed:`, error);
			return { sent: false, messageId: null };
		}
		return { sent: true, messageId: data?.id ?? null };
	} catch (err) {
		console.error(`[email] send to ${to} threw:`, err);
		return { sent: false, messageId: null };
	}
}

export function verifyEmailUrl(token: string): string {
	return `${frontendUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

// ─── Templates ───────────────────────────────────────────────────────────────

const BRAND = "#7c3aed";

function shell(heading: string, bodyHtml: string): string {
	return `<!doctype html>
<html lang="en">
	<body style="margin:0;padding:0;background:#0f0e13;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0e13;padding:32px 0;">
			<tr><td align="center">
				<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#1b1a22;border-radius:14px;overflow:hidden;">
					<tr><td style="padding:28px 32px 8px;">
						<div style="font-size:20px;font-weight:700;color:#ffffff;">Anthers</div>
					</td></tr>
					<tr><td style="padding:8px 32px 32px;color:#c9c6d4;font-size:15px;line-height:1.6;">
						<h1 style="margin:0 0 12px;font-size:20px;color:#ffffff;">${heading}</h1>
						${bodyHtml}
					</td></tr>
				</table>
				<div style="color:#6b6878;font-size:12px;margin-top:16px;">Anthers — a fairer home for creators</div>
			</td></tr>
		</table>
	</body>
</html>`;
}

function button(href: string, label: string): string {
	return `<a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:9px;font-size:15px;">${label}</a>`;
}

function verifyBody(intro: string, verifyUrl: string): string {
	return `<p style="margin:0 0 18px;">${intro}</p>
		<p style="margin:0 0 22px;">${button(verifyUrl, "Verify my email")}</p>
		<p style="margin:0 0 6px;color:#8f8ba0;font-size:13px;">Or paste this link into your browser:</p>
		<p style="margin:0;color:#8f8ba0;font-size:13px;word-break:break-all;">${verifyUrl}</p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">This link expires in 24 hours. If you didn't create an Anthers account, you can ignore this email.</p>`;
}

function escapeHtml(s: string): string {
	return s.replace(/[&<>"']/g, (ch) => {
		switch (ch) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

// ─── Senders ─────────────────────────────────────────────────────────────────

/**
 * How to address someone who may not have claimed a handle yet.
 *
 * Since the signup ceremony an account can exist before onboarding names it, and mail
 * still has to reach it. Interpolating the null would greet a reader as "Hi null", so
 * the fallback is to greet nobody in particular and let the sentence carry itself.
 */
function greet(username: string | null): string {
	return username ? `, ${escapeHtml(username)}` : "";
}

/** Welcome + email verification, sent on sign-up. Logs the link when send is skipped (dev). */
export async function sendWelcomeEmail(
	to: string,
	username: string | null,
	token: string,
): Promise<void> {
	const url = verifyEmailUrl(token);
	const html = shell(
		`Welcome to Anthers${greet(username)} 🌱`,
		verifyBody(
			"We're glad you're here. Confirm your email address to unlock purchases, funding, and creator mode.",
			url,
		),
	);
	const sent = await sendEmail({ to, subject: "Welcome to Anthers — verify your email", html });
	if (!sent) console.info(`[email] verify link for ${to}: ${url}`);
}

/**
 * The signup ceremony's code, to an address with no account yet.
 *
 * The code is spelled out in a monospace block rather than wrapped in a button, because
 * the reader's next move is to *type it into six boxes on the page they came from* — a
 * link would take them somewhere else and lose the picks they had already made. That is
 * the whole reason this flow uses a code instead of the verification link above.
 */
export async function sendSignupCodeEmail(to: string, code: string): Promise<void> {
	const html = shell(
		"Your Anthers code",
		`<p style="margin:0 0 18px;">Enter this code on the page you left open to confirm your address:</p>
		<p style="margin:0 0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:#ffffff;">${escapeHtml(code)}</p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">This code expires in 10 minutes. If you didn't ask to join Anthers, you can ignore this email — no account has been created.</p>`,
	);
	const sent = await sendEmail({ to, subject: `${code} is your Anthers code`, html });
	if (!sent) console.info(`[email] signup code for ${to}: ${code}`);
}

/**
 * The same ceremony, to an address that **already has an account** — so it signs in.
 *
 * A separate template rather than a flag on the one above, because the sentence a
 * returning user needs is different: they did not ask to create anything, and telling
 * them "welcome, confirm your address" would be both wrong and alarming.
 *
 * 🚨 What is *not* different is the API's response, which is identical in both cases.
 * The two templates exist so the mail is honest to the one person who can read it; the
 * caller learns nothing, or the "always 200" rule would be decorative.
 */
export async function sendSignInCodeEmail(to: string, code: string): Promise<void> {
	const html = shell(
		"Your Anthers sign-in code",
		`<p style="margin:0 0 18px;">You already have an Anthers account with this address. Enter this code to sign in:</p>
		<p style="margin:0 0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:#ffffff;">${escapeHtml(code)}</p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">This code expires in 10 minutes. If you didn't try to sign in, you can ignore this email — and your account is unchanged.</p>`,
	);
	const sent = await sendEmail({ to, subject: `${code} is your Anthers sign-in code`, html });
	if (!sent) console.info(`[email] sign-in code for ${to}: ${code}`);
}

/** Standalone re-send of the verification email. */
export async function sendVerificationEmail(
	to: string,
	username: string | null,
	token: string,
): Promise<void> {
	const url = verifyEmailUrl(token);
	const html = shell(
		"Verify your email",
		verifyBody(
			`Hi${greet(username)}, confirm your email address to finish setting up your Anthers account.`,
			url,
		),
	);
	const sent = await sendEmail({ to, subject: "Verify your email for Anthers", html });
	if (!sent) console.info(`[email] verify link for ${to}: ${url}`);
}
