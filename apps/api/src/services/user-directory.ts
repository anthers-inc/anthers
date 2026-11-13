// SPDX-License-Identifier: Apache-2.0
/**
 * The users directory: every Anthers account, searchable and paged, for the admin app.
 *
 * This is the one place an operator browses accounts as people. `moderation.ts`'s
 * {@link loadPeople} deliberately is not a directory — it answers suspended-or-reported
 * accounts and a named search — because browsing a user list under a moderation header
 * invites acting on somebody nobody complained about. The two surfaces answer different
 * questions, and keeping them separate is what lets each one hold its own line.
 *
 * **Read-only.** Nothing here is a decision: suspension and deletion state are read from
 * the `users` row, and the actions that change them live on the person's detail
 * (`/moderation/people/:id`), where the policy is stated beside the button.
 *
 * ⚠️ **A page is newest first and its size is the server's.** The page size is fixed here
 * rather than taken from the query so an operator's page cannot ask the database for the
 * whole table, and the count is returned with every page so the view can say what it is
 * showing without a second request.
 */
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { desc, ilike, or, sql } from "drizzle-orm";
import { isCreatorWhere } from "./creator-standing.js";

/** How many accounts one page of the directory holds. */
export const USER_DIRECTORY_PAGE_SIZE = 50;

/** One account as the directory table reads it. */
export interface UserDirectoryRow {
	id: number;
	handle: string;
	displayName: string;
	email: string;
	emailVerified: boolean;
	/** The self-serve switch — what interface the person is owed, not creator standing. */
	creatorMode: boolean;
	/** Creator standing: the switch is on and payout setup is complete. */
	isCreator: boolean;
	suspendedAt: string | null;
	suspendedUntil: string | null;
	deletionRequestedAt: string | null;
	createdAt: string;
}

export interface UserDirectoryPage {
	users: UserDirectoryRow[];
	/** 0-based, so the first page is `0` — the page the view starts on. */
	page: number;
	pageSize: number;
	total: number;
	hasMore: boolean;
}

/**
 * One page of accounts matching `query`, newest first.
 *
 * The search matches a handle, a display name or an email address as a substring, and an
 * account number exactly — the four things an operator holds when the question is "who
 * is this?". A leading `@` on a handle is dropped, because that is how every surface
 * writes one and a pasted handle should not need editing.
 */
export async function loadUserDirectory(input: {
	query?: string;
	page?: number;
}): Promise<UserDirectoryPage> {
	const requested = input.page ?? 0;
	const page = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
	const named = (input.query ?? "").trim().replace(/^@/, "");
	const search = named
		? or(
				ilike(users.atprotoHandle, `%${named}%`),
				ilike(users.displayName, `%${named}%`),
				ilike(users.email, `%${named}%`),
				sql`${users.id}::text = ${named}`,
			)
		: undefined;

	const [rows, [counted]] = await Promise.all([
		db
			.select({
				id: users.id,
				handle: users.atprotoHandle,
				displayName: users.displayName,
				email: users.email,
				emailVerified: users.emailVerified,
				creatorMode: users.creatorMode,
				isCreator: isCreatorWhere(users.id),
				suspendedAt: users.suspendedAt,
				suspendedUntil: users.suspendedUntil,
				deletionRequestedAt: users.deletionRequestedAt,
				createdAt: users.createdAt,
			})
			.from(users)
			.where(search)
			.orderBy(desc(users.createdAt), desc(users.id))
			.limit(USER_DIRECTORY_PAGE_SIZE)
			.offset(page * USER_DIRECTORY_PAGE_SIZE),
		db.select({ total: sql<number>`count(*)::int` }).from(users).where(search),
	]);

	const total = Number(counted?.total ?? 0);

	return {
		users: rows.map((row) => ({
			...row,
			// `.default(...)` columns read nullable through Drizzle; the defaults are real,
			// so a null here is the column's default arriving unwritten.
			displayName: row.displayName ?? "",
			emailVerified: row.emailVerified === true,
			creatorMode: row.creatorMode === true,
			isCreator: Boolean(row.isCreator),
			suspendedAt: row.suspendedAt?.toISOString() ?? null,
			suspendedUntil: row.suspendedUntil?.toISOString() ?? null,
			deletionRequestedAt: row.deletionRequestedAt?.toISOString() ?? null,
			createdAt: row.createdAt.toISOString(),
		})),
		page,
		pageSize: USER_DIRECTORY_PAGE_SIZE,
		total,
		// Compared against the count rather than inferred from a full page, so the last
		// exactly-full page does not offer a Next that lands on nothing.
		hasMore: (page + 1) * USER_DIRECTORY_PAGE_SIZE < total,
	};
}
