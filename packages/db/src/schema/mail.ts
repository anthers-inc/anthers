// SPDX-License-Identifier: Apache-2.0
/**
 * What Anthers mailed, and what became of it — one row per message, whoever it was for.
 *
 * 🚨 **This is a delivery ledger, not a message archive.** The body, the subject copy and
 * the reason live with whatever wrote the mail; this row answers only the two questions
 * every sender needs back: *did this one go*, and *what did the provider say became of
 * it*. A receipt, a deadline reminder, a notification and a moderation escalation are all
 * the same four facts, and keeping them apart meant four copies of the delivery webhook's
 * match and four places for a failed mail to hide.
 *
 * ⭐ **The row is written BEFORE the send.** `sentAt` null therefore means *decided on and
 * never accepted by the provider* — the failure state the admin panel selects — and a
 * crash between the two loses a reminder rather than sending one twice.
 *
 * `dedupeKey` is the idempotency latch and is caller-supplied, never a hash of the body:
 * copy gets edited, and the same fact re-evaluated by a sweep must land on the same row.
 */
import {
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

// org — mail is the organization speaking to a person, and the delivery evidence is the
// organization's promise kept. No creator node sends from this table.
export const outboundEmails = pgTable(
	"outbound_emails",
	{
		id: serial("id").primaryKey(),
		/** Caller-supplied natural key: one message per key, ever. */
		dedupeKey: text("dedupe_key").notNull(),
		/** `receipt` | `deadline` — the family of mail, for the panel's grouping. */
		kind: text("kind").notNull(),
		/** The address the message went to, captured at send time. */
		recipient: text("recipient").notNull(),
		/** The account it concerned, when there is one. Set null: the record outlives it. */
		userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
		/** What the mail was about, where the family has a short answer (a deadline's title). */
		subject: text("subject").notNull().default(""),
		/** The family's own detail — a receipt's kind and role, a reminder's source. */
		detail: jsonb("detail").$type<Record<string, string>>(),
		/** The provider's id, when there is one — what a delivery event matches against. */
		messageId: text("message_id"),
		/** When the provider accepted it. Null means decided on and not sent. */
		sentAt: timestamp("sent_at", { withTimezone: true }),
		/** What the provider later reported: `delivered`, `bounced`, `complained`, … */
		deliveryEvent: text("delivery_event"),
		/** When that event happened, per the provider. */
		deliveryEventAt: timestamp("delivery_event_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// The latch: a repeated send finds the row and sends nothing.
		uniqueIndex("uq_outbound_emails_dedupe").on(table.dedupeKey),
		// The delivery webhook matches on the provider's id.
		index("idx_outbound_emails_message").on(table.messageId),
		// The panel reads a family newest-first.
		index("idx_outbound_emails_kind_created").on(table.kind, table.createdAt),
	],
);
