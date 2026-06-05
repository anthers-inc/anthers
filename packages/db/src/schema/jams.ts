// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { projects } from "./content.js";

export const gameJams = sqliteTable("game_jams", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	title: text("title").notNull(),
	slug: text("slug").notNull().unique(),
	description: text("description").default(""),
	theme: text("theme").default(""), // hidden until jam starts
	coverImage: text("cover_image").default(""),

	// Schedule
	startAt: integer("start_at", { mode: "timestamp_ms" }).notNull(),
	endAt: integer("end_at", { mode: "timestamp_ms" }).notNull(),
	votingEndAt: integer("voting_end_at", { mode: "timestamp_ms" }).notNull(),

	// Settings
	maxTeamSize: integer("max_team_size").default(0), // 0 = unlimited
	allowLateSubmissions: integer("allow_late_submissions", { mode: "boolean" }).default(false),

	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const jamEntries = sqliteTable(
	"jam_entries",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		jamId: integer("jam_id")
			.notNull()
			.references(() => gameJams.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		submittedById: integer("submitted_by_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [uniqueIndex("uq_jam_entries_jam_project").on(table.jamId, table.projectId)],
);

export const jamVotes = sqliteTable(
	"jam_votes",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		entryId: integer("entry_id")
			.notNull()
			.references(() => jamEntries.id, { onDelete: "cascade" }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		score: integer("score").notNull(), // 1-5, validated at application layer
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [uniqueIndex("uq_jam_votes_entry_user").on(table.entryId, table.userId)],
);
