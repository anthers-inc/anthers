// SPDX-License-Identifier: Apache-2.0
/**
 * Erase one account out of band, through the same service the daily sweep calls.
 *
 * Erasure normally arrives from the person themselves: `requestDeletion` sets `deletion_requested_at`,
 * a grace period passes, and the sweep calls `eraseAccount`. This is the other door — for an account
 * nobody will sign in as again and nobody is owed a grace period, such as a pre-launch test account
 * that has to be gone before a server is crawled. It exists so that work does not become a hand-written
 * `delete` that skips the media purge, the Works classification, the hosted-identity release and the
 * ATProto grant revocation that make an erasure honest.
 *
 * 🚨 **It prints what it is about to destroy and refuses without `--yes`.** Nothing here is reversible
 * once it runs, and the counts are the decision: two Works destroyed and one withdrawn are different
 * outcomes that a single "delete this user" hides.
 *
 * ⚠️ **The hosted identity is emptied and deactivated, not deleted from the node.** That is the promise
 * `releaseHostedIdentities` makes for a person's own identity. An account being retired because it must
 * not exist at all — a test account ahead of a crawl — needs the node's admin door as well, which is a
 * separate act with a different reason.
 *
 * Usage:
 *   bun run account:erase --user 37          # preview, writes nothing
 *   bun run account:erase --user 37 --yes    # erase
 *
 * In production, use the wrapper Make target, which injects `DATABASE_URL` without the
 * connection string appearing on a command line:
 *   make prod-db CMD="bun run account:erase --user 37"
 */
import { client, db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { deletionPreview, eraseAccount } from "../services/account-deletion.js";

const USAGE = `usage:
  bun run account:erase --user <id> [--yes]`;

function fail(message: string): never {
	console.error(`[account:erase] ${message}`);
	process.exit(1);
}

let userId: number | null = null;
let yes = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--user") userId = Number(argv[++i]);
	else if (argv[i] === "--yes") yes = true;
	else if (argv[i] === "--help" || argv[i] === "-h") {
		console.log(USAGE);
		process.exit(0);
	} else fail(`unknown argument ${argv[i]}`);
}
if (!userId || !Number.isInteger(userId)) fail(USAGE);

const [user] = await db
	.select({
		id: users.id,
		email: users.email,
		handle: users.atprotoHandle,
		did: users.atprotoDid,
		deletionRequestedAt: users.deletionRequestedAt,
	})
	.from(users)
	.where(eq(users.id, userId))
	.limit(1);
if (!user) fail(`no user ${userId}`);

console.log(
	`user ${user.id}: ${user.email}  ${user.handle}  ${user.did}` +
		(user.deletionRequestedAt ? `  (deletion requested ${user.deletionRequestedAt.toISOString()})` : ""),
);

const preview = await deletionPreview(userId);
console.log(JSON.stringify(preview, null, 1));

if (!yes) {
	console.log("\nNothing erased. Re-run with --yes to erase this account.");
	await client.end();
	process.exit(3);
}

const result = await eraseAccount(userId);
console.log(JSON.stringify(result));
await client.end();
if (!result.erased) process.exit(1);
