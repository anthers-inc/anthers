import {
	boolean,
	integer,
	pgTable,
	serial,
	smallint,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects } from "./content.js";

export const gameJams = pgTable("game_jams", {
	id: serial("id").primaryKey(),
	creatorId: integer("creator_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	title: varchar("title", { length: 255 }).notNull(),
	slug: varchar("slug", { length: 255 }).notNull().unique(),
	description: text("description").default(""),
	theme: varchar("theme", { length: 255 }).default(""), // hidden until jam starts
	coverImage: varchar("cover_image", { length: 500 }).default(""),

	// Schedule
	startAt: timestamp("start_at").notNull(),
	endAt: timestamp("end_at").notNull(),
	votingEndAt: timestamp("voting_end_at").notNull(),

	// Settings
	maxTeamSize: integer("max_team_size").default(0), // 0 = unlimited
	allowLateSubmissions: boolean("allow_late_submissions").default(false),

	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const jamEntries = pgTable(
	"jam_entries",
	{
		id: serial("id").primaryKey(),
		jamId: integer("jam_id")
			.notNull()
			.references(() => gameJams.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		submittedById: integer("submitted_by_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_jam_entries_jam_project").on(table.jamId, table.projectId)],
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
		score: smallint("score").notNull(), // 1-5, validated at application layer
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_jam_votes_entry_user").on(table.entryId, table.userId)],
);
