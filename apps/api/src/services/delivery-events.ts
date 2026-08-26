// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the email provider tells us became of an escalation alert.
 *
 * 🚨 **The gap this closes, and why it is not a nicety.** `escalated_at` means only that
 * Resend *accepted* the message — a fact about our side of a network call. An alert
 * accepted and then bounced is, to the person who needed telling, identical to one never
 * sent, and nothing in the app could tell those two apart. The floor exists so that a
 * report of child sexual abuse material reaches a human; "we handed it to a provider" is
 * not an answer to whether it did.
 *
 * ⭐ **Pushed rather than polled, and that is a security decision as much as an
 * architectural one.** Asking Resend directly needs an API key that can READ mail. The
 * production key is send-only, and broadening it would give the credential most exposed
 * in production — used on every signup email — the power to read every message we have
 * ever sent, in order to answer a question the provider is willing to simply tell us.
 * Confirmed the hard way on 2026-08-26: the live key answers a status lookup with
 * `401 — "This API key is restricted to only send emails"`.
 *
 * ⚠️ **Delivered is not read.** Every function here reports that a receiving server
 * accepted a message. Mail filed into a spam folder is delivered and is still a failure
 * of the thing the alert is for, which is why nothing downstream claims success on this
 * alone.
 */

import { db } from "@anthers/db/client";
import { abuseReports, moderationReports } from "@anthers/db/schema";
import { eq, isNull, or, sql } from "drizzle-orm";

/**
 * Events worth recording, mapped from Resend's `email.*` type names.
 *
 * Deliberately a set rather than an allowlist that drops the rest: an event we do not
 * recognize is still evidence of *something*, and storing its name costs nothing while
 * discarding it means a future question has no data behind it. What the set decides is
 * only which events are worth *overwriting* a terminal one with — see `recordDeliveryEvent`.
 */
const TERMINAL_EVENTS = new Set(["delivered", "bounced", "complained", "failed", "canceled"]);

/** Strip Resend's `email.` prefix. `email.delivered` is stored as `delivered`. */
export function normalizeEventName(type: string): string {
	return type.startsWith("email.") ? type.slice("email.".length) : type;
}

export interface DeliveryEvent {
	messageId: string;
	/** Already normalized — `delivered`, not `email.delivered`. */
	event: string;
	occurredAt: Date;
}

/**
 * Record what happened to a message, against whichever report it belongs to.
 *
 * Returns how many rows were touched — zero is an ordinary outcome, not an error: Resend
 * sends events for **every** email we send, and most of them are signup verifications
 * that no report row names. A webhook that treated an unmatched event as a failure would
 * spend its life reporting failures.
 *
 * 🚨 **Ordering is not guaranteed and later events are not always better.** Webhook
 * deliveries can arrive out of order, so a `sent` arriving after a `delivered` must not
 * overwrite it — otherwise a race downgrades a known-good outcome to an unknown one. A
 * terminal event therefore wins and is never replaced by a non-terminal one.
 */
export async function recordDeliveryEvent(input: DeliveryEvent): Promise<{ matched: number }> {
	if (!input.messageId) return { matched: 0 };
	const incomingIsTerminal = TERMINAL_EVENTS.has(input.event);

	// Only overwrite when the incoming event is at least as conclusive as what is stored:
	// anything may replace an empty slot or a non-terminal one, and only a terminal event
	// may replace a terminal one.
	const mayOverwrite = incomingIsTerminal
		? undefined
		: or(
				isNull(moderationReports.escalationDeliveryEvent),
				sql`${moderationReports.escalationDeliveryEvent} NOT IN ('delivered','bounced','complained','failed','canceled')`,
			);

	const reports = await db
		.update(moderationReports)
		.set({ escalationDeliveryEvent: input.event, escalationDeliveryAt: input.occurredAt })
		.where(
			mayOverwrite
				? sql`${moderationReports.escalationMessageId} = ${input.messageId} AND (${mayOverwrite})`
				: eq(moderationReports.escalationMessageId, input.messageId),
		)
		.returning({ id: moderationReports.id });

	const mayOverwriteAbuse = incomingIsTerminal
		? undefined
		: or(
				isNull(abuseReports.escalationDeliveryEvent),
				sql`${abuseReports.escalationDeliveryEvent} NOT IN ('delivered','bounced','complained','failed','canceled')`,
			);

	const abuse = await db
		.update(abuseReports)
		.set({ escalationDeliveryEvent: input.event, escalationDeliveryAt: input.occurredAt })
		.where(
			mayOverwriteAbuse
				? sql`${abuseReports.escalationMessageId} = ${input.messageId} AND (${mayOverwriteAbuse})`
				: eq(abuseReports.escalationMessageId, input.messageId),
		)
		.returning({ id: abuseReports.id });

	return { matched: reports.length + abuse.length };
}

export interface StoredDelivery {
	event: string;
	delivered: boolean;
	terminal: boolean;
	occurredAt: string | null;
}

const DELIVERED_EVENTS = new Set(["delivered", "opened", "clicked"]);

/**
 * Read a stored event.
 *
 * ⚠️ **`opened` and `clicked` count as delivered**, because they are later events than
 * delivery — a message somebody has read has necessarily been delivered, and reading them
 * as anything else would turn the best possible outcome into an unresolved one.
 *
 * **An unrecognized event is neither delivered nor terminal**, which fails toward
 * keep-asking rather than toward declaring success — the safe direction when the provider
 * adds a name we have not seen.
 */
export function classifyStoredEvent(event: string, occurredAt: Date | null): StoredDelivery {
	return {
		event,
		delivered: DELIVERED_EVENTS.has(event),
		terminal: DELIVERED_EVENTS.has(event) || TERMINAL_EVENTS.has(event),
		occurredAt: occurredAt?.toISOString() ?? null,
	};
}

/** The stored delivery outcome for one report, or null when nothing has arrived yet. */
export async function deliveryForReport(
	kind: "abuse" | "report",
	reportId: number,
): Promise<{ messageId: string | null; status: StoredDelivery | null }> {
	if (kind === "abuse") {
		const [row] = await db
			.select({
				messageId: abuseReports.escalationMessageId,
				event: abuseReports.escalationDeliveryEvent,
				at: abuseReports.escalationDeliveryAt,
			})
			.from(abuseReports)
			.where(eq(abuseReports.id, reportId))
			.limit(1);
		if (!row) return { messageId: null, status: null };
		return {
			messageId: row.messageId,
			status: row.event ? classifyStoredEvent(row.event, row.at) : null,
		};
	}
	const [row] = await db
		.select({
			messageId: moderationReports.escalationMessageId,
			event: moderationReports.escalationDeliveryEvent,
			at: moderationReports.escalationDeliveryAt,
		})
		.from(moderationReports)
		.where(eq(moderationReports.id, reportId))
		.limit(1);
	if (!row) return { messageId: null, status: null };
	return {
		messageId: row.messageId,
		status: row.event ? classifyStoredEvent(row.event, row.at) : null,
	};
}
