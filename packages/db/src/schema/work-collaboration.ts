// SPDX-License-Identifier: Apache-2.0
import { sql } from "drizzle-orm";
import { index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { works } from "./content.js";

/**
 * The other creators who own one Work.
 *
 * 🚨 **The publisher is not in this table.** `works.creatorId` is the publisher — the
 * Work's storage home (its media lives under `works/{workId}/`, so the publisher no longer
 * owns the bytes) and the repository its ATProto listing is written into. The owner set is
 * that id plus every `accepted` row here. Keeping the publisher out means a solo Work has
 * no rows at all, and a publisher handover deletes the new publisher's row and writes the
 * old publisher's row in the same transaction, so the two halves always describe one set.
 *
 * The shape mirrors `badge_collaborators` deliberately: the same pending/accepted/declined
 * lifecycle, the same invitation surface, the same two-step publisher handover. The Badge
 * version was the tested primitive; this one is the same table against a harder object.
 *
 * A row is `pending` until the invited creator accepts; only `accepted` rows are owners.
 * A `declined` row is kept so the inviter sees what happened and can decide whether to
 * send it again.
 */
// node — the other owners of one Work; the creator's own catalog, co-owned.
export const workCollaborators = pgTable(
	"work_collaborators",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** `pending` | `accepted` | `declined`. Only `accepted` is an owner. */
		status: text("status").notNull().default("pending"),
		/** Who sent the invitation. Set null when that account is gone; the collaboration outlives it. */
		invitedById: integer("invited_by_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		respondedAt: timestamp("responded_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("uq_work_collaborators_pair").on(table.workId, table.creatorId),
		// "Which Works do I co-own?" is the read behind every owner's Studio, profile and
		// Library, so the invitee side gets its own index.
		index("idx_work_collaborators_creator").on(table.creatorId, table.status),
	],
);

/**
 * One in-flight request to move a Work's publisher role.
 *
 * The publisher is `works.creatorId`; the role carries the Work's ATProto listing home
 * and the account a listing is written as, so the handover is a two-step consent. The
 * current publisher opens a `pending` row naming the target, the target accepts, and the
 * Work's `creatorId` moves in the same transaction. Storage stays where it is because the
 * media namespace is the Work's own; the listing is moved by the sync that follows.
 */
// node — the publisher-role handover between two creators on one Work.
export const workPublisherHandovers = pgTable(
	"work_publisher_handovers",
	{
		id: serial("id").primaryKey(),
		workId: integer("work_id")
			.notNull()
			.references(() => works.id, { onDelete: "cascade" }),
		fromCreatorId: integer("from_creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		toCreatorId: integer("to_creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** `pending` | `accepted` | `declined` | `canceled`. */
		status: text("status").notNull().default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		respondedAt: timestamp("responded_at", { withTimezone: true }),
	},
	(table) => [
		// One request can be open at a time. A partial unique index is the database's
		// guarantee; the route still checks first so a double click reads a clear refusal.
		uniqueIndex("uq_work_publisher_handover_pending")
			.on(table.workId)
			.where(sql`status = 'pending'`),
		index("idx_work_publisher_handovers_work").on(table.workId, table.createdAt),
	],
);
