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
	/**
	 * When this account is due to be erased. Null means no deletion is pending.
	 *
	 * Deletion is **scheduled, not immediate** — Parker's ruling, 2026-08-07: the user
	 * has to understand what they lose (stated at the point of deletion, not buried in
	 * the policy), and there has to be an "oops" window long enough for a change of
	 * mind. Cancelling is simply clearing this column.
	 *
	 * The window is a **grace period, not an archive**, and the distinction is the rule
	 * that keeps this honest: nothing may start retaining data *because* a deletion is
	 * pending, nothing may extend the window, and when it elapses the wipe runs. An
	 * account with this set is already gone as far as the user is concerned — it cannot
	 * be signed into, and every session is revoked at request time — so the row's
	 * remaining life is bookkeeping rather than continued use.
	 */
	deletionRequestedAt: timestamp("deletion_requested_at", { withTimezone: true }),
	/**
	 * Whether ACTIVITY email is wanted. Defaults on; the user may turn it off.
	 *
	 * There is deliberately no equivalent for the `essential` category — deadlines,
	 * money and legal changes are not things anyone gets to be un-told, and offering a
	 * switch that quietly doesn't apply to half the messages would be worse than not
	 * offering one. The split is enforced in `services/notifications.ts`.
	 */
	notifyActivityEmail: boolean("notify_activity_email").default(true),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One thing Anthers needed to tell one person — and the **record** that it did.
 *
 * The record is the point, not the delivery. 51.05 promises *"we will tell you before
 * it takes effect — not by quietly updating a date at the bottom"*, and a promise to
 * have told someone is worth exactly as much as the evidence behind it. Sending an
 * email and keeping nothing is the same failure as the fingerprinting claim and the
 * *"we do not sell paid content to minors"* line: a protection asserted, not held.
 *
 * `dedupeKey` is what makes a **daily sweep** safe. The rescue-window job and the
 * withdrawn-Work notice both run on a schedule and both re-evaluate the same rows every
 * time; without a unique key they would mail somebody every morning until the deadline
 * they were being warned about. It is a caller-supplied natural key — `work-withdrawn:
 * <purchaseId>` — rather than a hash of the body, because the body is copy and copy
 * gets edited.
 *
 * `emailSentAt` is separate from `createdAt` on purpose: an in-app notification that
 * was never emailed (because the user opted out of that category, or because email
 * failed) is a real and different state from one that was, and collapsing them would
 * make the evidence unreliable in the direction that matters.
 */
export const notifications = pgTable(
	"notifications",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		/** `essential` | `activity` — see `notifyActivityEmail`. */
		category: text("category").notNull(),
		/** What happened, as a stable machine value. Copy lives in the service. */
		kind: text("kind").notNull(),
		title: text("title").notNull(),
		body: text("body").notNull().default(""),
		/** Where to go about it, app-relative. Empty when there is nowhere to go. */
		linkPath: text("link_path").notNull().default(""),
		/** Caller-supplied natural key. One notification per key, ever. */
		dedupeKey: text("dedupe_key").notNull(),
		emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
		readAt: timestamp("read_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Global rather than per-user: the key already names its subject, and a scheduled
		// job that resolves the same fact twice must land on the same row both times.
		uniqueIndex("uq_notifications_dedupe").on(table.dedupeKey),
		index("idx_notifications_user").on(table.userId, table.createdAt),
	],
);

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
