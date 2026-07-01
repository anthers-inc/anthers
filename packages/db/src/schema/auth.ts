// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	boolean,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
	id: serial("id").primaryKey(),
	username: text("username").notNull().unique(),
	email: text("email").notNull().unique(),
	passwordHash: text("password_hash"), // nullable for ATProto-only users
	displayName: text("display_name").default(""),
	bio: text("bio").default(""),
	isCreator: boolean("is_creator").default(false),
	avatar: text("avatar").default(""),
	headerImage: text("header_image").default(""),
	websiteUrl: text("website_url").default(""),
	location: text("location").default(""),
	emailVerified: boolean("email_verified").default(false),
	atprotoDid: text("atproto_did").unique(),
	atprotoHandle: text("atproto_handle").default(""),
	atprotoPdsUrl: text("atproto_pds_url").default(""),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
	id: serial("id").primaryKey(),
	token: text("token").notNull().unique(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	token: text("token").notNull().unique(),
	type: text("type").notNull(), // "email_verify" | "password_reset"
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const atprotoSessions = pgTable("atproto_sessions", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	accessToken: text("access_token").default(""),
	refreshToken: text("refresh_token").default(""),
	dpopPrivatePem: text("dpop_private_pem").default(""),
	dpopJwk: jsonb("dpop_jwk").default({}),
	tokenEndpoint: text("token_endpoint").default(""),
	dpopNonce: text("dpop_nonce").default(""),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const follows = pgTable(
	"follows",
	{
		id: serial("id").primaryKey(),
		followerId: integer("follower_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		creatorId: integer("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		atprotoUri: text("atproto_uri").unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_follows_follower_creator").on(table.followerId, table.creatorId)],
);
