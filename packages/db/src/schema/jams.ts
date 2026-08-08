// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	boolean,
	index,
	integer,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { posts } from "./content.js";

export const gameJams = pgTable(
	"game_jams",
	{
		id: serial("id").primaryKey(),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull(),
		slug: text("slug").notNull().unique(),
		description: text("description").default(""),
		theme: text("theme").default(""), // hidden until jam starts
		coverImage: text("cover_image").default(""),

		// Schedule
		startAt: timestamp("start_at", { withTimezone: true }).notNull(),
		endAt: timestamp("end_at", { withTimezone: true }).notNull(),
		votingEndAt: timestamp("voting_end_at", { withTimezone: true }).notNull(),

		// Settings
		maxTeamSize: integer("max_team_size").default(0), // 0 = unlimited
		allowLateSubmissions: boolean("allow_late_submissions").default(false),

		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_game_jams_creator").on(table.creatorId)],
);

export const jamEntries = pgTable(
	"jam_entries",
	{
		id: serial("id").primaryKey(),
		jamId: integer("jam_id")
			.notNull()
			.references(() => gameJams.id, { onDelete: "cascade" }),
		postId: integer("post_id")
			.notNull()
			.references(() => posts.id, { onDelete: "cascade" }),
		submittedById: integer("submitted_by_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_jam_entries_jam_post").on(table.jamId, table.postId),
		// postId is only the TRAILING column of the unique index above, so it cannot serve
		// a lookup by post on its own — which is what deleting a post needs.
		index("idx_jam_entries_post").on(table.postId),
		index("idx_jam_entries_submitted_by").on(table.submittedById),
	],
);

export const jamVotes = pgTable(
	"jam_votes",
	{
		id: serial("id").primaryKey(),
		entryId: integer("entry_id")
			.notNull()
			.references(() => jamEntries.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		score: integer("score").notNull(), // 1-5, validated at application layer
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_jam_votes_entry_user").on(table.entryId, table.userId),
		index("idx_jam_votes_user").on(table.userId),
	],
);
