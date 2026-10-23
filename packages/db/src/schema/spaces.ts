// SPDX-License-Identifier: Apache-2.0
/**
 * The two tables the user-space write path needs: the registry and the outbox.
 *
 * 🚨 **Neither table is the canonical copy of anything.** A user's space is the canonical
 * home of what the reader kept and how far they got; these tables are the map that finds the
 * space and the queue that carries a write to it. That inversion is the whole point of
 * *A Canonical Data Model for Spaces*, and it is what makes the export structural rather
 * than a feature somebody remembers to offer.
 *
 * ⚠️ **The outbox clears on a verified read-back, never on a successful request.** A 200
 * from `putRecord` is a statement that the server accepted the call, not that the record is
 * in the repo at the address and CID the caller was told. The worker reads the record back,
 * compares it to what it sent, and checks the commit and the oplog before it deletes a row.
 * A row that cannot be verified stays, and that is why this is a table rather than a retry
 * loop inside a request handler.
 */
import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/** The space type every account's own space carries. */
export const USER_SPACE_TYPE = "org.anthers.userSpace";

/** One member as the registry keeps it, in the protocol's two flags. */
export interface SpaceMemberSnapshot {
	did: string;
	read: boolean;
	write: boolean;
}

/**
 * The key inside a space URI. One space of a type per owner, so the key says which one
 * rather than naming a thing: `at://did:plc:…/space/org.anthers.userSpace/self`.
 */
export const USER_SPACE_SKEY = "self";

/**
 * Where each account's space lives, and what the PDS last said about it.
 *
 * ⭐ **The registry is derived, and its two sources are the PDS's own lists.** `listSpaces`
 * answers which spaces an owner has, empty ones included; `listMembers` answers a membership
 * for a space somebody else owns. This table caches the first and is repaired from it, which
 * is why a corrupted row is a repair rather than a loss: the space is still there, and the
 * reconciliation reads its address back.
 *
 * ⚠️ **`did` is stored beside `user_id` deliberately.** The space belongs to the DID, not to
 * the account row: a hosted identity can move to another PDS and the space moves with the
 * identity, while the account row is deleted, recreated or renamed around it. Keying only on
 * `user_id` would lose the thread across exactly the events the registry exists for.
 */
// org — the map from an account on this deployment to the space under its DID. It is
// service state rather than the reader's record: the space holds the record, and this row is
// what lets the service find it again after a move or a corrupted address.
export const userSpaces = pgTable(
	"user_spaces",
	{
		id: serial("id").primaryKey(),
		// Cascade: the account's space is the account's own state, and an account deletion
		// takes the map with it. The space under the DID is a separate question, answered by
		// the deletion flow rather than by this foreign key.
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		did: text("did").notNull(),
		spaceType: text("space_type").notNull().default(USER_SPACE_TYPE),
		/** The full `at://did/space/type/skey` address, which every call takes. */
		spaceUri: text("space_uri").notNull(),
		/** The policies the space was created with, kept so a restore can recreate them. */
		readPolicy: jsonb("read_policy").$type<Record<string, unknown>>().notNull(),
		writePolicy: jsonb("write_policy").$type<Record<string, unknown>>().notNull(),
		appAccess: jsonb("app_access").$type<Record<string, unknown>>().notNull(),
		/**
		 * The member list as `listMembers` last returned it — the registry's second source.
		 *
		 * ⚠️ **A user space's list is normally empty, and that is correct rather than a
		 * failure**: the owner reads and writes their own space without appearing as a member.
		 * The column earns its place for the spaces where it is not empty (a gated Work's
		 * shared space) and because the backup has to restore a member list that the STAR
		 * does not carry.
		 */
		members: jsonb("members").$type<SpaceMemberSnapshot[]>().notNull().default([]),
		/** When `getSpace` last confirmed the address answered. Null until it has. */
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		/** Every reconciliation touches this, whether it found the space or not. */
		lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
		/**
		 * The last thing reconciliation said, for a person to read rather than a job. A
		 * missing space, a repaired address and an unreachable node all land here.
		 */
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One space of a type per account, and one row per address.
		uniqueIndex("uq_user_spaces_user_type").on(table.userId, table.spaceType),
		uniqueIndex("uq_user_spaces_uri").on(table.spaceUri),
		index("idx_user_spaces_did").on(table.did),
	],
);

/** What a queued row asks the worker to do. */
export type SpaceOutboxOp = "put" | "delete";

/** Where a row is in its life. Only `pending` rows are claimable. */
export type SpaceOutboxStatus = "pending" | "inflight" | "failed";

/**
 * One logical backup of one space.
 *
 * 🚨 **A row is a manifest, not the backup.** The objects live in private storage under the
 * keys this row names: the STAR, the record list, the registry snapshot and the blob bytes.
 * Keeping the manifest in Postgres is what makes retention a query and a restore a lookup
 * rather than somebody remembering which prefix belonged to which space.
 */
// org — the manifest of a backup this deployment took. The objects it names are private
// storage; the row is the index into them.
export const spaceBackups = pgTable(
	"space_backups",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		did: text("did").notNull(),
		spaceUri: text("space_uri").notNull(),
		/** When the capture ran, to the millisecond; it is also the storage folder's name. */
		capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
		/**
		 * `complete` when every artifact was written, `partial` when the registry and records
		 * were but a blob or the STAR was not, `failed` when the capture stopped.
		 */
		status: text("status").$type<"complete" | "partial" | "failed">().notNull().default("complete"),
		/** The space repo's commit revision at capture; null for a space with no write yet. */
		rev: text("rev"),
		/** The commit's LtHash digest, base64 as JSON carries it; the restore compares it. */
		commitData: text("commit_data"),
		/** The storage prefix every artifact of this capture sits under. */
		prefix: text("prefix").notNull(),
		starKey: text("star_key"),
		recordsKey: text("records_key").notNull(),
		registryKey: text("registry_key").notNull(),
		/** A sidecar naming each blob's content type and size, by CID. */
		blobsKey: text("blobs_key"),
		starBytes: integer("star_bytes").notNull().default(0),
		recordCount: integer("record_count").notNull().default(0),
		blobCount: integer("blob_count").notNull().default(0),
		blobBytes: bigint("blob_bytes", { mode: "number" }).notNull().default(0),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		// One capture per space per millisecond; the folder name is the same fact.
		uniqueIndex("uq_space_backups_capture").on(table.spaceUri, table.capturedAt),
		// The restore's lookup and the retention sweep both read by space and recency.
		index("idx_space_backups_space").on(table.spaceUri, table.capturedAt),
		index("idx_space_backups_status").on(table.status),
	],
);

/**
 * A write that is owed to a user's space.
 *
 * 🚨 **The row is the intent, and the record is the payload.** A `put` carries the complete
 * record, because every record this path writes is absolute state (a shelf entry's hidden
 * flag, a sort order) rather than an increment; a later write therefore replaces an earlier
 * one rather than stacking on it, and a `delete` supersedes whatever was queued for the same
 * key. That is what lets a retry write the same bytes and converge.
 *
 * ⚠️ **A unique index on `(user_id, collection, rkey)` covers only `pending` rows.** An
 * in-flight row is being read back against the payload it was claimed with, so a newer write
 * to the same key must queue beside it instead of rewriting the payload under the worker.
 * The next drain takes the newer row; the in-flight row clears on its own verification.
 */
// org — the writes this deployment owes to spaces it is responsible for. A creator node
// would hold its own outbox, which is why the queue is organization-side today: the spaces
// belong to accounts the organization hosts.
export const spaceOutbox = pgTable(
	"space_outbox",
	{
		id: serial("id").primaryKey(),
		userId: integer("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		did: text("did").notNull(),
		spaceUri: text("space_uri").notNull(),
		collection: text("collection").notNull(),
		rkey: text("rkey").notNull(),
		op: text("op").$type<SpaceOutboxOp>().notNull(),
		/** The record for a `put`; null for a `delete`. */
		record: jsonb("record").$type<Record<string, unknown>>(),
		status: text("status").$type<SpaceOutboxStatus>().notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		/** When the row is next eligible, after a failure's backoff. */
		availableAt: timestamp("available_at", { withTimezone: true }).defaultNow().notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		/** The last failure, in the worker's words, for whoever has to look. */
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex("uq_space_outbox_pending")
			.on(table.userId, table.collection, table.rkey)
			.where(sql`${table.status} = 'pending'`),
		// The drain's whole query: due pending rows, oldest first.
		index("idx_space_outbox_due").on(table.status, table.availableAt),
		index("idx_space_outbox_user").on(table.userId),
	],
);
