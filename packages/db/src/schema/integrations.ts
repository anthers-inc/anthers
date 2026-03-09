import {
	date,
	index,
	integer,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";
import { boolean } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { projects, posts } from "./content.js";

export const platformConnections = pgTable(
	"platform_connections",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		platform: varchar("platform", { length: 20 }).notNull(), // youtube | steam | itchio | substack

		// OAuth tokens
		accessToken: text("access_token").default(""),
		refreshToken: text("refresh_token").default(""),
		tokenExpiresAt: timestamp("token_expires_at"),

		// API key
		apiKey: text("api_key").default(""),

		// Platform-specific identifiers
		platformUserId: varchar("platform_user_id", { length: 255 }).default(""),
		platformUsername: varchar("platform_username", { length: 255 }).default(""),

		isActive: boolean("is_active").default(true),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_platform_conn_user_platform").on(table.userId, table.platform)],
);

export const crossPublishResults = pgTable(
	"cross_publish_results",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		platform: varchar("platform", { length: 20 }).notNull(), // youtube | steam | itchio | substack

		// Local content reference
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),

		// External identifiers
		externalId: varchar("external_id", { length: 255 }).default(""),
		externalUrl: varchar("external_url", { length: 500 }).default(""),

		status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | published | failed
		errorMessage: text("error_message").default(""),
		publishedAt: timestamp("published_at"),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(table) => [index("idx_cross_publish_user_platform").on(table.userId, table.platform)],
);

export const externalMetricSnapshots = pgTable(
	"external_metric_snapshots",
	{
		id: serial("id").primaryKey(),
		crossPublishId: integer("cross_publish_id")
			.notNull()
			.references(() => crossPublishResults.id, { onDelete: "cascade" }),
		views: integer("views").default(0),
		likes: integer("likes").default(0),
		comments: integer("comments").default(0),
		shares: integer("shares").default(0),
		watchTimeSeconds: integer("watch_time_seconds").default(0),
		revenueCents: integer("revenue_cents").default(0),
		snapshotDate: date("snapshot_date").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_ext_metric_publish_date").on(table.crossPublishId, table.snapshotDate),
	],
);
