import {
	boolean,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
	id: serial("id").primaryKey(),
	username: varchar("username", { length: 150 }).notNull().unique(),
	email: varchar("email", { length: 254 }).notNull().unique(),
	passwordHash: varchar("password_hash", { length: 255 }), // nullable for ATProto-only users
	displayName: varchar("display_name", { length: 150 }).default(""),
	bio: text("bio").default(""),
	isCreator: boolean("is_creator").default(false),
	avatar: varchar("avatar", { length: 500 }).default(""),
	headerImage: varchar("header_image", { length: 500 }).default(""),
	websiteUrl: varchar("website_url", { length: 500 }).default(""),
	location: varchar("location", { length: 100 }).default(""),
	emailVerified: boolean("email_verified").default(false),
	atprotoDid: varchar("atproto_did", { length: 255 }).unique(),
	atprotoHandle: varchar("atproto_handle", { length: 255 }).default(""),
	atprotoPdsUrl: varchar("atproto_pds_url", { length: 500 }).default(""),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const sessions = pgTable("sessions", {
	id: serial("id").primaryKey(),
	token: varchar("token", { length: 64 }).notNull().unique(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	ipAddress: varchar("ip_address", { length: 45 }),
	userAgent: text("user_agent"),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const verificationTokens = pgTable("verification_tokens", {
	id: serial("id").primaryKey(),
	userId: integer("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	token: varchar("token", { length: 64 }).notNull().unique(),
	type: varchar("type", { length: 20 }).notNull(), // "email_verify" | "password_reset"
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").defaultNow().notNull(),
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
	tokenEndpoint: varchar("token_endpoint", { length: 500 }).default(""),
	dpopNonce: varchar("dpop_nonce", { length: 255 }).default(""),
	createdAt: timestamp("created_at").defaultNow().notNull(),
	updatedAt: timestamp("updated_at").defaultNow().notNull(),
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
		atprotoUri: varchar("atproto_uri", { length: 512 }).unique(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
	},
	(table) => [uniqueIndex("uq_follows_follower_creator").on(table.followerId, table.creatorId)],
);
