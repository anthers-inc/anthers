// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Schema role classification (41.02 Federation Topology):
 *
 *   node = a creator's own — identity, content records, media, personal relationships.
 *   org  = network-wide or money — feeds, pools, payouts, moderation, telemetry.
 *   both = genuinely split by row, where one table serves both roles.
 *
 * The boundary table in 41.02 is the guiding map; disagreements are called out
 * per-table below and collected in the findings written back to 41.02.
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
	uniqueIndex,
} from "drizzle-orm/pg-core";

// node — a person's identity. Node-canonical (41.02: "Identity lives on the creator
// node / ATProto-native"). `isAdmin` and `emailVerified` are org-imposed annotations on
// the row, which is why this is `node` rather than `both`: the row's owner is the person,
// not the org, and the org's flags are columns on someone else's record.
export const users = pgTable("users", {
	id: serial("id").primaryKey(),
	/**
	 * The handle, and the `/:username` profile URL. **Null until onboarding claims one.**
	 *
	 * The signup ceremony creates the account the moment an emailed code is verified —
	 * before a username has been chosen — so that payment is an ordinary authenticated
	 * call rather than a second half-built identity. That leaves a real window where an
	 * account exists with no handle, and the column has to be able to say so.
	 *
	 * A shared `PENDING` literal was considered and does not work: this column is unique,
	 * so every pending account would collide on the index, while Postgres allows many
	 * nulls under one. An email-as-placeholder was rejected for a worse reason — this
	 * value is the public profile URL and a field in `serializePublicUser`, so it would
	 * publish the address.
	 *
	 * Nothing strands: sign-in already accepts an email *or* a username, so someone who
	 * abandons onboarding can come back and finish. What null costs is that every public
	 * surface has to refuse an account that has not claimed one — see `publicHandle()` in
	 * `routes/accounts.ts` and the `/:username` route's own guard.
	 */
	username: text("username").unique(),
	email: text("email").notNull().unique(),
	/**
	 * Argon2id hash, or null.
	 *
	 * Null has meant "ATProto-only" for a long time; since the signup ceremony it also
	 * means **"chose not to set one"**, which is a supported end state rather than a
	 * half-finished account. Those users sign in with an emailed code (`/auth/signup/*`),
	 * which is why that pair signs in an existing account as well as creating a new one.
	 */
	passwordHash: text("password_hash"),
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
 * A formal request to exercise a data right, and the clock it started.
 *
 * 51.05 extends GDPR/CPRA-level rights to everyone and promises a response **within
 * 30 days**. Two of those rights are self-serve — export and deletion both have
 * buttons — and this exists for the rest: rectification beyond what settings can edit,
 * objection to a particular use, and "tell me exactly what you hold about me".
 *
 * The row exists because **a promise with a deadline needs somewhere the deadline is
 * visible.** Requests arriving as email into one person's inbox is not a mechanism; it
 * is a hope. `dueAt` is stamped at creation rather than computed at read time so the
 * commitment is fixed at the moment it was made, and cannot quietly move if the policy
 * later changes the window.
 *
 * `userId` is `set null` rather than cascade for the same reason the moderation
 * records are: a request to be forgotten, and the record that it was honoured, must
 * outlive the account it concerned — otherwise the evidence disappears exactly when it
 * would be needed.
 */
// org — a formal data-rights request under GDPR/CPRA. The org is who must respond
// within 30 days (51.05); a creator node has no obligations under these regimes. The
// row outlives the account (`userId` is set null) because the org's evidence of
// compliance must survive erasure.
export const rightsRequests = pgTable(
	"rights_requests",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
		/** Captured at request time: the account may be gone before this is answered. */
		email: text("email").notNull(),
		/** access | rectification | objection | portability | other */
		kind: text("kind").notNull(),
		details: text("details").notNull().default(""),
		/** open | resolved */
		status: text("status").notNull().default("open"),
		/** Stamped at creation — the commitment is fixed when it is made. */
		dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		resolutionNote: text("resolution_note").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		index("idx_rights_requests_status").on(table.status, table.dueAt),
		index("idx_rights_requests_user").on(table.userId),
	],
);

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
// org — the org telling a person something, and the record that it did (51.05). A
// creator node has no outbound notification obligation; this is the org's evidence of
// a promise kept.
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

// node — a live auth credential. Identity is node-canonical (41.02), and a session
// is how that identity authenticates. The org holds a copy to verify requests, but the
// relationship is node-owned (a creator can revoke their own sessions).
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
// node — a desktop enrolment is node auth (PKCE flow for the Studio app). Same
// reasoning as `sessions`: the credential belongs to the identity, which is node.
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

// node — email verification is node auth. The token authenticates an identity the
// node owns; the org holds a copy to verify, as with `sessions`.
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

/**
 * One live email-verification code, keyed by the address rather than by a user.
 *
 * 🚨 **This table exists because the code has to come BEFORE the account.** Every other
 * credential in this file hangs off a `user_id`; the signup ceremony asks for an address
 * and proves control of it before any row in `users` exists, so there is nothing to hang
 * it off. That inversion is the whole reason `verification_tokens` could not be reused.
 *
 * The address is the key — **one live code per address, ever**, replaced on re-request
 * rather than appended. That is what makes "Send it again" safe: a second code silently
 * retires the first, so a mailbox holding three codes has exactly one that works (the
 * newest), which is the behaviour a reader already expects from every other site.
 *
 * What proving the address buys depends on whether it is already an account:
 * a new address is **created** and signed in; an existing one is **signed in**. Both
 * live here because the caller cannot be told which case it is without leaking whether
 * the address is registered — see `POST /auth/signup/start`.
 */
// org — a signup code is pre-account: the ceremony asks for an address and proves
// control of it *before any user row exists*. There is no node yet to own it, so it is
// org-side by elimination. The address becomes node identity once the account is
// created, but the code itself is the org's gate.
export const signupCodes = pgTable(
	"signup_codes",
	{
		id: serial("id").primaryKey(),
		/** Lowercased at the boundary, so `A@b.com` and `a@b.com` are one row. */
		email: text("email").notNull().unique(),
		/**
		 * Argon2id over the code, never the code itself.
		 *
		 * Deliberately the same hash as a password, and the reason is the code's length:
		 * six characters from a 31-symbol alphabet is ~887 million possibilities, which a
		 * fast digest turns back into the plaintext in milliseconds. A cheap hash here
		 * would be decoration. This one means a leaked backup does not hand out live
		 * accounts, and the cost is bounded by `attempts` — at most a handful of
		 * verifications per code, never a hot path.
		 */
		codeHash: text("code_hash").notNull(),
		/**
		 * Wrong guesses so far. At `SIGNUP_CODE_MAX_ATTEMPTS` the row is spent.
		 *
		 * Counted per code rather than per address on purpose: the cap has to survive the
		 * attacker choosing to re-request, and it does, because a re-request replaces the
		 * row and issues a code they still have to receive.
		 */
		attempts: integer("attempts").notNull().default(0),
		/**
		 * When the last code went out — the rate limit's whole state.
		 *
		 * Separate from `createdAt` because a re-request updates this row in place, so
		 * `createdAt` is when the address first asked and this is when it last got mail.
		 * Without it, "always return 200" degrades into a free mail-bomb aimed at anyone
		 * whose address you know.
		 */
		lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	// Swept by PRUNE_CREDENTIALS alongside the other two expiring credential tables.
	(table) => [index("idx_signup_codes_expires").on(table.expiresAt)],
);

// node — ATProto DPoP tokens are node identity (41.02: "Identity lives on the creator
// node / ATProto-native"). The org holds them to sign requests on the creator's behalf,
// but they are the creator's credentials, not the org's.
//
// 🚨 The DID is the key, not the user id, because `@atproto/oauth-client`'s SessionStore
// is addressed by the token subject (`sub`) and knows nothing about Anthers accounts. The
// row is therefore written before the account exists on the login path — which is why
// `userId` is nullable and reconciled afterwards rather than being the primary linkage.
// `session` holds the SDK's own serialized shape (token set + DPoP JWK); do not reach
// into it from application code, because its layout belongs to the SDK.
export const atprotoSessions = pgTable("atproto_sessions", {
	id: serial("id").primaryKey(),
	did: text("did").notNull().unique(),
	userId: integer("user_id")
		.unique()
		.references(() => users.id, { onDelete: "cascade" }),
	session: jsonb("session").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const atprotoOauthState = pgTable("atproto_oauth_state", {
	key: text("key").primaryKey(),
	state: jsonb("state").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// node — a pending OAuth authorization, keyed by the `state` parameter. This replaces an
// in-process `Map`, which lost every in-flight authorization on restart and could not
// survive a callback landing on a different instance than the initiation.
//
// `appState` is the SDK's own passthrough field: `authorize()` takes it, stores it HERE
// (server-side, never in the redirect), and `callback()` hands it back. That is where the
// intent and the linking user id ride, so neither is ever client-supplied.
//
// ⚠️ Rows are swept on a TTL. Nothing else deletes them, so a store without the sweep
// grows without bound — the SDK's own note says the cleanup is the implementation's job.

/**
 * A signup somebody has asked for and not yet finished — the **pending account**.
 *
 * 🚨 **It is a table of its own rather than a row in `users`, and the hazard decides
 * that.** `users.email` is `NOT NULL UNIQUE`, so writing a pending account there would
 * claim an address before anybody had proved they could read it: type a stranger's address
 * into `/subscribe` and its real owner cannot sign up until the row expires. Keeping the
 * pre-account state in its own table is the same shape `signup_codes` already uses, and for
 * the same reason — the row expires on its own and mints nothing.
 *
 * It holds what `/subscribe` was told, so that the page which finishes the job can say what
 * is about to be committed, and so that somebody who walks away can come back to it. Both
 * doors write one: the emailed one and the Bluesky one.
 *
 * ⚠️ **`token` is an opaque random string held in an httpOnly cookie, and it is what binds
 * the row to a browser.** Neither the DID nor the address could do that job: both are
 * public or guessable, and a row claimable by naming one would let anybody take over a
 * signup somebody else had started. It is a token in a table rather than a signed cookie
 * because a signed cookie needs a new secret in `.do/app.yaml`, and an unset required
 * secret is exactly how production broke on 2026-08-15 — this needs no boot-time
 * configuration at all.
 *
 * 🚨 **Resumption in a DIFFERENT browser is gated on the emailed code and on nothing else.**
 * `emailProvedAt` is what records that gate being passed, and it is stamped only where a
 * code sent to `email` has actually been completed. Being able to *name* an address is not
 * proof; reading mail sent to it is. The one thing an address-resumed row may not carry
 * across is `atprotoDid` — see `services/pending-signups.ts` for why, and for the takeover
 * it prevents.
 *
 * ⚠️ Swept on a TTL, for the same reason `atproto_oauth_state` is: nothing else deletes
 * these, an abandoned signup is the normal case rather than the exception, and an abandoned
 * one is personal data belonging to somebody who never became a user (51.05).
 */
// org — a signup that has been asked for and not yet finished. Pre-account by
// construction: there is no node yet to own it, exactly as with `signup_codes`. The
// identity fields become node identity once the account is created.
export const pendingSignups = pgTable(
	"pending_signups",
	{
		token: text("token").primaryKey(),
		/**
		 * Where the code goes. **Nullable**, because a Bluesky signup whose PDS refused the
		 * email scope reaches the finishing page with no address at all and is asked for one
		 * there. Lowercased at the boundary, like every other address in this file.
		 */
		email: text("email"),
		/**
		 * When a code sent to `email` was completed. Null until it was.
		 *
		 * 🚨 The account is minted from this stamp plus a cookie, so nothing may set it that
		 * has not just watched somebody read a code out of that mailbox.
		 */
		emailProvedAt: timestamp("email_proved_at", { withTimezone: true }),
		/** The proved ATProto identity, when the person came through that door. */
		atprotoDid: text("atproto_did"),
		atprotoHandle: text("atproto_handle").notNull().default(""),
		atprotoPdsUrl: text("atproto_pds_url").notNull().default(""),
		/** `SignupPicks` from `@anthers/shared/signup` — validated at the route, never trusted raw. */
		picks: jsonb("picks").notNull().default({}),
		/** Where the visitor was headed before signing up interrupted them. Sanitized on write. */
		next: text("next").notNull().default(""),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// Resuming by address, which is what a completed sign-in code unlocks.
		index("idx_pending_signups_email").on(table.email),
		// Resuming by identity, which is what a second OAuth round trip unlocks.
		index("idx_pending_signups_did").on(table.atprotoDid),
		index("idx_pending_signups_expires").on(table.expiresAt),
	],
);

// both — a follow is a relationship between two accounts. 41.02 names "Subscriber
// relationships" as both: the billing contract is org-side, the canonical assertion is
// in the user's repo. The row's *existence* is node (a creator's followers are their
// own), but the org's feed/index reads it, so both roles touch it.
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
// node — a block is a personal boundary between two accounts (the doc comment above
// is explicit: it lives here beside `follows` and *not* in moderation, because it is a
// relationship primitive, not an operator judgment). Both ends are node-owned; the org
// enforces it symmetrically but does not own it.
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
