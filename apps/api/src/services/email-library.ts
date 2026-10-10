// SPDX-License-Identifier: Apache-2.0
/**
 * The Email Library — the catalog of every standard and automatic email Anthers sends, rendered
 * with placeholder data for the admin console's Email Library tool.
 *
 * 🚨 **Every entry renders through the product's own template, never a parallel renderer.** The
 * `render` functions are the very ones the senders call — `services/email.ts` exports them as
 * `renderX(...)` split from send, `renderNotificationEmail` is `services/notifications.ts`'s,
 * and `renderDeadlineReminderEmail` is the reminder job's — so a template change re-skins the
 * library the same day it re-skins the mail rather than letting a copy drift. **A new template
 * adds its render function beside its sender AND an entry here**, which is why the pointer
 * lives on `RenderedEmail` in `services/email.ts` too.
 *
 * Three senders are deliberately not cataloged: `sendAbuseAlert`, `sendOperationalAlert` and
 * `sendDeadlineReminderEmail`'s siblings are pipes — their callers hand them a subject and body
 * directly, so there is no fixed template to show. The deadline reminder *is* cataloged, because
 * its template genuinely lives in `jobs/deadline-reminders.ts` and only the recipient is a pipe.
 *
 * Every placeholder value here is invented and marked as example data — nothing renders a real
 * account, purchase or notice, because the library's purpose is cataloging and evaluating the
 * templates, and a fixture that reads production rows would be both a data leak and a second
 * source of truth. Reference strings are spelled `EXAMPLE-…` rather than in a vendor's format,
 * per the credential-shape rule.
 */

import { renderDeadlineReminderEmail } from "../jobs/deadline-reminders.js";
import {
	type ComplainantNotice,
	type ForwardedCounterNotice,
	type ReceiptLine,
	type RenderedEmail,
	renderAdminInvitationEmail,
	renderAdminSignInCodeEmail,
	renderCounterNoticeCopy,
	renderCreatorRefundReceiptEmail,
	renderCreatorSaleReceiptEmail,
	renderDmcaRejection,
	renderDmcaTakedownAcknowledgment,
	renderPayoutReceiptEmail,
	renderPurchaseReceiptEmail,
	renderRefundReceiptEmail,
	renderRightsRequestAnswerEmail,
	renderSignInCodeEmail,
	renderSignupCodeEmail,
	renderSupportReceiptEmail,
} from "./email.js";
import { type NotifyInput, renderNotificationEmail } from "./notifications.js";

/**
 * Where a test send goes. The Email Library sends to this one address and no other — it is a
 * cataloging tool, so there is no recipient field to get wrong, and its sends are
 * operator-initiated, one at a time, never bulk or scheduled.
 */
export const EMAIL_LIBRARY_TEST_RECIPIENT = "admin@anthers.org";

/**
 * The shared example date: fixed rather than `new Date()`, so a receipt's rendered body reads
 * the same every time the library is opened and the one under review is not shifting underfoot.
 */
const EXAMPLE_DATE = new Date("2026-10-10T12:00:00Z");

const EXAMPLE_REFERENCE = "EXAMPLE-REF-3847";

const EXAMPLE_PURCHASE_LINES: ReceiptLine[] = [
	{ description: "Example Work — purchase", amount: "7.25" },
];

const EXAMPLE_CREATOR_LINES: ReceiptLine[] = [
	{ description: "Example Creator — one sale of Example Work", amount: "7.25" },
];

const EXAMPLE_SUPPORT_LINES: ReceiptLine[] = [
	{ description: "Example Creator — support reached", amount: "5.33" },
	{ description: "Another Example Creator — support reached", amount: "5.33" },
];

const EXAMPLE_NOTICE: ComplainantNotice = {
	id: 12,
	complainantName: "Casey Example",
	complainantEmail: "example@example.org",
	workTitle: "Example Work",
	receivedAt: EXAMPLE_DATE,
};

const EXAMPLE_COUNTER_NOTICE: ForwardedCounterNotice = {
	subscriberName: "Rowan Counterexample",
	subscriberAddress: "100 Example Street, Example Town, CO 80000",
	subscriberPhone: "555-0100",
	jurisdictionConsent: "United States District Court for the District of Colorado",
	goodFaithStatement:
		"I state, under penalty of perjury, that I have a good faith belief that the material was removed as a result of mistake or misidentification.",
	attestationTextSnapshot:
		"Under penalty of perjury, I have a good faith belief that the identified material was removed or disabled as a result of mistake or misidentification.",
	filedAt: "2026-10-08",
};

const EXAMPLE_NOTIFICATION_SOCIAL: NotifyInput = {
	userId: 0,
	category: "activity",
	kind: "reply",
	title: "Casey Example replied to your comment",
	body: '"Loved the ending of this one — did you design that yourself?"',
	/** App-relative path the email links to, as a real notification carries. */
	linkPath: "/works/example/EXAMPLE",
	dedupeKey: "example:reply:0",
};

const EXAMPLE_NOTIFICATION_ESSENTIAL: NotifyInput = {
	userId: 0,
	category: "essential",
	kind: "access_changed",
	title: "Your access to Example Work changed",
	body: "A refund issued on your purchase, so the Work is no longer in your Library.",
	linkPath: "/library",
	dedupeKey: "example:access:0",
};

export interface EmailLibraryEntry {
	/** Stable machine id, what the send route addresses a template by. */
	id: string;
	/** The group the console lists it under. */
	group: string;
	/** What the entry is called in the console. */
	label: string;
	/** One sentence on when Anthers sends it and to whom. */
	description: string;
	/** Render through the product's own template, with this entry's placeholder data. */
	render(): RenderedEmail;
}

/** The catalog, in the order the console lists it. */
export const emailLibrary: EmailLibraryEntry[] = [
	// ─── Sign-in & ceremonies ───────────────────────────────────────────────
	{
		id: "signup-code",
		group: "Sign-in & ceremonies",
		label: "Signup code",
		description: "Sent to an address joining Anthers, to confirm it. Code, not a link.",
		render: () => renderSignupCodeEmail("481702"),
	},
	{
		id: "sign-in-code",
		group: "Sign-in & ceremonies",
		label: "Sign-in code",
		description: "Sent to an address that already has an account, when somebody signs in.",
		render: () => renderSignInCodeEmail("481702"),
	},
	{
		id: "admin-sign-in-code",
		group: "Sign-in & ceremonies",
		label: "Admin sign-in code",
		description: "Sent to an admin account's address, to sign in to this console.",
		render: () => renderAdminSignInCodeEmail("481702"),
	},
	{
		id: "admin-invitation",
		group: "Sign-in & ceremonies",
		label: "Admin invitation",
		description: "Sent when somebody is given an admin account, naming who added them.",
		render: () => renderAdminInvitationEmail("Casey Example", "https://admin.anthers.org"),
	},

	// ─── Copyright & legal ──────────────────────────────────────────────────
	{
		id: "dmca-acknowledgment",
		group: "Copyright & legal",
		label: "DMCA acknowledgment",
		description: "Tells a complainant the material their notice identified has been removed.",
		render: () => renderDmcaTakedownAcknowledgment(EXAMPLE_NOTICE),
	},
	{
		id: "dmca-rejection",
		group: "Copyright & legal",
		label: "DMCA rejection",
		description: "Tells a complainant we could not act on their notice, and why.",
		render: () =>
			renderDmcaRejection(
				EXAMPLE_NOTICE,
				"The notice did not identify the material's URL, which 17 U.S.C. § 512(c)(3)(A)(iii) requires.",
			),
	},
	{
		id: "dmca-counter-notice",
		group: "Copyright & legal",
		label: "DMCA counter-notice copy",
		description: "Forwards a filed counter-notice to the complainant, with the restoration window.",
		render: () =>
			renderCounterNoticeCopy(EXAMPLE_NOTICE, EXAMPLE_COUNTER_NOTICE, {
				from: EXAMPLE_DATE,
				by: new Date(EXAMPLE_DATE.getTime() + 10 * 86_400_000),
			}),
	},
	{
		id: "rights-request-answer",
		group: "Copyright & legal",
		label: "Rights request answer",
		description: "Answers a data-rights request whose account no longer exists.",
		render: () =>
			renderRightsRequestAnswerEmail(
				"We reviewed our records and can confirm we hold no further data about the account. What was held while it existed is described in the Privacy Policy.",
			),
	},

	// ─── Receipts ───────────────────────────────────────────────────────────
	{
		id: "purchase-receipt",
		group: "Receipts",
		label: "Purchase receipt",
		description: "A buyer's receipt for a completed purchase, with sales tax on top.",
		render: () =>
			renderPurchaseReceiptEmail({
				reference: EXAMPLE_REFERENCE,
				date: EXAMPLE_DATE,
				lines: EXAMPLE_PURCHASE_LINES,
				tax: "0.58",
				total: "7.83",
			}),
	},
	{
		id: "creator-sale-receipt",
		group: "Receipts",
		label: "Creator sale receipt",
		description: "A creator's copy of the same purchase: what sold, after the card fee.",
		render: () =>
			renderCreatorSaleReceiptEmail({
				reference: EXAMPLE_REFERENCE,
				date: EXAMPLE_DATE,
				lines: EXAMPLE_CREATOR_LINES,
				earnings: "6.88",
			}),
	},
	{
		id: "refund-receipt",
		group: "Receipts",
		label: "Refund receipt",
		description: "A buyer's receipt for a refund, the figures already signed negative.",
		render: () =>
			renderRefundReceiptEmail({
				reference: EXAMPLE_REFERENCE,
				date: EXAMPLE_DATE,
				lines: EXAMPLE_PURCHASE_LINES.map((l) => ({ ...l, amount: `-${l.amount}` })),
				tax: "-0.58",
				total: "-7.83",
			}),
	},
	{
		id: "creator-refund-receipt",
		group: "Receipts",
		label: "Creator refund receipt",
		description: "A creator's copy of a refund: the earnings clawed back from the transfer.",
		render: () =>
			renderCreatorRefundReceiptEmail({
				reference: EXAMPLE_REFERENCE,
				date: EXAMPLE_DATE,
				lines: EXAMPLE_CREATOR_LINES.map((l) => ({ ...l, amount: `-${l.amount}` })),
				earnings: "-6.88",
			}),
	},
	{
		id: "payout-receipt",
		group: "Receipts",
		label: "Payout receipt",
		description: "A creator's receipt when the 14-day hold ended and earnings moved to balance.",
		render: () =>
			renderPayoutReceiptEmail({
				reference: EXAMPLE_REFERENCE,
				date: EXAMPLE_DATE,
				amount: "6.88",
			}),
	},
	{
		id: "support-receipt",
		group: "Receipts",
		label: "Support receipt",
		description:
			"A supporter's monthly receipt, naming each creator the payment reached — Anthers' own line excluded.",
		render: () =>
			renderSupportReceiptEmail({
				reference: EXAMPLE_REFERENCE,
				date: EXAMPLE_DATE,
				billingCycle: "2026-10",
				lines: EXAMPLE_SUPPORT_LINES,
				tax: "1.48",
				total: "18.50",
			}),
	},

	// ─── Notifications ──────────────────────────────────────────────────────
	{
		id: "notification-social",
		group: "Notifications",
		label: "Notification — social",
		description:
			"A notification email for something social, with the one-click unsubscribe social mail carries.",
		render: () =>
			renderNotificationEmail(EXAMPLE_NOTIFICATION_SOCIAL, {
				group: "conversation",
				unsubscribeToken: "EXAMPLE-TOKEN",
				userId: 0,
			}),
	},
	{
		id: "notification-essential",
		group: "Notifications",
		label: "Notification — essential",
		description: "Essential-category notice — no unsubscribe, because it affects money or access.",
		render: () => renderNotificationEmail(EXAMPLE_NOTIFICATION_ESSENTIAL),
	},

	// ─── Operations ─────────────────────────────────────────────────────────
	{
		id: "deadline-reminder",
		group: "Operations",
		label: "Deadline reminder",
		description:
			"Emailed to the operator about a deadline — here a terminal calendar item inside its 14-day lead window.",
		render: () => {
			const dueAt = new Date(EXAMPLE_DATE.getTime() + 14 * 86_400_000);
			return renderDeadlineReminderEmail(
				{
					source: "compliance-calendar",
					key: "calendar:example",
					title: "EXAMPLE — Colorado periodic report",
					dueAt,
					windowStart: null,
					terminal: true,
					consequence: "The report is late; penalties accrue and standing is at risk.",
					actUrl: null,
					note: null,
				},
				"before-due-14",
				EXAMPLE_DATE,
			);
		},
	},
];

/** One entry by id, or null — the send route answers 404 when there is none. */
export function emailLibraryEntry(id: string): EmailLibraryEntry | null {
	return emailLibrary.find((entry) => entry.id === id) ?? null;
}
