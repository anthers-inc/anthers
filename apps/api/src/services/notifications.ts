// SPDX-License-Identifier: Apache-2.0
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
 * app generates. **The activity half is now a per-group choice, not a single switch**
 * (Parker, 2026-10-08, when the reply-notification task made the social kinds real):
 * each {@link DELIVERY_GROUPS} mode is `app`, `email`, or `both`, chosen in Settings,
 * all defaulting to `both`. The in-app record is never suppressed — opting out of
 * email is not opting out of being told. `essential` emails regardless of any of it;
 * a switch that quietly didn't apply to half the messages was the reason the single
 * boolean predates this map.
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

import { randomBytes } from "node:crypto";
import { db } from "@anthers/db/client";
import { notifications, userPreferences, users } from "@anthers/db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { EMAIL_LINK_COLOR, escapeHtml, sendEmail, shell } from "./email.js";

/**
 * `essential` cannot be switched off. See decision 2 — if this ever grows a third
 * value, the question to answer first is which side of that line it falls on.
 */
export type NotificationCategory = "essential" | "activity";

/**
 * The delivery modes a group can carry.
 *
 * ⚠️ **`app` means "the app feed only, never email" and `email` means "email only" and
 * BOTH still write the in-app row** — the email-only person reads their feed too, same as
 * anybody; the mode only decides whether the send happens.
 */
export type DeliveryMode = "app" | "email" | "both";

/**
 * The delivery groups — the nouns a person's notification settings are written in.
 *
 * ⭐ **The registry is here and nowhere else.** A caller passes a `kind` (the stable
 * machine value already required of every notification) and this decides which group's
 * mode applies — so adding a kind is writing its one line below, and the Settings page
 * renders the same list. A group table kept anywhere else would drift from this one.
 *
 * Every group defaults to `both` (see decision 2). A group whose mail would be noise the
 * person cannot connect to anything — none today — would be the case for defaulting
 * that one group quieter, and that change happens here or not at all.
 *
 * The two `essential` kinds that share a category with these do NOT appear here: the
 * category already decides essential delivery, and putting one in a group would imply a
 * switch that must not exist (decision 2).
 */
export const DELIVERY_GROUPS = {
	/** Somebody replied to your comment, or commented on your post. */
	conversation: {
		kinds: ["comment_reply", "post_comment"],
	},
	/** Somebody reviewed a Work of yours. */
	reviews: {
		kinds: ["work_review"],
	},
	/** Somebody followed you. */
	followers: {
		kinds: ["new_follower"],
	},
	/** You were credited on a Work (the credit-acceptance flow). */
	credits: {
		kinds: ["credit_offered"],
	},
	/** What an operator did about your report. */
	reportAnswers: {
		kinds: ["report_routed_copyright"],
	},
} as const satisfies Record<string, { kinds: readonly string[] }>;

export type DeliveryGroup = keyof typeof DELIVERY_GROUPS;

/** Every kind mapped above, as a set — the fastest way to ask `is this one social?` */
const KIND_TO_GROUP = new Map<string, DeliveryGroup>();
for (const [group, def] of Object.entries(DELIVERY_GROUPS)) {
	for (const kind of def.kinds) KIND_TO_GROUP.set(kind, group as DeliveryGroup);
}

/**
 * The group a social kind belongs to, or null when the kind is not one the map governs.
 *
 * ⭐ **`essential` kinds pass through as null and always email** — the category decides
 * them (decision 2), and the group map must never be consulted on their behalf, which is
 * what "null means unconditional" encodes at every reader below.
 */
export function deliveryGroupFor(kind: string): DeliveryGroup | null {
	return KIND_TO_GROUP.get(kind) ?? null;
}

/** Is this kind a social one whose delivery the person controls per group? */
export function isSocialKind(kind: string): boolean {
	return deliveryGroupFor(kind) !== null;
}

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
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, input.userId))
		.limit(1);

	// The in-app record stands regardless of what happens next: opting out of email
	// is not opting out of being told, and a send failure must not erase the evidence
	// that we tried.
	if (!user) return { created: true, notificationId: row.id, emailIntended: false, emailed: false };

	// The delivery map rides `user_preferences` (the accounts split moved it off `users`)
	// — a second read rather than a join, because a missing preferences row is a valid
	// state for a user who has set nothing, and every absent key reads as the `both`
	// default. `essential` never reads the map at all: the category's whole meaning is
	// that no switch reaches it.
	const [prefs] = await db
		.select({
			notificationDelivery: userPreferences.notificationDelivery,
			unsubscribeToken: userPreferences.notificationUnsubscribeToken,
		})
		.from(userPreferences)
		.where(eq(userPreferences.userId, input.userId))
		.limit(1);

	const group = deliveryGroupFor(input.kind);
	// 🚨 **An unmapped `activity` kind is NOT subject to the map** — the wildcard answers
	// for the *groups the registry names*, and a kind that names none of them is the
	// category's business (email on), the same answer the old boolean gave. Resolving an
	// unknown kind through a person's `"*": "app"` would silence the next developer's
	// activity kind by default — the direction an unset answer must never fail in.
	const wantsEmail =
		input.category === "essential" ||
		group === null ||
		resolvedMode(prefs?.notificationDelivery ?? null, group) !== "app";

	// A social send the prefs say to email, with no token minted yet: mint one BEFORE
	// rendering so this email carries its own working unsubscribe link rather than the
	// first one arriving linkless. A failed mint disables the link on this mail only —
	// a send that no-ops locally (no RESEND_API_KEY) still records the token, which is
	// harmless and correct: the token is a credential for one preference write, and a
	// next email that can send should carry it.
	let token = prefs?.unsubscribeToken ?? null;
	if (group !== null && !token && wantsEmail) {
		token = await unsubscribeTokenFor(input.userId).catch(() => null);
	}

	if (!wantsEmail)
		return { created: true, notificationId: row.id, emailIntended: false, emailed: false };

	const { sent } = await sendEmail({
		to: user.email,
		subject: input.title,
		html: renderEmail(input, { group, unsubscribeToken: token, userId: input.userId }),
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

/**
 * Resolve ONE group's mode out of the stored map, with the whole default story in one
 * place.
 *
 * ⭐ **Three levels of absence, all resolving to `both`**: no preferences row, no map, no
 * key for the group. The wildcard — `"*"` — is what Settings writes when somebody answers
 * "same for everything" without enumerating groups, and an explicit group key beats it.
 * The only way a mode ends up quieter than `both` is somebody having said so.
 */
export function resolvedMode(
	map: Record<string, string> | null | undefined,
	group: DeliveryGroup,
): DeliveryMode {
	const value = map?.[group] ?? map?.["*"];
	return value === "app" || value === "email" ? value : "both";
}

/**
 * The unsubscribe token, minted on first need.
 *
 * A person who has never been emailed holds no token, so the first activity email mints
 * one and records it — an extra write per first email, not per email: afterwards the send
 * reads what is there. Deliberately **not** pre-generated at signup: a join that runs when
 * only half the accounts will ever need the row is a cost with no return, and the token's
 * only reader is the unsubscribe route.
 */
export async function unsubscribeTokenFor(userId: number): Promise<string | null> {
	const [existing] = await db
		.select({ token: userPreferences.notificationUnsubscribeToken })
		.from(userPreferences)
		.where(eq(userPreferences.userId, userId))
		.limit(1);
	if (existing?.token) return existing.token;
	const token = randomBytes(24).toString("hex");
	await db
		.insert(userPreferences)
		.values({ userId, notificationUnsubscribeToken: token })
		.onConflictDoUpdate({
			target: userPreferences.userId,
			set: { notificationUnsubscribeToken: token, updatedAt: new Date() },
		});
	return token;
}

/**
 * What the one-click unsubscribe writes: the named group goes app-only, without a session.
 *
 * The email person clicked was presumably an email they do not want; the in-app copy keeps
 * arriving (decision 2), which is what "unsubscribe" honestly means here. Writing the
 * group key **not** the wildcard is deliberate: the person has said this about one group,
 * and a wildcard on their behalf would silently unsubscribe four others they may want.
 */
export async function unsubscribeGroup(token: string, group: DeliveryGroup): Promise<boolean> {
	const [row] = await db
		.select({ userId: userPreferences.userId, delivery: userPreferences.notificationDelivery })
		.from(userPreferences)
		.where(eq(userPreferences.notificationUnsubscribeToken, token))
		.limit(1);
	if (!row) return false;
	// A timing-safe comparison is unnecessary — matching a token's row is the read, and a
	// miss answers false — but the lookup IS the guard, so no second check is owed here.
	const next = { ...(row.delivery ?? {}), [group]: "app" };
	await db
		.update(userPreferences)
		.set({ notificationDelivery: next, updatedAt: new Date() })
		.where(eq(userPreferences.userId, row.userId));
	return true;
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
 * Rendered through the same {@link shell} every ceremony email wears, so a
 * notification digest is recognizably Anthers mail and one template change
 * re-skins all of it together. Deliberately **self-hosted-nothing** still holds:
 * no images, no tracking pixel, no open-rate beacon. The same rule the app is held
 * to under the Privacy Policy — Anthers makes no off-origin request on a user's
 * behalf — does not stop applying because the surface is an inbox, and an
 * open-tracking pixel is precisely the "third party learns you read this" pattern
 * the policy says we don't do. The shell asks for nothing either, which is why the
 * brand travels as styled text and color rather than as a logo image.
 *
 * A social email (a kind the group map governs) carries the one-click unsubscribe
 * link; an essential one does not, because essential mail is not a choice being
 * offered. The link authenticates by token, minted here on first send.
 */
function renderEmail(
	input: NotifyInput,
	unsubscribe?: { group: DeliveryGroup | null; unsubscribeToken: string | null; userId: number },
): string {
	const link = input.linkPath
		? `<p style="margin:0 0 18px;"><a href="${appUrl(input.linkPath)}" style="color:${EMAIL_LINK_COLOR};">${appUrl(input.linkPath)}</a></p>`
		: "";
	const unsubscribeLine =
		unsubscribe?.group && unsubscribe.unsubscribeToken
			? `<p style="margin:22px 0 0;"><a href="${appUrl(`/unsubscribe?token=${unsubscribe.unsubscribeToken}&group=${unsubscribe.group}`)}" style="color:${EMAIL_LINK_COLOR};font-size:12px;">Turn emails like this off</a></p>`
			: "";
	return shell(
		escapeHtml(input.title),
		`${input.body ? `<p style="margin:0 0 18px;">${escapeHtml(input.body)}</p>` : ""}
		${link}
		${unsubscribeLine}
		<p style="margin:22px 0 0;color:#4d5f52;font-size:12px;">
			${
				input.category === "essential"
					? "You're receiving this because it affects your account, your money, or your access to something you paid for. These can't be turned off."
					: "You can turn these off in your Anthers settings."
			}
		</p>`,
	);
}

function appUrl(path: string): string {
	const base = process.env.APP_URL ?? "https://anthers.org";
	return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}
