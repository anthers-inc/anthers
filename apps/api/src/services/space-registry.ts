// SPDX-License-Identifier: Apache-2.0
/**
 * The registry: where each account's space is, and how it is found again after a corruption,
 * a move, or a space somebody deleted.
 *
 * 🚨 **The PDS is the source and this table is the cache.** `listSpaces` answers which spaces
 * an owner has — including one that was just created and holds nothing — and `listMembers`
 * answers a membership. Both are read during reconciliation and the row is repaired from
 * them, which is why a wrong `spaceUri` here costs a lookup rather than the space. Deleting a
 * space (scenario 06) leaves the row with `verifiedAt` null and a named reason, never a row
 * that has quietly forgotten the address.
 *
 * ⚠️ **Creating a space happens at the first write, not at signup.** Signup is the other
 * place it could happen and it is the wrong one for the same reason a record write is a job:
 * a person finishing a signup must not fail because a second server would not create a space.
 * The outbox's worker calls {@link ensureUserSpace} before its first write, so the space
 * exists exactly for the accounts that write something.
 */
import { db } from "@anthers/db";
import {
	type SpaceMemberSnapshot,
	USER_SPACE_SKEY,
	USER_SPACE_TYPE,
	userSpaces,
	works,
} from "@anthers/db/schema";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { isUnsupportedSpaceServer, type SpacePolicy, SpaceRequestError } from "./atproto-space.js";
import { CREATOR_SPACE_TYPE } from "./creator-space-records.js";
import {
	hostedSpaceSession,
	type ResolveSpaceSession,
	type SpaceSession,
	spaceClientFor,
} from "./space-writer.js";

/** A row as callers see it: the address and what was last true about it. */
export interface RegisteredSpace {
	userId: number;
	did: string;
	spaceType: string;
	spaceUri: string;
	readPolicy: Record<string, unknown>;
	writePolicy: Record<string, unknown>;
	appAccess: Record<string, unknown>;
	members: SpaceMemberSnapshot[];
	verifiedAt: Date | null;
	lastCheckedAt: Date | null;
	lastError: string | null;
}

/**
 * The address of an account's own space.
 *
 * `at://did/space/type/key` is the branch's `space-ref` format, and `self` is the key because
 * an account has one space of this type rather than a set of them.
 */
export function userSpaceUri(did: string): string {
	return `at://${did}/space/${USER_SPACE_TYPE}/${USER_SPACE_SKEY}`;
}

/** The parts of a space address: `at://<owner did>/space/<type>/<key>`. */
export interface SpaceAddress {
	did: string;
	spaceType: string;
	skey: string;
}

/**
 * Split a space URI into the four things every caller needs from it.
 *
 * ⚠️ **The key is read from the URI rather than assumed.** A storage prefix that hardcodes
 * `self` puts a creator's gated space on top of their Library's captures, which is exactly the
 * collision the backup format's `{did}/{type}/{skey}` shape exists to prevent.
 */
export function parseSpaceAddress(spaceUri: string): SpaceAddress | null {
	if (!spaceUri.startsWith("at://")) return null;
	const [did, kind, spaceType, skey, ...extra] = spaceUri.slice("at://".length).split("/");
	if (!did || kind !== "space" || !spaceType || !skey || extra.length > 0) return null;
	return { did, spaceType, skey };
}

/** The key in a space URI, which is the last segment of a well-formed address. */
export function spaceSkey(spaceUri: string): string {
	return parseSpaceAddress(spaceUri)?.skey ?? (spaceUri.split("/").at(-1) || "self");
}

/**
 * One space an account owns, as an address: enough to capture, export or move it.
 *
 * ⚠️ **The registry row's cached policy is deliberately absent.** A capture reads the policy
 * and the member list from the server, because the row is a cache and a backup has to be of
 * what the server holds now.
 */
export interface OwnedSpace {
	did: string;
	spaceUri: string;
	spaceType: string;
}

/**
 * The policies a user space is created with.
 *
 * ⭐ **Member-list read and write, open app access.** The reader's own state is not public:
 * only the owner and the members the design adds later may read it. App access stays open
 * until the app perimeter lands, which is the documented staging state rather than the end
 * state; a closing of it is a policy change on the space, not a new space.
 */
export const USER_SPACE_POLICIES = {
	readPolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" } as SpacePolicy,
	writePolicy: { $type: "com.atproto.simplespace.defs#memberListPolicy" } as SpacePolicy,
	appAccess: { $type: "com.atproto.simplespace.defs#open" } as const,
};

export type EnsureSpaceResult =
	| { space: RegisteredSpace; created: boolean }
	| { space: null; reason: string };

export interface RegistryOptions {
	/** Defaults to the hosted route. Tests inject a session over a fake PDS. */
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
	now?: Date;
}

/**
 * The account's space, creating it if this is the first write.
 *
 * A row that has been verified is returned without a call, because the read-back is the
 * verification that matters on every write. A row that has NOT been verified is looked up
 * against `listSpaces` before anything is created, so a crash between `createSpace` and the
 * insert adopts the existing space instead of failing on `SpaceAlreadyExists` forever.
 */
export async function ensureUserSpace(
	userId: number,
	opts: RegistryOptions = {},
): Promise<EnsureSpaceResult> {
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const [row] = await db.select().from(userSpaces).where(eq(userSpaces.userId, userId)).limit(1);

	if (row?.verifiedAt) return { space: toRegistered(row), created: false };

	const resolved = await resolve(userId);
	if (!resolved.session) return { space: null, reason: resolved.reason };
	const session = resolved.session;

	if (row) {
		// An unverified row: ask the PDS rather than creating a second space.
		const found = await spaceOnPds(session, opts);
		if (found)
			return { space: await recordSpace(userId, row.id, session, found, opts), created: false };
	}

	const created = await createOnPds(session, opts);
	if (!created) {
		// The create answered "already exists" (or a lookup found it): adopt what is there.
		const found = await spaceOnPds(session, opts);
		if (!found) return { space: null, reason: "space_unavailable" };
		return { space: await recordSpace(userId, row?.id, session, found, opts), created: false };
	}
	if (!created.spaceUri) return { space: null, reason: "space_unavailable" };
	return {
		space: await recordSpace(userId, row?.id, session, created, opts),
		created: true,
	};
}

/**
 * Reconcile one account's row against the PDS.
 *
 * A corrupted address is repaired from `listSpaces`, and a space that is genuinely gone is
 * recorded as missing rather than deleted: the address is what a restore starts from.
 */
export async function reconcileUserSpace(
	userId: number,
	opts: RegistryOptions = {},
): Promise<EnsureSpaceResult> {
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const [row] = await db.select().from(userSpaces).where(eq(userSpaces.userId, userId)).limit(1);
	if (!row) return { space: null, reason: "no_registry_row" };

	const resolved = await resolve(userId);
	if (!resolved.session) {
		await markChecked(row.id, resolved.reason, opts.now);
		return { space: null, reason: resolved.reason };
	}

	const found = await spaceOnPds(resolved.session, opts);
	if (!found) {
		await db
			.update(userSpaces)
			.set({
				verifiedAt: null,
				lastCheckedAt: opts.now ?? new Date(),
				lastError: "space missing on the PDS",
				updatedAt: opts.now ?? new Date(),
			})
			.where(eq(userSpaces.id, row.id));
		return { space: null, reason: "space_missing" };
	}

	const repaired =
		row.spaceUri !== found.uri ? "address repaired from listSpaces" : (row.lastError ?? null);
	return {
		space: await recordSpace(userId, row.id, resolved.session, found, opts, repaired),
		created: false,
	};
}

/**
 * Reconcile a page of rows, for the sweep.
 *
 * Deliberately sequential: the worker's concurrency is the unit that matters and a sweep that
 * fanned out over a whole table would spend the PDS's login budget to learn very little.
 */
export async function reconcileUserSpaces(
	opts: RegistryOptions & { limit?: number } = {},
): Promise<{ checked: number; repaired: number; missing: number; failed: number }> {
	const rows = await db
		.select({ userId: userSpaces.userId, spaceUri: userSpaces.spaceUri })
		.from(userSpaces)
		.limit(opts.limit ?? 100);

	let repaired = 0;
	let missing = 0;
	let failed = 0;
	for (const row of rows) {
		const result = await reconcileUserSpace(row.userId, opts);
		if (result.space) {
			if (result.space.spaceUri !== row.spaceUri) repaired++;
		} else if (result.reason === "space_missing") missing++;
		else failed++;
	}
	return { checked: rows.length, repaired, missing, failed };
}

/** What the PDS says an owner has, narrowed to the space this registry tracks. */
interface FoundSpace {
	uri: string;
	readPolicy: SpacePolicy;
	writePolicy: SpacePolicy;
	appAccess: Record<string, unknown>;
	members: SpaceMemberSnapshot[];
}

/**
 * Look the account's space up by owner and type.
 *
 * ⚠️ **`listSpaces` is filtered by the type and then the address is matched by its key.** The
 * listing carries only the URI today, so a space of another type under the same owner is not
 * this one; matching on the type in the path keeps the registry from adopting a creator space
 * as the reader's Library.
 */
async function spaceOnPds(
	session: SpaceSession,
	opts: RegistryOptions,
): Promise<FoundSpace | null> {
	const client = spaceClientFor(session, { fetchImpl: opts.fetchImpl });
	const listed = await client.listSpaces({ did: session.did, spaceType: USER_SPACE_TYPE });
	const match = listed.spaces.find((space) => {
		const uri = space.uri;
		return uri.startsWith(`at://${session.did}/space/${USER_SPACE_TYPE}/`);
	});
	if (!match) return null;

	const description = await client.getSpace(match.uri);
	const memberList = await client.listMembers(match.uri).catch(() => ({ members: [] }));
	return {
		uri: description.uri,
		readPolicy: description.readPolicy,
		writePolicy: description.writePolicy,
		appAccess: description.appAccess as unknown as Record<string, unknown>,
		members: memberList.members.map((member) => ({
			did: member.did,
			read: member.read,
			write: member.write,
		})),
	};
}

/** Create the space; null when the PDS refuses because it already exists. */
async function createOnPds(
	session: SpaceSession,
	opts: RegistryOptions,
): Promise<{ spaceUri: string } | null> {
	const client = spaceClientFor(session, { fetchImpl: opts.fetchImpl });
	try {
		const created = await client.createSpace({
			spaceType: USER_SPACE_TYPE,
			skey: USER_SPACE_SKEY,
			...USER_SPACE_POLICIES,
		});
		return { spaceUri: created.uri };
	} catch (error) {
		if (error instanceof SpaceRequestError && error.error === "SpaceAlreadyExists") return null;
		throw error;
	}
}

/**
 * Insert or update the row from what the PDS answered.
 *
 * The insert is what survives a race between two workers creating the same space: the unique
 * index on `(user_id, space_type)` means the loser's insert conflicts and its update applies,
 * and both end holding the same address.
 */
async function recordSpace(
	userId: number,
	id: number | undefined,
	session: SpaceSession,
	found: FoundSpace | { spaceUri: string },
	opts: RegistryOptions,
	lastError: string | null = null,
): Promise<RegisteredSpace> {
	const now = opts.now ?? new Date();
	const address = "spaceUri" in found ? found.spaceUri : found.uri;

	let description: FoundSpace;
	if ("spaceUri" in found) {
		// Freshly created: read the policies back, because the row's copy is what a restore uses.
		const client = spaceClientFor(session, { fetchImpl: opts.fetchImpl });
		const read = await client.getSpace(address);
		const members = await client.listMembers(address).catch(() => ({ members: [] }));
		description = {
			uri: read.uri,
			readPolicy: read.readPolicy,
			writePolicy: read.writePolicy,
			appAccess: read.appAccess as unknown as Record<string, unknown>,
			members: members.members.map((member) => ({
				did: member.did,
				read: member.read,
				write: member.write,
			})),
		};
	} else {
		description = found;
	}

	const values = {
		did: session.did,
		spaceType: USER_SPACE_TYPE,
		spaceUri: description.uri,
		readPolicy: description.readPolicy as unknown as Record<string, unknown>,
		writePolicy: description.writePolicy as unknown as Record<string, unknown>,
		appAccess: description.appAccess,
		members: description.members,
		verifiedAt: now,
		lastCheckedAt: now,
		lastError,
		updatedAt: now,
	};

	const [row] = id
		? await db.update(userSpaces).set(values).where(eq(userSpaces.id, id)).returning()
		: await db
				.insert(userSpaces)
				.values({ userId, ...values })
				.onConflictDoUpdate({
					target: [userSpaces.userId, userSpaces.spaceType],
					set: values,
				})
				.returning();

	return toRegistered(row);
}

async function markChecked(id: number, reason: string, now?: Date): Promise<void> {
	await db
		.update(userSpaces)
		.set({ lastCheckedAt: now ?? new Date(), lastError: reason, updatedAt: now ?? new Date() })
		.where(eq(userSpaces.id, id));
}

function toRegistered(row: typeof userSpaces.$inferSelect): RegisteredSpace {
	return {
		userId: row.userId,
		did: row.did,
		spaceType: row.spaceType,
		spaceUri: row.spaceUri,
		readPolicy: row.readPolicy,
		writePolicy: row.writePolicy,
		appAccess: row.appAccess,
		members: row.members,
		verifiedAt: row.verifiedAt,
		lastCheckedAt: row.lastCheckedAt,
		lastError: row.lastError,
	};
}

/** Whether a space is one of this account's own, by address. */
export function ownsSpace(did: string, spaceUri: string): boolean {
	return spaceUri === userSpaceUri(did);
}

/** Every space this account owns, for an export or a capture that covers all of them. */
export async function registeredSpacesFor(userId: number): Promise<RegisteredSpace[]> {
	const rows = await db.select().from(userSpaces).where(eq(userSpaces.userId, userId));
	return rows.map(toRegistered);
}

export interface SpaceEnumerationOptions extends RegistryOptions {
	/** A session the caller already resolved, so enumerating does not resolve it twice. */
	session?: SpaceSession;
}

/**
 * Every space an account owns: its Library, its studio, and each gated Work's space.
 *
 * ⭐ **The PDS's `listSpaces` is the address of record for creator spaces.** `works.draft_uri`,
 * `gated_space_uri` and `manifest_uri` are pointers to records *inside* those spaces, written
 * after the record is verified; they are not the enumeration source. Asking the server is what
 * picks up a studio whose Work rows are gone, a gated space whose pointer a failed write never
 * stored, and an empty space that was created and holds nothing yet — and it is what keeps a
 * deleted space out, rather than leaving a row for the nightly sweep to fail against forever.
 * The 71.05 rule already says this: the registry is an index, and `listSpaces` rebuilds it.
 *
 * Registered rows come first, so a caller that wants "the Library" keeps finding it there. The
 * creator spaces follow, sorted by address so a capture's output does not reorder itself.
 */
export async function ownedSpacesFor(
	userId: number,
	opts: SpaceEnumerationOptions = {},
): Promise<OwnedSpace[]> {
	const registered = await registeredSpacesFor(userId);
	const owned = new Map<string, OwnedSpace>(
		registered.map((row) => [
			row.spaceUri,
			{ did: row.did, spaceUri: row.spaceUri, spaceType: row.spaceType },
		]),
	);

	let session = opts.session;
	if (!session) {
		const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
		session = (await resolve(userId)).session ?? undefined;
	}
	if (!session) return [...owned.values()];

	const client = spaceClientFor(session, { fetchImpl: opts.fetchImpl });
	let listed: Array<{ uri: string }> = [];
	try {
		listed = (await client.listSpaces({ did: session.did, spaceType: CREATOR_SPACE_TYPE })).spaces;
	} catch (error) {
		// A server with no space endpoints has no creator spaces either; anything else is real.
		if (!isUnsupportedSpaceServer(error)) throw error;
	}

	const creatorSpaces: OwnedSpace[] = [];
	for (const space of listed) {
		const address = parseSpaceAddress(space.uri);
		if (!address || owned.has(space.uri)) continue;
		creatorSpaces.push({ did: address.did, spaceUri: space.uri, spaceType: address.spaceType });
	}
	creatorSpaces.sort((a, b) => a.spaceUri.localeCompare(b.spaceUri));

	return [...owned.values(), ...creatorSpaces];
}

/**
 * The accounts the nightly sweep should ask about, in id order.
 *
 * ⚠️ **The two sources are deliberately different questions.** A registry row is a space this
 * deployment knows it created; a Work with a draft or gated address is a creator whose space
 * the Studio has written into. Neither alone reaches every owner — a creator who never saved
 * anything has no registry row, and a reader who saved but published nothing has no Work. The
 * union is the smallest set that can hold an owned space, and `ownedSpacesFor` decides which
 * spaces each account actually has.
 */
export async function accountsOwningSpaces(limit = 100): Promise<number[]> {
	const [registered, creators] = await Promise.all([
		db.selectDistinct({ userId: userSpaces.userId }).from(userSpaces).limit(limit),
		db
			.selectDistinct({ userId: works.creatorId })
			.from(works)
			.where(
				and(
					isNotNull(works.creatorId),
					or(isNotNull(works.draftUri), isNotNull(works.gatedSpaceUri)),
				),
			)
			.limit(limit),
	]);
	const ids = new Set<number>();
	for (const row of [...registered, ...creators]) {
		if (row.userId !== null) ids.add(row.userId);
	}
	return [...ids].sort((a, b) => a - b).slice(0, limit);
}

/** One account's row, without a network call. */
export async function registeredSpace(userId: number): Promise<RegisteredSpace | null> {
	const [row] = await db.select().from(userSpaces).where(eq(userSpaces.userId, userId)).limit(1);
	return row ? toRegistered(row) : null;
}
