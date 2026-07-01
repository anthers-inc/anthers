// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	bigint,
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
import { posts, projects } from "./content.js";

export const platformConnections = pgTable(
	"platform_connections",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		platform: text("platform").notNull(), // youtube | steam | itchio | substack

		// OAuth tokens
		accessToken: text("access_token").default(""),
		refreshToken: text("refresh_token").default(""),
		tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),

		// API key
		apiKey: text("api_key").default(""),

		// Platform-specific identifiers
		platformUserId: text("platform_user_id").default(""),
		platformUsername: text("platform_username").default(""),

		isActive: boolean("is_active").default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
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
		platform: text("platform").notNull(), // youtube | steam | itchio | substack

		// Local content reference
		projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
		postId: integer("post_id").references(() => posts.id, { onDelete: "cascade" }),

		// External identifiers
		externalId: text("external_id").default(""),
		externalUrl: text("external_url").default(""),

		status: text("status").notNull().default("pending"), // pending | published | failed
		errorMessage: text("error_message").default(""),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_cross_publish_user_platform").on(table.userId, table.platform)],
);

// snapshotDate is stored as an ISO date string (YYYY-MM-DD).
// External-platform metrics mirror YouTube-scale counts — bigint, not integer.
export const externalMetricSnapshots = pgTable(
	"external_metric_snapshots",
	{
		id: serial("id").primaryKey(),
		crossPublishId: integer("cross_publish_id")
			.notNull()
			.references(() => crossPublishResults.id, { onDelete: "cascade" }),
		views: bigint("views", { mode: "number" }).default(0),
		likes: integer("likes").default(0),
		comments: integer("comments").default(0),
		shares: integer("shares").default(0),
		watchTimeSeconds: bigint("watch_time_seconds", { mode: "number" }).default(0),
		revenueCents: bigint("revenue_cents", { mode: "number" }).default(0),
		snapshotDate: text("snapshot_date").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_ext_metric_publish_date").on(table.crossPublishId, table.snapshotDate),
	],
);
