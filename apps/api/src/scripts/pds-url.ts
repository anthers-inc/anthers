// SPDX-License-Identifier: Apache-2.0
/**
 * Bring a user row's stored identity-server address in line with the directory.
 *
 * 🚨 **`users.atproto_pds_url` is a copy of a fact the PLC directory owns, and copies drift.** An
 * identity moved onto `anthers.social` before `hosted:record` wrote this column left its row
 * pointing at the server it came from, and nothing complained: the Settings card named Bluesky's
 * host as "the server Anthers runs", the export asked the wrong server for the repository, and the
 * drift check compared a listing against a machine that never held it.
 *
 * ⭐ **So this reads the answer rather than being handed it.** The directory is the authority on
 * where an identity lives, and a tool that took the new address as an argument would let an
 * operator paste the same wrong value it is meant to fix. One account at a time, by id.
 *
 *   bun run hosted:pds-url 39         # show what the row says and what the directory says
 *   bun run hosted:pds-url 39 --yes   # write the directory's answer
 *
 * In production, use the wrapper Make target:
 *   make prod-db CMD="bun run hosted:pds-url 39 --yes"
 */
import { db } from "@anthers/db";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

const TAG = "[pds-url]";

const USAGE = `usage:
  bun run hosted:pds-url <user-id> [--yes]`;

function fail(message: string): never {
	console.error(`${TAG} ${message}`);
	process.exit(1);
}

/**
 * The server a DID's document names, from `plc.directory`.
 *
 * ⚠️ A `did:web` identity resolves through its own host rather than the PLC directory, and this
 * refuses rather than guessing a URL shape for one.
 */
async function serviceOf(did: string): Promise<string> {
	if (!did.startsWith("did:plc:")) fail(`${did} is not a did:plc, so its directory is not here`);
	const res = await fetch(`https://plc.directory/${encodeURIComponent(did)}`);
	if (!res.ok) fail(`the directory answered ${res.status} for ${did}`);
	const doc = (await res.json()) as { service?: { id?: string; serviceEndpoint?: string }[] };
	const pds = doc.service?.find((s) => s.id === "#atproto_pds" || s.id?.endsWith("#atproto_pds"));
	const endpoint = pds?.serviceEndpoint?.trim();
	if (!endpoint) fail(`${did}'s document names no atproto_pds service`);
	return endpoint.replace(/\/+$/, "");
}

async function main(): Promise<void> {
	const [rawId, ...rest] = process.argv.slice(2);
	if (!rawId || rawId === "--help" || rawId === "-h") {
		console.log(USAGE);
		if (!rawId) process.exit(1);
		return;
	}
	const userId = Number(rawId);
	if (!Number.isInteger(userId)) fail(`"${rawId}" is not a user id`);

	const [row] = await db
		.select({ did: users.atprotoDid, handle: users.atprotoHandle, pds: users.atprotoPdsUrl })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!row) fail(`no user ${userId}`);
	if (!row.did) fail(`user ${userId} holds no identity`);

	const onDirectory = await serviceOf(row.did);
	const stored = (row.pds ?? "").replace(/\/+$/, "");

	console.log(`${TAG} user ${userId}${row.handle ? ` (@${row.handle})` : ""} — ${row.did}`);
	console.log(`  on file:    ${stored || "(nothing)"}`);
	console.log(`  directory:  ${onDirectory}`);

	if (stored === onDirectory) {
		console.log(`${TAG} they agree. Nothing to do.`);
		return;
	}

	if (!rest.includes("--yes")) {
		console.log(`${TAG} pass --yes to write the directory's answer.`);
		process.exit(3);
	}

	await db.update(users).set({ atprotoPdsUrl: onDirectory }).where(eq(users.id, userId));
	const [after] = await db
		.select({ pds: users.atprotoPdsUrl })
		.from(users)
		.where(eq(users.id, userId));
	if ((after?.pds ?? "") !== onDirectory) fail("the write did not take — nothing was changed");
	console.log(`${TAG} wrote ${onDirectory}.`);
}

main()
	.catch((err) => {
		console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
