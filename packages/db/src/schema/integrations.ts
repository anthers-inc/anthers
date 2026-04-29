import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth.js";
import { projects, posts } from "./content.js";

export const platformConnections = sqliteTable(
	"platform_connections",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		platform: text("platform").notNull(), // youtube | steam | itchio | substack

		// OAuth tokens
		accessToken: text("access_token").default(""),
		refreshToken: text("refresh_token").default(""),
		tokenExpiresAt: integer("token_expires_at", { mode: "timestamp_ms" }),

		// API key
		apiKey: text("api_key").default(""),

		// Platform-specific identifiers
		platformUserId: text("platform_user_id").default(""),
		platformUsername: text("platform_username").default(""),

		isActive: integer("is_active", { mode: "boolean" }).default(true),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [uniqueIndex("uq_platform_conn_user_platform").on(table.userId, table.platform)],
);

export const crossPublishResults = sqliteTable(
	"cross_publish_results",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
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
		publishedAt: integer("published_at", { mode: "timestamp_ms" }),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
		updatedAt: integer("updated_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [index("idx_cross_publish_user_platform").on(table.userId, table.platform)],
);

// snapshotDate is stored as an ISO date string (YYYY-MM-DD).
export const externalMetricSnapshots = sqliteTable(
	"external_metric_snapshots",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		crossPublishId: integer("cross_publish_id")
			.notNull()
			.references(() => crossPublishResults.id, { onDelete: "cascade" }),
		views: integer("views").default(0),
		likes: integer("likes").default(0),
		comments: integer("comments").default(0),
		shares: integer("shares").default(0),
		watchTimeSeconds: integer("watch_time_seconds").default(0),
		revenueCents: integer("revenue_cents").default(0),
		snapshotDate: text("snapshot_date").notNull(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [
		uniqueIndex("uq_ext_metric_publish_date").on(table.crossPublishId, table.snapshotDate),
	],
);
