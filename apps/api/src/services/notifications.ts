// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Notifications — the app's first way to tell somebody something.
 *
 * Until this, Anthers could send exactly two emails (verify your address, reset your
 * password) and had no way to say anything else to anyone. **Three separate committed
 * obligations were waiting on it**, which is what made it worth building on its own
 * rather than as the awkward half of whichever one landed first:
 *
 * 1. Privacy Policy's promise to announce material policy changes *"before it takes effect —
 *    not by quietly updating a date at the bottom"*;
 * 2. the withdrawn-Work rescue window, whose notice has to reach someone who **may
 *    never sign in again**;
 * 3. a creator deleting their account, which withdraws Works their buyers own and
 *    until now told those buyers nothing at all.
 *
 * Four decisions, defaults chosen with Parker's go-ahead to proceed on standard
 * ground and flag anything without an obvious answer:
 *
 * **1. Email is the floor, in-app is the addition.** Obligation (2) settles it: a
 * notice nobody signs in to see is not a notice. So everything lands in the table AND
 * goes out by email unless the category says otherwise — never in-app only.
 *
 * **2. Two categories, and only one of them is optional.** `essential` covers
 * deadlines, money and legal changes; `activity` covers the social noise a healthy
 * app generates. Users can turn `activity` email off and cannot turn `essential` off,
 * because a switch that quietly doesn't apply to half the messages is worse than no
 * switch. **Nothing suppresses the in-app record** — opting out of email is not
 * opting out of being told.
 *
 * **3. The record is the deliverable.** `notifications` rows are evidence that we
 * told someone, and `emailSentAt` is deliberately distinct from `createdAt` so
 * "recorded but not emailed" stays a visible state rather than being assumed away.
 *
 * **4. Idempotency is the caller's natural key.** Every consumer here is a scheduled
 * job re-evaluating the same rows nightly. Without `dedupeKey` the rescue-window
 * notice would mail somebody every morning until the deadline it was warning them
 * about — which is the failure mode that turns a considerate feature into the reason
 * people filter your domain.
 *
 * One inherited constraint, from the blocking work: **a notification is a place two
 * users meet.** Anything built on top of this that carries another user's activity has
 * to run through the same block check as a comment thread does.
 */

import { db } from "@anthers/db/client";
import { notifications, users } from "@anthers/db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { sendEmail } from "./email.js";

/**
 * `essential` cannot be switched off. See decision 2 — if this ever grows a third
 * value, the question to answer first is which side of that line it falls on.
 */
export type NotificationCategory = "essential" | "activity";

export interface NotifyInput {
	userId: number;
	category: NotificationCategory;
	/** Stable machine value for what happened. Copy is the caller's business. */
	kind: string;
	title: string;
	body?: string;
	/** App-relative path to act on it, or "" when there is nowhere to go. */
	linkPath?: string;
	/**
	 * Natural key, unique across all notifications. `work-withdrawn:<purchaseId>`,
	 * not a hash of the copy — copy gets edited and a hash would re-send when it does.
	 */
	dedupeKey: string;
}

export interface NotifyResult {
	/** False when this dedupeKey had already been used — nothing was sent. */
	created: boolean;
	notificationId: number | null;
	/**
	 * Whether this module DECIDED to email — the category/preference rule, which is the
	 * part it owns and the part worth asserting.
	 *
	 * Reported separately from `emailed` because delivery is Resend's and no-ops
	 * entirely without `RESEND_API_KEY`. Collapsing the two makes the essential-category
	 * guarantee untestable anywhere it matters: with mail disabled, "we chose not to
	 * send" and "we chose to send and nothing happened" look identical, so a bug that
	 * let a preference suppress an essential notice would pass every test.
	 */
	emailIntended: boolean;
	/** Whether the provider actually accepted it. */
	emailed: boolean;
}

/**
 * Tell one person one thing, once.
 *
 * The insert comes first and its conflict clause is the whole idempotency guarantee:
 * if the row already existed we return without sending, so a nightly job cannot mail
 * anybody twice about the same fact. Sending first and recording after would invert
 * that — a crash between the two would re-send on every subsequent run, forever.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult> {
	const [row] = await db
		.insert(notifications)
		.values({
			userId: input.userId,
			category: input.category,
			kind: input.kind,
			title: input.title,
			body: input.body ?? "",
			linkPath: input.linkPath ?? "",
			dedupeKey: input.dedupeKey,
		})
		.onConflictDoNothing({ target: notifications.dedupeKey })
		.returning({ id: notifications.id });

	// Already told them. Not an error — it is the job doing its job.
	if (!row) return { created: false, notificationId: null, emailIntended: false, emailed: false };

	const [user] = await db
		.select({ email: users.email, notifyActivityEmail: users.notifyActivityEmail })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);

	// The in-app record stands regardless of what happens next: opting out of email
	// is not opting out of being told, and a send failure must not erase the evidence
	// that we tried.
	if (!user) return { created: true, notificationId: row.id, emailIntended: false, emailed: false };

	const wantsEmail = input.category === "essential" || user.notifyActivityEmail !== false;
	if (!wantsEmail)
		return { created: true, notificationId: row.id, emailIntended: false, emailed: false };

	const { sent } = await sendEmail({
		to: user.email,
		subject: input.title,
		html: renderEmail(input),
	});

	if (sent) {
		await db
			.update(notifications)
			.set({ emailSentAt: new Date() })
			.where(eq(notifications.id, row.id));
	}

	return { created: true, notificationId: row.id, emailIntended: true, emailed: sent };
}

/**
 * Notify several people about the same fact.
 *
 * `dedupeKey` has to differ per recipient or the second person silently gets nothing —
 * the key is unique globally, which is what lets a job resolve the same fact twice and
 * land on the same rows. Callers suffix the user id; doing it here instead would hide
 * a footgun rather than remove it, since the caller still has to make the base unique.
 */
export async function notifyMany(inputs: NotifyInput[]): Promise<{ created: number }> {
	let created = 0;
	for (const input of inputs) {
		const result = await notify(input);
		if (result.created) created += 1;
	}
	return { created };
}

/** A user's own notifications, newest first. */
export async function listNotifications(userId: number, limit = 50) {
	return db
		.select()
		.from(notifications)
		.where(eq(notifications.userId, userId))
		.orderBy(desc(notifications.createdAt))
		.limit(limit);
}

export async function unreadCount(userId: number): Promise<number> {
	const rows = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
	return rows.length;
}

/** Mark some (or all) of a user's notifications read. Scoped to the owner. */
export async function markRead(userId: number, ids?: number[]): Promise<{ marked: number }> {
	const scope = and(
		eq(notifications.userId, userId),
		isNull(notifications.readAt),
		ids && ids.length > 0 ? inArray(notifications.id, ids) : undefined,
	);
	const rows = await db
		.update(notifications)
		.set({ readAt: new Date() })
		.where(scope)
		.returning({ id: notifications.id });
	return { marked: rows.length };
}

/**
 * The email body.
 *
 * Deliberately plain, and deliberately **self-hosted-nothing**: no images, no tracking
 * pixel, no open-rate beacon. The same rule the app is held to under the Privacy Policy — Anthers
 * makes no off-origin request on a user's behalf — does not stop applying because the
 * surface is an inbox, and an open-tracking pixel is precisely the "third party learns
 * you read this" pattern the policy says we don't do.
 */
function renderEmail(input: NotifyInput): string {
	const link = input.linkPath
		? `<p><a href="${appUrl(input.linkPath)}">${appUrl(input.linkPath)}</a></p>`
		: "";
	return `<div style="font-family:system-ui,sans-serif;line-height:1.5">
	<h2 style="font-size:18px;margin:0 0 12px">${escapeHtml(input.title)}</h2>
	${input.body ? `<p>${escapeHtml(input.body)}</p>` : ""}
	${link}
	<hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
	<p style="font-size:12px;color:#666">
		${
			input.category === "essential"
				? "You're receiving this because it affects your account, your money, or your access to something you paid for. These can't be turned off."
				: "You can turn these off in your Anthers settings."
		}
	</p>
</div>`;
}

function appUrl(path: string): string {
	const base = process.env.APP_URL ?? "https://anthers.org";
	return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
