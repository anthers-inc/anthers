// SPDX-License-Identifier: Apache-2.0
/**
 * Admin accounts: the identities that operate Anthers from the admin app.
 *
 * 🚨 **An admin account is a separate identity from an Anthers account, and nothing in this
 * file references `users`.** Platform authority — the legal queues, moderation, operations and
 * the books — lives here, on an email identity that signs in only at the admin host. An Anthers
 * account can be entered by an emailed code, by Bluesky, or by a desktop Studio's bearer token,
 * and if any of those also opened the console, taking over somebody's Anthers account would be
 * a route to platform authority. Keeping the two in separate tables, with separate codes and
 * separate sessions, is what makes that route not exist rather than merely be guarded.
 *
 * Community authority is the other holder, and it deliberately stays on Anthers accounts: a
 * creator's Keepers act on the main site as themselves. The division is written up in the wiki's
 * *Keepers → Who Handles What*.
 *
 * The one writer of every table here is `apps/api/src/services/admin-accounts.ts`, apart from
 * the emailed codes, whose hardening lives with the main site's in `services/signup-codes.ts` so
 * the two doors cannot drift apart.
 */
import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

// org — the people who run the platform. Not a creator's own identity and never on a node.
export const adminAccounts = pgTable("admin_accounts", {
	id: serial("id").primaryKey(),
	/**
	 * The address codes are sent to, and the account's only credential.
	 *
	 * Lowercased at the boundary, so one mailbox is one account. There is no password column and
	 * there must never be one: whoever reads this mailbox is the account, which is also why
	 * changing it is a super-admin action recorded in `admin_account_events`.
	 */
	email: text("email").notNull().unique(),
	/** How the account is named in the app and in the record of who did what. */
	displayName: text("display_name").notNull(),
	/**
	 * Whether this account may manage admin accounts.
	 *
	 * The whole Accounts section is super-admin only. If an ordinary admin account could invite,
	 * getting into one would be a way to add more, so the section's check sits on this column
	 * and nothing else.
	 */
	isSuperAdmin: boolean("is_super_admin").notNull().default(false),
	/**
	 * Set when the account is deactivated. A deactivated account can neither receive a code nor
	 * hold a session.
	 *
	 * A state rather than a delete, because operator actions name the account that took them and
	 * those records have to keep resolving to somebody.
	 */
	deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// org — the record of who changed an admin account and when, kept as moderation actions are.
export const adminAccountEvents = pgTable(
	"admin_account_events",
	{
		id: serial("id").primaryKey(),
		/** The account that was changed. Admin accounts are never deleted, so this never dangles. */
		accountId: integer("account_id")
			.notNull()
			.references(() => adminAccounts.id),
		/**
		 * The super-admin who made the change, or null when it was made by the recovery script.
		 *
		 * Null means *somebody with production database access ran it*, which is a real and
		 * distinct actor — it is how the first account exists and how a locked-out team gets back
		 * in — rather than an unknown.
		 */
		actorId: integer("actor_id").references(() => adminAccounts.id),
		/** One of `ADMIN_ACCOUNT_EVENT_KINDS` in `services/admin-accounts.ts`. */
		kind: text("kind").notNull(),
		/** What the change was, where the kind alone does not say — an address change's old and new address. */
		detail: jsonb("detail"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_admin_account_events_account").on(table.accountId, table.createdAt)],
);

// org — a live admin sign-in. Held only at the admin host, under a host-only cookie.
export const adminSessions = pgTable(
	"admin_sessions",
	{
		id: serial("id").primaryKey(),
		/**
		 * SHA-256 of the session token, never the token.
		 *
		 * Unlike a signup code, the token is 256 random bits, so a fast digest is enough and a
		 * slow one would put argon2 on every admin request. What the digest buys is that a read of
		 * this table — a backup, a query in a debugging session — yields no session anybody can
		 * present.
		 */
		tokenHash: text("token_hash").notNull().unique(),
		accountId: integer("account_id")
			.notNull()
			.references(() => adminAccounts.id, { onDelete: "cascade" }),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_admin_sessions_account").on(table.accountId),
		index("idx_admin_sessions_expires").on(table.expiresAt),
	],
);

// org — an emailed admin sign-in code. The same shape as `signup_codes`, in its own table.
export const adminSignInCodes = pgTable(
	"admin_sign_in_codes",
	{
		id: serial("id").primaryKey(),
		/**
		 * 🚨 **Its own table rather than a row in `signup_codes`, and that is the security
		 * property.** The main site's verify route accepts any live code for an address, so a
		 * shared table would let a code minted for the admin app sign that mailbox into Anthers —
		 * or the reverse — and a request at one door would reset the other's throttle.
		 */
		email: text("email").notNull().unique(),
		/** Argon2id over the code, for the reason given on `signup_codes.code_hash`. */
		codeHash: text("code_hash").notNull(),
		attempts: integer("attempts").notNull().default(0),
		lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [index("idx_admin_sign_in_codes_expires").on(table.expiresAt)],
);
