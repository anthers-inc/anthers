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

/** Dispatch an email. Returns true if actually sent, false if skipped or errored. */
export async function sendEmail({ to, subject, html }: SendArgs): Promise<boolean> {
	const client = resendClient();
	if (!client) {
		console.warn(`[email] RESEND_API_KEY unset — skipped "${subject}" to ${to}`);
		return false;
	}
	try {
		const { error } = await client.emails.send({ from: FROM, to, subject, html });
		if (error) {
			console.error(`[email] send to ${to} failed:`, error);
			return false;
		}
		return true;
	} catch (err) {
		console.error(`[email] send to ${to} threw:`, err);
		return false;
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

/** Welcome + email verification, sent on sign-up. Logs the link when send is skipped (dev). */
export async function sendWelcomeEmail(to: string, username: string, token: string): Promise<void> {
	const url = verifyEmailUrl(token);
	const html = shell(
		`Welcome to Anthers, ${escapeHtml(username)} 🌱`,
		verifyBody(
			"We're glad you're here. Confirm your email address to unlock purchases, funding, and creator mode.",
			url,
		),
	);
	const sent = await sendEmail({ to, subject: "Welcome to Anthers — verify your email", html });
	if (!sent) console.info(`[email] verify link for ${to}: ${url}`);
}

/** Standalone re-send of the verification email. */
export async function sendVerificationEmail(
	to: string,
	username: string,
	token: string,
): Promise<void> {
	const url = verifyEmailUrl(token);
	const html = shell(
		"Verify your email",
		verifyBody(
			`Hi ${escapeHtml(username)}, confirm your email address to finish setting up your Anthers account.`,
			url,
		),
	);
	const sent = await sendEmail({ to, subject: "Verify your email for Anthers", html });
	if (!sent) console.info(`[email] verify link for ${to}: ${url}`);
}
