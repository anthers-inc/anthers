import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	username: text("username").notNull().unique(),
	email: text("email").notNull().unique(),
	passwordHash: text("password_hash"), // nullable for ATProto-only users
	displayName: text("display_name").default(""),
	bio: text("bio").default(""),
	isCreator: integer("is_creator", { mode: "boolean" }).default(false),
	avatar: text("avatar").default(""),
	headerImage: text("header_image").default(""),
	websiteUrl: text("website_url").default(""),
	location: text("location").default(""),
	emailVerified: integer("email_verified", { mode: "boolean" }).default(false),
	atprotoDid: text("atproto_did").unique(),
	atprotoHandle: text("atproto_handle").default(""),
	atprotoPdsUrl: text("atproto_pds_url").default(""),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const sessions = sqliteTable("sessions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	token: text("token").notNull().unique(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const verificationTokens = sqliteTable("verification_tokens", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	token: text("token").notNull().unique(),
	type: text("type").notNull(), // "email_verify" | "password_reset"
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const atprotoSessions = sqliteTable("atproto_sessions", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	accessToken: text("access_token").default(""),
	refreshToken: text("refresh_token").default(""),
	dpopPrivatePem: text("dpop_private_pem").default(""),
	dpopJwk: text("dpop_jwk", { mode: "json" }).default({}),
	tokenEndpoint: text("token_endpoint").default(""),
	dpopNonce: text("dpop_nonce").default(""),
	createdAt: integer("created_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" })
		.default(sql`(unixepoch() * 1000)`)
		.notNull(),
});

export const follows = sqliteTable(
	"follows",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		followerId: integer("follower_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		atprotoUri: text("atproto_uri").unique(),
		createdAt: integer("created_at", { mode: "timestamp_ms" })
			.default(sql`(unixepoch() * 1000)`)
			.notNull(),
	},
	(table) => [uniqueIndex("uq_follows_follower_creator").on(table.followerId, table.creatorId)],
);
