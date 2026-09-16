// SPDX-License-Identifier: Apache-2.0
/**
 * Transactional email via Resend.
 *
 * Centralizes outbound email. A local session delivers every message to its mail catcher
 * (`MAIL_CATCHER_URL`, which `scripts/session.ts` sets), so a code or a link arrives in an inbox
 * the session can read rather than in somebody's real mailbox. Without a catcher and without
 * RESEND_API_KEY, sends become no-ops that log to the console; senders that carry a code or an
 * actionable link log it too, so the flow can still be completed locally.
 *
 * The default sender is on the Resend-verified anthers.org domain; override with
 * EMAIL_FROM (must also be on a Resend-verified domain). The onboarding@resend.dev
 * sandbox sender only delivers to the Resend account owner, so it can't be used
 * for real user email.
 */
import { ABUSE_EMAIL } from "@anthers/shared/constants";
import { Resend } from "resend";
import { isPublicDeployment } from "../lib/deployment.js";

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
	const catcher = mailCatcherUrl();
	if (catcher) return deliverToCatcher(catcher, { to, subject, html });
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

/**
 * The session's mail catcher, or null when mail should go to Resend.
 *
 * 🚨 **Never in a public deployment, whatever the environment says.** A catcher in production would
 * swallow every code and alert while reporting each one sent — sign-in would stop working for
 * everybody and nothing would say why — so the variable is ignored there rather than trusted.
 */
export function mailCatcherUrl(
	env: Record<string, string | undefined> = process.env,
): string | null {
	const url = env.MAIL_CATCHER_URL?.trim().replace(/\/+$/, "");
	if (!url || isPublicDeployment(env)) return null;
	return url;
}

/**
 * Hand a message to the session's mail catcher through its send API.
 *
 * ⭐ **It takes precedence over Resend inside a session**, including when `make dev` has put the dev
 * Resend key in the environment: a session's addresses are fixture addresses, and an inbox the
 * session can read is what lets an emailed code be finished by hand or by a browser spec.
 */
async function deliverToCatcher(
	catcher: string,
	{ to, subject, html }: SendArgs,
): Promise<SendResult> {
	const from = FROM.match(/^(.*?)\s*<(.+)>$/);
	try {
		const res = await fetch(`${catcher}/api/v1/send`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				From: from ? { Name: from[1], Email: from[2] } : { Email: FROM },
				To: [{ Email: to }],
				Subject: subject,
				HTML: html,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			console.error(`[email] the mail catcher refused "${subject}" to ${to}: HTTP ${res.status}`);
			return { sent: false, messageId: null };
		}
		const body = (await res.json().catch(() => ({}))) as { ID?: string };
		return { sent: true, messageId: body.ID ?? null };
	} catch (err) {
		console.error(`[email] the mail catcher at ${catcher} did not answer:`, err);
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

/**
 * ⚠️ **Exported, and there are four private copies of this in `services/` besides.** This
 * one is exported rather than a fifth being written; consolidating the others is a tidy-up
 * nobody has done, and adding to the pile would have made it worse.
 */
export function escapeHtml(s: string): string {
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
	const { sent } = await sendEmail({ to, subject: `${code} is your Anthers code`, html });
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
	const { sent } = await sendEmail({ to, subject: `${code} is your Anthers sign-in code`, html });
	if (!sent) console.info(`[email] sign-in code for ${to}: ${code}`);
}

/**
 * A sign-in code for the admin app, to an admin account's own address.
 *
 * Says *admin* in the subject and the body, so a code for the console is never mistaken for an
 * ordinary Anthers sign-in, and so somebody who did not ask for one knows what was attempted.
 */
export async function sendAdminSignInCodeEmail(to: string, code: string): Promise<void> {
	const html = shell(
		"Your Anthers admin sign-in code",
		`<p style="margin:0 0 18px;">Enter this code to sign in to the Anthers admin app:</p>
		<p style="margin:0 0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:#ffffff;">${escapeHtml(code)}</p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">This code expires in 10 minutes. If you didn't try to sign in to the admin app, somebody else tried to with your address, and nothing has changed.</p>`,
	);
	const { sent } = await sendEmail({
		to,
		subject: `${code} is your Anthers admin sign-in code`,
		html,
	});
	if (!sent) console.info(`[email] admin sign-in code for ${to}: ${code}`);
}

/**
 * Telling somebody they have been given an admin account.
 *
 * There is no link to accept and nothing to set up, because the account already exists and signing in
 * with a code sent to this address is all joining takes. The message names who added them, so an
 * invitation nobody expected is recognizable as one.
 */
export async function sendAdminInvitationEmail(
	to: string,
	invitedBy: string,
	adminUrl: string,
): Promise<void> {
	const html = shell(
		"You have an Anthers admin account",
		`<p style="margin:0 0 18px;">${escapeHtml(invitedBy)} has given you an admin account for running Anthers. Sign in with this address at:</p>
		<p style="margin:0 0 22px;"><a href="${escapeHtml(adminUrl)}" style="color:${BRAND};">${escapeHtml(adminUrl)}</a></p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">You'll be sent a code each time you sign in. If you weren't expecting this, tell ${escapeHtml(invitedBy)} or reply to this email.</p>`,
	);
	const { sent } = await sendEmail({ to, subject: "You have an Anthers admin account", html });
	if (!sent) console.info(`[email] admin invitation for ${to}: ${adminUrl}`);
}

// ─── What a DMCA complainant is told ─────────────────────────────────────────

/**
 * The notice a complainant email is about. Structural rather than the table's row type, so this
 * module does not depend on the schema package for three fields and a date.
 */
export interface ComplainantNotice {
	id: number;
	complainantName: string;
	complainantEmail: string;
	workTitle: string;
	receivedAt: Date;
}

/** The copy of a counter-notice a complainant is sent, as the creator filed it. */
export interface ForwardedCounterNotice {
	subscriberName: string;
	subscriberAddress: string;
	subscriberPhone: string;
	jurisdictionConsent: string;
	goodFaithStatement: string;
	attestationTextSnapshot: string;
	filedAt: string;
}

/**
 * Where a complainant writes back: the designated agent while one is registered, and otherwise the
 * address `/copyright` gives for the same purpose, so the email and the page never disagree.
 */
function copyrightContact(): string {
	return process.env.DMCA_AGENT_EMAIL?.trim() || "contact@anthers.org";
}

/** A date as a person reads it, in UTC so the server's zone never shifts it by a day. */
function longDate(date: Date | string): string {
	return new Date(date).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
}

function aboutNotice(notice: ComplainantNotice): string {
	const title = notice.workTitle ? ` about "${escapeHtml(notice.workTitle)}"` : "";
	return `your copyright notice #${notice.id}${title}, received on ${longDate(notice.receivedAt)}`;
}

/** A labeled block of the complainant email, with the value's own line breaks kept. */
function quoted(label: string, value: string): string {
	return `<p style="margin:0 0 4px;color:#8f8ba0;font-size:13px;">${label}</p>
		<p style="margin:0 0 14px;">${escapeHtml(value).replace(/\n/g, "<br>") || "—"}</p>`;
}

/**
 * Send one complainant email, or report it unsent when there is no address. Retention blanks the
 * complainant's contact details after three years, and an empty recipient is a send that cannot
 * succeed rather than one worth handing to the provider.
 */
function toComplainant(notice: ComplainantNotice, subject: string, html: string) {
	if (!notice.complainantEmail.trim()) {
		return Promise.resolve<SendResult>({ sent: false, messageId: null });
	}
	return sendEmail({ to: notice.complainantEmail, subject, html });
}

/** Telling a complainant that the material their notice identifies has been taken down. */
export async function sendDmcaTakedownAcknowledgment(
	notice: ComplainantNotice,
): Promise<SendResult> {
	const html = shell(
		"We have acted on your copyright notice",
		`<p style="margin:0 0 18px;">Hi ${escapeHtml(notice.complainantName)}, we have acted on ${aboutNotice(notice)}. The material it identifies has been removed from Anthers.</p>
		<p style="margin:0 0 18px;">We have told the person who uploaded it. If they believe it was removed by mistake, they may send a counter-notice, and if they do, we will email you a copy of it along with the date the material will be restored unless you tell us you have filed a court action.</p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">Questions about this notice can go to ${escapeHtml(copyrightContact())}.</p>`,
	);
	return toComplainant(
		notice,
		`Your copyright notice #${notice.id}: the material has been removed`,
		html,
	);
}

/**
 * Telling a complainant that their notice could not be acted on, and why. The reason is the
 * operator's own note, which is what § 512(c)(3)(B)(ii)'s reach-back asks for: the complainant is
 * told what was missing so that a notice which nearly complied can be sent again complete.
 */
export async function sendDmcaRejection(
	notice: ComplainantNotice,
	reason: string,
): Promise<SendResult> {
	const html = shell(
		"We could not act on your copyright notice",
		`<p style="margin:0 0 18px;">Hi ${escapeHtml(notice.complainantName)}, we have reviewed ${aboutNotice(notice)}, and we could not act on it as it was filed. The material it identifies has not been removed.</p>
		${quoted("Why", reason)}
		<p style="margin:0 0 18px;">If you can supply what is missing, you can file a new notice at ${escapeHtml(frontendUrl())}/copyright or write to ${escapeHtml(copyrightContact())}, and we will review it again.</p>`,
	);
	return toComplainant(notice, `Your copyright notice #${notice.id}: we could not act on it`, html);
}

/**
 * Forwarding a counter-notice to the complainant, as 17 U.S.C. § 512(g)(2)(B) requires: a copy of
 * it, and the window in which the material will be restored unless they tell the designated agent
 * they have filed an action seeking a court order against the person who uploaded it. The copy is
 * the counter-notice as filed, including the attestation text the uploader agreed to.
 */
export async function sendCounterNoticeCopy(
	notice: ComplainantNotice,
	counterNotice: ForwardedCounterNotice,
	restoreWindow: { from: Date; by: Date },
): Promise<SendResult> {
	const contact = escapeHtml(copyrightContact());
	const html = shell(
		"A counter-notice was filed against your copyright notice",
		`<p style="margin:0 0 18px;">Hi ${escapeHtml(notice.complainantName)}, the person who uploaded the material identified in ${aboutNotice(notice)} has sent a counter-notice under 17 U.S.C. § 512(g)(3). A copy of it follows.</p>
		<p style="margin:0 0 18px;">We will restore the material between ${longDate(restoreWindow.from)} and ${longDate(restoreWindow.by)}, unless before then our designated agent receives notice from you that you have filed an action seeking a court order to restrain this person from engaging in infringing activity relating to the material on Anthers. To give that notice, write to ${contact}.</p>
		<hr style="border:none;border-top:1px solid #34323f;margin:22px 0;">
		${quoted("Name", counterNotice.subscriberName)}
		${quoted("Postal address", counterNotice.subscriberAddress)}
		${quoted("Telephone", counterNotice.subscriberPhone)}
		${quoted("Consent to jurisdiction", counterNotice.jurisdictionConsent)}
		${quoted("Statement under penalty of perjury", counterNotice.goodFaithStatement)}
		${quoted("What they attested to", counterNotice.attestationTextSnapshot)}
		${quoted("Filed", longDate(counterNotice.filedAt))}`,
	);
	return toComplainant(
		notice,
		`Your copyright notice #${notice.id}: a counter-notice was filed`,
		html,
	);
}

/**
 * The answer to a data-rights request, sent to the address the request came from, when the
 * account that made it no longer exists.
 *
 * A requester who still has an account is told through `notify`, which keeps the in-app record
 * and emails the account's address, so this is only the other case. It is a likely one: somebody
 * who asks what Anthers holds about them and then deletes their account. The Privacy Policy's
 * promise to answer does not lapse with the account, and `rights_requests.email` is captured at
 * request time for exactly this. With no account to link to and no in-app copy, the message
 * carries the whole answer, and it is returned rather than swallowed so the operator can be told
 * when it did not go.
 */
export async function sendRightsRequestAnswerEmail(to: string, note: string): Promise<SendResult> {
	const answer = note
		? escapeHtml(note).replace(/\n/g, "<br>")
		: "We've responded to the request you made.";
	const html = shell(
		"Your data request has been answered",
		`<p style="margin:0 0 18px;">${answer}</p>
		<p style="margin:22px 0 0;color:#6b6878;font-size:12px;">You're receiving this because a data-rights request was made to Anthers from this address. The account that made it has since been deleted, so this email is the only copy of the answer. If anything in it is wrong or incomplete, write to privacy@anthers.org.</p>`,
	);
	return sendEmail({ to, subject: "Your data request has been answered", html });
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
	const { sent } = await sendEmail({ to, subject: "Verify your email for Anthers", html });
	if (!sent) console.info(`[email] verify link for ${to}: ${url}`);
}

/**
 * The alert that a floor-level report has been filed — the one email on this site that
 * summons a person rather than informing one.
 *
 * 🚨 **It refuses to send from anywhere but a public deployment, and that refusal is the
 * point.** `abuse@` is a mailbox somebody has to read *immediately*, so anything that puts
 * a message in it which does not need immediate human review is not noise in the ordinary
 * sense — it is noise in the one channel that must never be skimmed. A developer's machine
 * has no reports worth summoning anybody over: they are fixtures, or they are a person
 * clicking around their own dev database.
 *
 * ⚠️ **This is what stood between a test fixture and Parker's phone on 2026-08-26, and it
 * did not exist.** `bun test` cannot send — `sendEmail` refuses under the test runner — but
 * the tests were leaving `moderation_reports` rows behind with `escalated_at` null, and
 * `escalate-reports` runs every five minutes in the worker. The moment `make dev` ran with a
 * real `RESEND_API_KEY` from the dev vault, the worker drained a whole session's fixtures
 * into a real inbox: 390 alerts, 168 of them in one hour. **A guard on the sender does not
 * cover a test that writes a row somebody else's process will act on later** — the side
 * effect simply waits until it is outside the guard's process.
 *
 * ⭐ `isPublicDeployment()` rather than a `NODE_ENV` label, for the reason `lib/deployment.ts`
 * gives at length: an https origin *is* what "deployed somewhere public" means, it cannot
 * become true on a developer's machine by accident, and it is already configured.
 *
 * Set `ABUSE_ALERTS_ENABLED=true` to send anyway — for deliberately exercising the delivery
 * loop against a real mailbox, which is the only reason to want this off a public deployment.
 *
 * ⚠️ **`abuseAlertsEnabled()` is exported so the SWEEPS can ask before they start**, rather
 * than discovering it once per row. A withheld alert leaves `escalated_at` null, which is
 * correct — nobody was told — so the every-five-minutes cron retried the whole backlog
 * forever, printing a line per report each time. Refusing at the top is one decision instead
 * of hundreds, and it does no database work it cannot use.
 */
export function abuseAlertsEnabled(): boolean {
	return isPublicDeployment() || process.env.ABUSE_ALERTS_ENABLED === "true";
}

export async function sendAbuseAlert(args: { subject: string; html: string }): Promise<SendResult> {
	if (!abuseAlertsEnabled()) {
		console.warn(
			`[email] withheld abuse alert "${args.subject}" — not a public deployment. ` +
				"Set ABUSE_ALERTS_ENABLED=true to send from here.",
		);
		return { sent: false, messageId: null };
	}
	return sendEmail({ to: ABUSE_EMAIL, subject: args.subject, html: args.html });
}

/**
 * An alert to whoever operates Anthers' infrastructure.
 *
 * 🛑 **Deliberately NOT `abuse@`.** That mailbox summons a person to stop what they are
 * doing and look at reported content, and the standing rule is that nothing may train its
 * reader to skim it. An infrastructure alert is a different job for a different person on a
 * different clock, so it gets its own address rather than borrowing the one that already
 * commands attention.
 *
 * ⚠️ **The recipient is configuration and there is no default**, because a default would be
 * a guess at a mailbox that may not exist — and an alert delivered to a bouncing address is
 * indistinguishable from no alert at all. Unset, this logs loudly and reports that it did
 * not send, so the caller can record that nobody was told.
 */
export async function sendOperationalAlert(args: {
	subject: string;
	html: string;
}): Promise<SendResult> {
	const to = process.env.OPS_ALERT_EMAIL?.trim();
	if (!to) {
		console.error(
			`[email] NOBODY WAS TOLD: "${args.subject}" — OPS_ALERT_EMAIL is unset, so this ` +
				"operational alert had no recipient. Set it.",
		);
		return { sent: false, messageId: null };
	}
	if (!abuseAlertsEnabled()) {
		console.warn(`[email] withheld operational alert "${args.subject}" — not a public deployment.`);
		return { sent: false, messageId: null };
	}
	return sendEmail({ to, subject: args.subject, html: args.html });
}
