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

import { emailGrassFloorDataUri, emailVineTileDataUri } from "@anthers/brand";
import { ABUSE_EMAIL } from "@anthers/shared/constants";
import { Resend } from "resend";
import { isPublicDeployment } from "../lib/deployment.js";

const FROM = process.env.EMAIL_FROM ?? "Anthers <noreply@anthers.org>";

/** Base URL of the web frontend, for links users click. */
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

// ─── Templates ───────────────────────────────────────────────────────────────

/**
 * The Meadow palette as email may render it. The theme's tokens are oklch
 * (theme.css in @anthers/web-shared is the source of truth for every exact
 * value), but email HTML carries no stylesheet, and a CSS color function is not
 * something the major clients reliably honor inside inline styles — so the
 * light-theme tokens are transcribed here to hex and kept beside the token they
 * came from, the way `meadowColors.ts` already tracks the palette it bakes.
 *
 * Anthers' email renders the light theme on purpose: a transactional mail arrives
 * in a client nobody themed, the light surface is the site's default, and the
 * dark theme's near-black ground reads as "newsletter" rather than as the site.
 */
const MEADOW = {
	/** base-100, the site's cream ground — oklch(98.6% 0.012 96). */
	ground: "#fdfbf2",
	/** base-200, the raised surface — oklch(95.2% 0.024 98). */
	card: "#f3f0de",
	/** base-content, the green ink the wordmark, headings and body copy are set in — oklch(31% 0.05 155). */
	ink: "#193825",
	/** The same ink, spelled for the wordmark and heading roles that share it. */
	wordmark: "#193825",
	/** primary, the green of links and standing CTA color — oklch(49% 0.11 152). */
	primary: "#227240",
	/** base-content at half strength, the muted color the site computes with color-mix. */
	muted: "#4d5f52",
	/** base-content at ~30% strength, for the footer line. */
	footnote: "#80907f",
	/** base-content at ~12% strength, the card's hairline edge. */
	hairline: "#dfe0d8",
} as const;
const BRAND = MEADOW.primary;

/**
 * The link color a sender outside this module quotes verbatim into its own body HTML —
 * the deadline reminders build bare operational mail rather than rendering through
 * {@link shell}, and an `<a>` whose color disagrees with every other Anthers email reads
 * as a different sender. A string and not the object, so an external module borrows the
 * accent and never the whole palette's shape.
 */
export const EMAIL_LINK_COLOR = BRAND;

/**
 * The shell every ceremony email renders through — one template, so one change
 * re-skins every email at once. Inline styles only and a table carcass, because
 * that is what mail clients leave standing.
 *
 * ⚠️ **The wordmark is styled text rather than the logo PNG, deliberately.**
 * Anthers' email makes no off-origin request on a user's behalf — the rule
 * `notifications.ts` states for tracking pixels stops a hosted logo image just
 * as surely, and email clients do not load web fonts, so Fraunces itself cannot
 * travel. Georgia is the nearest system serif every client ships, so the name
 * reads as the logo's warm serif rather than as bold UI text — without fetching
 * anything.
 *
 * Exported for the one outside sender that renders through it too: the notification
 * digest (`notifications.ts`), so a notification is recognizably Anthers mail.
 * Operational alerts stay bare `<p>` HTML on purpose — operator mail, not
 * reader-facing brand.
 */
export function shell(heading: string, bodyHtml: string): string {
	// Decor as inline data URIs — no hosted image, so the mail makes no off-origin
	// request, and each encoded tile rides under a few KB (an email consumer's budget
	// real; Gmail clips messages at ~102 KB of HTML source, data URIs included).
	// Colors bake in from the same light-Meadow hexes the card wears. The bees are
	// baked into the floor tile rather than positioned above it: mail clients strip
	// `position:absolute`, and a bee that renders *behind* nobody at a fixed offset
	// is the site's floor bee at heart.
	const vine = emailVineTileDataUri({ stem: MEADOW.primary, flower: "#e9c85e" });
	const floor = emailGrassFloorDataUri({
		grass: MEADOW.primary,
		flower: "#e9c85e",
		core: "#ce8c19",
		bee: "#ce8c19",
	});
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<!--
		Light-authored, and not available in dark. The palette below is the light theme's
		hexes baked at authoring time; a client that re-themes the message for a dark
		(reader's) setting produces the one combination this mail can neither predict nor
		test against — darkened cream reads as murky olive, and the dark-green ink is
		auto-lightened into washed-out contrast. Every component color is declared
		inline, so nothing here actually benefits from a client's dark translation:
		declaring "only light" is what keeps the mail readable on the mobile clients
		that honor it (Apple Mail, Outlook, Thunderbird), and no worse than before on
		the few that re-theme regardless.
		-->
		<meta name="color-scheme" content="only light">
		<meta name="supported-color-schemes" content="only light">
		<style>
			:root {
				color-scheme: only light;
				supported-color-schemes: only light;
			}
			/* The mail is light-authored; a client dark theme has nothing to do here.
			Declared so the client's translation pass finds an explicit answer rather
			than improvising one over the inline styles. */
			@media (prefers-color-scheme: dark) {
				:root { color-scheme: only light; supported-color-schemes: only light; }
			}
		</style>
	</head>
	<body style="margin:0;padding:0;background:${MEADOW.ground};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
		<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MEADOW.ground};padding:32px 0;">
			<tr><td align="center">
				<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
					<tr><td>
						<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${MEADOW.card};border:1px solid ${MEADOW.hairline};border-radius:14px;overflow:hidden;">
							<tr>
								<td width="52" rowspan="2" style="width:52px;background-image:url(&quot;${vine}&quot;);background-repeat:repeat-y;background-size:52px auto;background-position:center 12px;">&nbsp;</td>
								<td style="padding:28px 28px 8px;">
									<div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;font-weight:700;letter-spacing:1px;color:${MEADOW.wordmark};">Anthers</div>
								</td>
								<td width="52" rowspan="2" style="width:52px;background-image:url(&quot;${vine}&quot;);background-repeat:repeat-y;background-size:52px auto;background-position:center 12px;">&nbsp;</td>
							</tr>
							<tr><td style="padding:8px 28px 26px;color:${MEADOW.ink};font-size:15px;line-height:1.6;">
								<h1 style="margin:0 0 12px;font-size:20px;color:${MEADOW.primary};">${heading}</h1>
								${bodyHtml}
							</td></tr>
							<tr><td colspan="3" style="height:56px;background-image:url(&quot;${floor}&quot;);background-repeat:repeat-x;background-size:auto 56px;background-position:center bottom;font-size:0;line-height:0;">&nbsp;</td></tr>
						</table>
					</td></tr>
				</table>
				<div style="color:${MEADOW.footnote};font-size:12px;margin-top:16px;">Anthers — a fairer home for creators</div>
			</td></tr>
		</table>
	</body>
</html>`;
}

/**
 * Escaped text for email HTML. Exported because alert and reminder senders outside this
 * module build their own bodies — anything untrusted flowing into one escapes through here,
 * so the escaping lives beside the sending rather than being re-derived per caller.
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
 * The signup ceremony's code, to an address with no account yet.
 *
 * The code is spelled out in a monospace block rather than wrapped in a button, because
 * the user's next move is to *type it into six boxes on the page they came from* — a
 * link would take them somewhere else and lose the picks they had already made. That is
 * the whole reason this flow uses a code instead of a link email.
 */
export async function sendSignupCodeEmail(to: string, code: string): Promise<void> {
	const html = shell(
		"Your Anthers code",
		`<p style="margin:0 0 18px;">Enter this code on the page you left open to confirm your address:</p>
		<p style="margin:0 0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${MEADOW.ink};">${escapeHtml(code)}</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">This code expires in 10 minutes. If you didn't ask to join Anthers, you can ignore this email — no account has been created.</p>`,
	);
	const { sent } = await sendEmail({ to, subject: `${code} is your Anthers code`, html });
	if (!sent) console.info(`[email] signup code for ${to}: ${code}`);
}

/**
 * The same ceremony, to an address that **already has an account** — so it signs in.
 *
 * A separate template rather than a flag on the one above, because the sentence a
 * returning user needs is different: they did not ask to create anything, and telling
 * them "welcome, confirm your address" would be both wrong and alarming. The same mail
 * is what somebody who started a signup against this address learns from, so the ignore
 * line covers both — a signup in progress against their address is canceled when they
 * sign in, which is the only thing that signing in here causes.
 *
 * 🚨 What is *not* different is the API's response, which is identical in both cases.
 * The two templates exist so the mail is honest to the one person who can read it; the
 * caller learns nothing, or the "always 200" rule would be decorative.
 */
export async function sendSignInCodeEmail(to: string, code: string): Promise<void> {
	const html = shell(
		"Your Anthers sign-in code",
		`<p style="margin:0 0 18px;">You already have an Anthers account with this address. Enter this code to sign in:</p>
		<p style="margin:0 0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${MEADOW.ink};">${escapeHtml(code)}</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">This code expires in 10 minutes. If you didn't try to sign in, somebody may have started signing up with your address — signing in cancels that signup, and nothing else changes. If it wasn't you, you can ignore this email.</p>`,
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
		<p style="margin:0 0 22px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:6px;color:${MEADOW.ink};">${escapeHtml(code)}</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">This code expires in 10 minutes. If you didn't try to sign in to the admin app, somebody else tried to with your address, and nothing has changed.</p>`,
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
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You'll be sent a code each time you sign in. If you weren't expecting this, tell ${escapeHtml(invitedBy)} or reply to this email.</p>`,
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
	return `<p style="margin:0 0 4px;color:${MEADOW.muted};font-size:13px;">${label}</p>
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
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">Questions about this notice can go to ${escapeHtml(copyrightContact())}.</p>`,
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
		<hr style="border:none;border-top:1px solid ${MEADOW.hairline};margin:22px 0;">
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
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because a data-rights request was made to Anthers from this address. The account that made it has since been deleted, so this email is the only copy of the answer. If anything in it is wrong or incomplete, write to privacy@anthers.org.</p>`,
	);
	return sendEmail({ to, subject: "Your data request has been answered", html });
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
 * user to skim it. An infrastructure alert is a different job for a different person on a
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

// ─── What the operator is told about a deadline ──────────────────────────────

/**
 * One deadline reminder, addressed to whoever operates Anthers.
 *
 * ⚠️ **The recipient is configuration and there is no default**, for the same reason
 * `sendOperationalAlert` refuses to guess at a mailbox: the operator's address is a fact about
 * the deployment, and a reminder delivered to a bouncing address is indistinguishable from no
 * reminder at all. Unset, this logs loudly and reports that it did not send — the sweep records
 * nothing on top of that, so the missed reminder stays visible in the log rather than being
 * papered over by a row that says it went.
 *
 * ⭐ **One email per reminder, never a digest** — the decision is that a deadline reaches the
 * operator by email, and a digest of five deadlines is one email the operator skims, not five
 * things each of which is actionable alone.
 */
export async function sendDeadlineReminderEmail(args: {
	to: string;
	subject: string;
	html: string;
}): Promise<SendResult> {
	return sendEmail({ to: args.to, subject: args.subject, html: args.html });
}

/**
 * The line every terminal-item reminder carries: the Calendar's own rule that one channel is not
 * redundancy, said plainly so this email never claims to be the second leg.
 *
 * The Calendar names the SOS and Copyright Office's own notification emails as the genuinely
 * independent leg — two channels that live on the same laptop are one channel with two copies —
 * so the reminder's job is to be one leg and to point at the other.
 */
export function terminalSecondLegLine(): string {
	return (
		"An item whose miss ends the organization gets two reminders from Anthers, and this is one of them. " +
		"The other, genuinely independent leg is the Colorado Secretary of State's and the Copyright Office's own " +
		"notification emails — make sure those reach a mailbox somebody reads."
	);
}

// ─── What a receipt says ─────────────────────────────────────────────────────

/**
 * One line of a receipt's item table: what was bought, and what it cost.
 *
 * Kept structural rather than shaped on `purchases`' row type, so this module does not
 * depend on the schema package for three fields — the same reasoning
 * `ComplainantNotice` above states.
 */
export interface ReceiptLine {
	/** What the reader bought, as the receipt snapshot recorded it at sale time. */
	description: string;
	/** The line's money figure, as a dollar string ("9.99"); a refund's lines are negative. */
	amount: string;
}

/**
 * Money as a receipt shows it: `$5.25`, or `-$10.48` where a figure is money coming
 * back. The caller hands a dollar *string* (the DB's numeric columns read back as
 * strings) and this only prefixes the sign — no arithmetic happens in a template,
 * because formatting money anywhere except decimal.js is exactly the bug class the
 * repo's conventions rule out.
 */
function usd(dollars: string): string {
	return `${dollars.startsWith("-") ? "-" : ""}$${dollars.replace("-", "")}`;
}

/** One table row of the itemized body. */
function receiptLineHtml(line: ReceiptLine): string {
	return `<tr>
			<td style="padding:6px 12px 6px 0;border-bottom:1px solid ${MEADOW.hairline};color:${MEADOW.ink};font-size:14px;">${escapeHtml(line.description)}</td>
			<td style="padding:6px 0 6px 12px;border-bottom:1px solid ${MEADOW.hairline};color:${MEADOW.ink};font-size:14px;text-align:right;white-space:nowrap;">${usd(line.amount)}</td>
		</tr>`;
}

/**
 * The itemized table at a receipt's center: one row per Work bought, an optional tax
 * line, and the bold closing figure. The tax line is the buyer's copies only — it was
 * never the creator's money, so the creator's tables name their own closing figure
 * ("Your earnings, after the card fee") and carry no tax row.
 */
function itemsTable(opts: {
	lines: ReceiptLine[];
	tax?: string;
	totalLabel: string;
	total: string;
}): string {
	const rows = opts.lines.map(receiptLineHtml).join("\n");
	const taxRow = opts.tax
		? `<tr>
			<td style="padding:6px 12px 6px 0;color:${MEADOW.muted};font-size:13px;">Sales tax</td>
			<td style="padding:6px 0 6px 12px;color:${MEADOW.muted};font-size:13px;text-align:right;white-space:nowrap;">${usd(opts.tax)}</td>
		</tr>`
		: "";
	return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;border-collapse:collapse;">
		${rows}
		${taxRow}
		<tr>
			<td style="padding:10px 12px 0 0;color:${MEADOW.ink};font-size:15px;font-weight:700;">${escapeHtml(opts.totalLabel)}</td>
			<td style="padding:10px 0 0 12px;color:${MEADOW.ink};font-size:15px;font-weight:700;text-align:right;white-space:nowrap;">${usd(opts.total)}</td>
		</tr>
	</table>`;
}

/**
 * The transaction's date and reference, as every receipt opens with them —
 * the day and the PaymentIntent id, so the buyer can match the email to the card
 * statement and to anything Anthers' support asks about later.
 */
function receiptMeta(date: Date, reference: string): string {
	return `<p style="margin:0 0 12px;color:${MEADOW.muted};font-size:13px;">${longDate(date)} · Ref. ${escapeHtml(reference)}</p>`;
}

/**
 * A buyer's receipt for a completed purchase: what they bought, each item and its
 * price, the sales tax added on top, and the total their card was charged.
 *
 * The link is to their Library page, where the purchase is already waiting; a receipt
 * that can point at the thing you now own is worth more than one pointing at a history
 * page. The copy says "you" throughout — a receipt has exactly one audience, the person
 * whose money it was.
 */
export async function sendPurchaseReceiptEmail(args: {
	to: string;
	reference: string;
	date: Date;
	lines: ReceiptLine[];
	tax: string;
	total: string;
}): Promise<SendResult> {
	const html = shell(
		"Your Anthers receipt",
		`${receiptMeta(args.date, args.reference)}
		<p style="margin:0 0 14px;">Thanks for supporting creators directly. Here's what your payment covered:</p>
		${itemsTable({ lines: args.lines, tax: args.tax, totalLabel: "Total charged", total: args.total })}
		<p style="margin:0 0 18px;"><a href="${frontendUrl()}/library" style="color:${BRAND};">Your purchases are in your Library</a>, ready to read, watch, play or listen. They stay there.</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because a purchase was made from your account. Anthers keeps none of your payment: after the processor's at-cost fee, it goes to the creator.</p>`,
	);
	return sendEmail({ to: args.to, subject: `Your Anthers receipt: ${usd(args.total)}`, html });
}

/**
 * A creator's copy of the same purchase: what sold, and what reaches them after the
 * processor's at-cost fee. The earnings figure is what the transfer pinned at
 * session creation (`transfer_data[amount]`), so the number in the email is the number
 * Stripe moved, not one derived again.
 *
 * Off by the creator's receipt preference by the *caller* (`services/receipts.ts`),
 * not here: this module renders and sends, it does not decide who is told.
 */
export async function sendCreatorSaleReceiptEmail(args: {
	to: string;
	reference: string;
	date: Date;
	lines: ReceiptLine[];
	earnings: string;
}): Promise<SendResult> {
	const html = shell(
		"A sale on your work",
		`${receiptMeta(args.date, args.reference)}
		<p style="margin:0 0 14px;">A reader bought something of yours. Here's what sold:</p>
		${itemsTable({ lines: args.lines, totalLabel: "Your earnings, after the card fee", total: args.earnings })}
		<p style="margin:0 0 18px;">After the card processor's at-cost fee, <strong style="color:${MEADOW.ink};">${usd(args.earnings)}</strong> is on its way to your connected account.</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because receipt emails are on for your creator account; you can turn them off in your Studio settings. Anthers keeps none of the sale's price.</p>`,
	);
	return sendEmail({
		to: args.to,
		subject: `A sale on your work: ${usd(args.earnings)} to you`,
		html,
	});
}

/**
 * A buyer's receipt for a refund: the item(s) returned, and the amount going back to
 * their card. The amounts are passed already signed negative by the caller, because the
 * row's own figure is what the refund returned — the template stays arithmetic-free.
 *
 * The copy does not apologize or explain: the refund's reason is on the row and the
 * platform-initiated cases (a takedown, a defect) are already messaged where they
 * happen. The receipt's job is to say the money moved back.
 */
export async function sendRefundReceiptEmail(args: {
	to: string;
	reference: string;
	date: Date;
	lines: ReceiptLine[];
	tax: string;
	total: string;
}): Promise<SendResult> {
	const html = shell(
		"Your Anthers refund receipt",
		`${receiptMeta(args.date, args.reference)}
		<p style="margin:0 0 14px;">A refund was issued on your purchase:</p>
		${itemsTable({ lines: args.lines, tax: args.tax, totalLabel: "Total refunded", total: args.total })}
		<p style="margin:0 0 18px;">The refund goes back to the card you paid with; banks usually post it within 5–10 business days. Your access to the refunded work ends when it does.</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because a refund was made on a purchase from your account. Questions about a refund can go to contact@anthers.org.</p>`,
	);
	return sendEmail({ to: args.to, subject: `Your Anthers refund: ${usd(args.total)}`, html });
}

/**
 * A creator's copy of the refund: what came back, and what was clawed back from the
 * transfer — their earnings exactly, and never below zero (services/refunds.ts'
 * invariant). Whether the clawback recovered at Stripe or waits in the netting ledger
 * is accounting the creator's copy does not carry; the figure they hold is what left.
 */
export async function sendCreatorRefundReceiptEmail(args: {
	to: string;
	reference: string;
	date: Date;
	lines: ReceiptLine[];
	earnings: string;
}): Promise<SendResult> {
	const html = shell(
		"A refund on a sale of yours",
		`${receiptMeta(args.date, args.reference)}
		<p style="margin:0 0 14px;">A purchase from your work was refunded:</p>
		${itemsTable({ lines: args.lines, totalLabel: "Your earnings, returned", total: args.earnings })}
		<p style="margin:0 0 18px;"><strong style="color:${MEADOW.ink};">${usd(args.earnings)}</strong> comes back from the transfer, so it never stays with a sale that was undone.</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because receipt emails are on for your creator account; you can turn them off in your Studio settings.</p>`,
	);
	return sendEmail({
		to: args.to,
		subject: `A refund on your sale: ${usd(args.earnings)} returned`,
		html,
	});
}

/**
 * A creator's payout receipt: the fourteen-day hold ended and their settled earnings
 * moved into their connected account's balance.
 *
 * The distinction the copy lives on (`31.02 Payouts` carries it for the reader, and the
 * transfer job is where it happens): the *transfer* into their processor balance is ours
 * and automatic, and the *payout* from balance to bank is the creator's own choice with
 * its own fee. This email marks the first, so it says the money is in their balance and
 * waiting, not "sent to your bank" — that step is theirs, and these accounts pay out
 * manually. The line they'll match it against is the transfer record shown on their
 * Studio Payments page.
 *
 * Deliberately a receipt and not a notification (Parker, 2026-10-08): money stays out of
 * the in-app feed, the bell is for people, not payments. The transfer row is the money
 * record; this is the telling. A zero-sum close moves nothing, so it earns no email —
 * the caller in `jobs/transfer-held-credits.ts` guards that, not this template.
 */
export async function sendPayoutReceiptEmail(args: {
	to: string;
	reference: string;
	date: Date;
	amount: string;
}): Promise<SendResult> {
	const html = shell(
		"Your Anthers payout receipt",
		`${receiptMeta(args.date, args.reference)}
		<p style="margin:0 0 14px;">The 14-day hold on your settled earnings ended, and the money moved:</p>
		${itemsTable({
			lines: [{ description: "Settled earnings, after the card fee", amount: args.amount }],
			totalLabel: "To your connected account",
			total: args.amount,
		})}
		<p style="margin:0 0 18px;"><strong style="color:${MEADOW.ink};">${usd(args.amount)}</strong> is in your account's balance now. Moving it to your bank is your choice, whenever you like — that payout, and its fee, stays yours.</p>
		<p style="margin:0 0 18px;"><a href="${frontendUrl()}/studio/payments" style="color:${BRAND};">Your balance and transfer record</a> are on your Studio's Payments page.</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because receipt emails are on for your creator account; you can turn them off in your Studio settings. Anthers keeps none of this money.</p>`,
	);
	return sendEmail({
		to: args.to,
		subject: `Your Anthers payout: ${usd(args.amount)} to your balance`,
		html,
	});
}

/**
 * A supporter's receipt for a monthly Badge support payment: the month the charge was
 * for, the amount given to Anthers, and the split that reached creators. Anthers' own
 * line is excluded from the itemization — the receipt is about what the supporter gave
 * creators, and the whole amount is the only figure they chose.
 */
export async function sendSupportReceiptEmail(args: {
	to: string;
	reference: string;
	date: Date;
	/** The month this payment is for, as cycleKeyFor spells it ("2026-10"). */
	billingCycle: string;
	/** Lines naming each creator this payment reached, excluding Anthers' own line. */
	lines: ReceiptLine[];
	tax: string;
	total: string;
}): Promise<SendResult> {
	const html = shell(
		"Your monthly support receipt",
		`${receiptMeta(args.date, args.reference)}
		<p style="margin:0 0 14px;">Thanks for supporting creators. Here's your payment for <strong style="color:${MEADOW.ink};">${escapeHtml(args.billingCycle)}</strong>:</p>
		${itemsTable({ lines: args.lines, tax: args.tax, totalLabel: "Total charged", total: args.total })}
		<p style="margin:0 0 18px;"><a href="${frontendUrl()}/supporters" style="color:${BRAND};">See who your support reached</a> on the supporters page.</p>
		<p style="margin:22px 0 0;color:${MEADOW.muted};font-size:12px;">You're receiving this because a monthly support payment was made from your account.</p>`,
	);
	return sendEmail({
		to: args.to,
		subject: `Your Anthers support receipt: ${usd(args.total)}`,
		html,
	});
}
