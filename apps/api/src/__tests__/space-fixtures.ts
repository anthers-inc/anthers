// SPDX-License-Identifier: Apache-2.0
/**
 * The shared setup for the space suites: an account, a fake PDS, a Work, and a created space.
 *
 * ⚠️ **One definition, because two suites describe the same world.** The outbox, the projection
 * and the backup all hang off the same four things, and a second copy that drifted (a
 * different policy, an unverified registry row) would make one suite pass on a world the other
 * could not produce.
 */
import type { LibraryItemState } from "../services/space-records.js";
import { ensureUserSpace } from "../services/space-registry.js";
import type { ResolveSpaceSession } from "../services/space-writer.js";
import { createAccount } from "./account-fixture.js";
import { FakeSpacePds } from "./space-fake.js";
import { insertWork } from "./work-fixtures.js";

export interface SpaceContext {
	pds: FakeSpacePds;
	userId: number;
	did: string;
	spaceUri: string;
	workId: number;
	resolveSession: ResolveSpaceSession;
	session: { did: string; pdsUrl: string; token: string };
}

let counter = 0;

/** An account, a fake PDS, a Work to save, and the account's space already created. */
export async function spaceContext(): Promise<SpaceContext> {
	counter += 1;
	const account = await createAccount(`spaces-${counter}`);
	const pds = new FakeSpacePds();
	pds.sessionDid = account.did;
	const session = { did: account.did, pdsUrl: "http://fake.pds", token: "token" };
	const resolveSession: ResolveSpaceSession = async (userId) =>
		userId === account.userId ? { session } : { session: null, reason: "not_hosted" };
	const work = await insertWork({ creatorId: account.userId, type: "text", title: "Nightjar" });

	const ensured = await ensureUserSpace(account.userId, {
		resolveSession,
		fetchImpl: pds.fetch,
	});
	if (!ensured.space) throw new Error(`space was not created: ${ensured.reason}`);

	return {
		pds,
		userId: account.userId,
		did: account.did,
		spaceUri: ensured.space.spaceUri,
		workId: work.id,
		resolveSession,
		session,
	};
}

/** One Library entry, with the fields a test does not care about filled in. */
export function libraryEntry(
	workId: number,
	overrides: Partial<LibraryItemState> = {},
): LibraryItemState {
	return {
		subject: { kind: "work", id: workId, uri: null },
		hidden: false,
		sortOrder: 1,
		savedAt: new Date("2026-10-23T12:00:00.000Z"),
		...overrides,
	};
}
