// SPDX-License-Identifier: Apache-2.0
/**
 * Mark a report as escalated in the one place the evidence lives now — the mail ledger.
 *
 * Tests used to write `escalated_at` on the report row; the escalation's proof is an
 * `outbound_emails` row keyed `<kind>-escalation:<id>`, so the fixture writes that.
 */
import { db } from "@anthers/db/client";
import { outboundEmails } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

export async function markEscalated(
	kind: "moderation" | "abuse",
	reportId: number,
	opts: {
		sentAt?: Date | null;
		messageId?: string | null;
		event?: string | null;
		eventAt?: Date | null;
	} = {},
): Promise<void> {
	await db
		.insert(outboundEmails)
		.values({
			dedupeKey: `${kind === "moderation" ? "moderation" : "abuse"}-escalation:${reportId}`,
			kind: "escalation",
			recipient: "abuse@example.com",
			detail: {
				reportKind: kind === "moderation" ? "moderation_report" : "abuse_report",
				reportId: String(reportId),
			},
			sentAt: opts.sentAt === undefined ? new Date() : opts.sentAt,
			messageId: opts.messageId ?? null,
			deliveryEvent: opts.event ?? null,
			deliveryEventAt: opts.eventAt ?? null,
		})
		.onConflictDoNothing({ target: outboundEmails.dedupeKey });
}

/** Remove the ledger row a test seeded, so a rerun starts from "nobody told". */
export async function clearEscalation(
	kind: "moderation" | "abuse",
	reportId: number,
): Promise<void> {
	await db
		.delete(outboundEmails)
		.where(
			eq(
				outboundEmails.dedupeKey,
				`${kind === "moderation" ? "moderation" : "abuse"}-escalation:${reportId}`,
			),
		);
}
