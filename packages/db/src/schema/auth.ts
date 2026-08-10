// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	boolean,
	index,
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
	// Platform operator flag — gates the admin/ops console (requireAdmin). Set out
	// of band (db:admin CLI or DEV_ACCOUNT_ADMIN), never self-serve at sign-up.
	isAdmin: boolean("is_admin").default(false),
	avatar: text("avatar").default(""),
	headerImage: text("header_image").default(""),
	websiteUrl: text("website_url").default(""),
	location: text("location").default(""),
	emailVerified: boolean("email_verified").default(false),
	// UI light/dark preference ("light" | "dark"); null = no account-level choice, so
	// the client falls back to the device (localStorage) setting / default.
	themePreference: text("theme_preference"),
	atprotoDid: text("atproto_did").unique(),
	atprotoHandle: text("atproto_handle").default(""),
	atprotoPdsUrl: text("atproto_pds_url").default(""),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable(
	"sessions",
	{
		id: serial("id").primaryKey(),
		token: text("token").notNull().unique(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		// How the session is carried: "web" = the browser cookie, "desktop" = a bearer
		// token held by an installed Studio app. Same session primitive either way (an
		// opaque row with an expiry); `kind` exists so a creator can tell their devices
		// apart in the revocation list, and so a stolen laptop is killable without
		// signing every browser out.
		kind: text("kind").notNull().default("web"),
		// Human label for the revocation list — the device name the desktop app reports
		// at enrolment ("parker-thinkpad"). Null for browser sessions, which are
		// described by user_agent instead.
		label: text("label"),
		// Last time this session authenticated a request, throttled to one write per
		// hour (see touchSession) so a Devices list can show "last used" without a DB
		// write on every API call.
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	// Revoking every session for a user (Settings → Devices, and the cascade when an
	// account is deleted) filters on user_id, which had no index of its own — `token`
	// is unique and covers lookup-by-token only.
	(table) => [index("idx_sessions_user").on(table.userId)],
);

/**
 * One in-flight desktop enrolment. The desktop app never sees a password: it opens
 * an authorize page in the SYSTEM browser (where the creator already holds a normal
 * cookie session), and one confirm click mints the desktop session here.
 *
 * PKCE binds the two halves. The app generates a random verifier, sends only its
 * SHA-256 `challenge` to the browser, and must present the verifier to redeem the
 * `code`. That way another local app that hijacks the `anthers://` scheme and steals
 * the code off the deep link still cannot exchange it — it never saw the verifier.
 *
 * Rows are single-use (`consumedAt`) and short-lived (`expiresAt`); the swept remains
 * carry no secret, since `sessionToken` is cleared on redemption.
 */
export const desktopAuthRequests = pgTable(
	"desktop_auth_requests",
	{
		id: serial("id").primaryKey(),
		// SHA-256 of the app's PKCE verifier, hex. Supplied when the flow starts.
		challenge: text("challenge").notNull().unique(),
		// One-time redemption code, minted at confirm. Null until the creator approves.
		code: text("code").unique(),
		// Device label the app asked for, shown on the authorize page so the creator can
		// see what they are approving.
		label: text("label"),
		// The minted session's token, held only between confirm and redemption.
		sessionToken: text("session_token"),
		userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_desktop_auth_requests_user").on(table.userId)],
);

export const verificationTokens = pgTable(
	"verification_tokens",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		type: text("type").notNull(), // "email_verify" | "password_reset"
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_verification_tokens_user").on(table.userId)],
);

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
	(table) => [
		uniqueIndex("uq_follows_follower_creator").on(table.followerId, table.creatorId),
		// followerId is already the leading column of the unique index above; creatorId
		// is not covered by anything, and "who follows this creator" is the read.
		index("idx_follows_creator").on(table.creatorId),
	],
);

/**
 * One user's decision that they and another user should not meet.
 *
 * **It lives here, beside `follows`, and not in `moderation.ts` — that placement is
 * the design.** A block is a relationship primitive between two accounts, the same
 * shape as a follow and its opposite; moderation is an operator's judgment about
 * content. Keeping them in different files is what stops a block acquiring a review
 * queue, a reason code, or an appeal, none of which a personal boundary should ever
 * need. `services/blocks.ts` is the only writer, and it is not the moderation service.
 *
 * The row is directed (`blocker` → `blocked`) but **enforcement is symmetric**: every
 * read asks whether a row exists in *either* direction. Storing it directed keeps
 * "who chose this" answerable — which matters for an unblock, since only the blocker
 * may lift it — while the symmetric read is what actually severs contact. A one-way
 * block would leave the blocked party able to read the blocker's comments, open their
 * profile and follow them, which removes the wrong half.
 *
 * Both FKs cascade, unlike the two in `moderation.ts` that are deliberately `set
 * null`. The distinction is that a moderation record is a *record* and has to outlive
 * the account it concerns; a block is a *live relationship* and means nothing once
 * either end is gone.
 */
export const userBlocks = pgTable(
	"user_blocks",
	{
		id: serial("id").primaryKey(),
		blockerId: integer("blocker_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		blockedId: integer("blocked_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Blocking twice is idempotent, not a second row.
		uniqueIndex("uq_user_blocks_pair").on(table.blockerId, table.blockedId),
		// Enforcement reads the pair from BOTH sides, so the reverse direction needs an
		// index of its own — `blockerId` is only the leading column of the unique index
		// above, which does nothing for "who has blocked me?".
		index("idx_user_blocks_blocked").on(table.blockedId),
	],
);
