// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Grant or revoke platform-admin (the ops console) on an account, by username.
 *
 * Admin is a deliberate out-of-band flag — there is no self-serve path — so this
 * is how the first operator (and any later one) gets promoted. It runs against
 * whatever DATABASE_URL points at, so it works locally AND in production:
 *
 *   bun run db:admin <username>            # grant
 *   bun run db:admin <username> --revoke   # revoke
 *
 * In prod, point DATABASE_URL at the managed DB for the one command, e.g.:
 *   DATABASE_URL="$(doctl databases connection <id> --format URI --no-header)" \
 *     bun run db:admin <username>
 *
 * Idempotent: granting an already-admin account (or revoking a non-admin) just
 * reports the current state. Exits non-zero if the username doesn't exist.
 */

import { eq } from "drizzle-orm";
import { db, users } from "./index.js";

const TAG = "[set-admin]";

async function main() {
	const args = process.argv.slice(2);
	const revoke = args.includes("--revoke");
	const username = args.find((a) => !a.startsWith("--"))?.trim();

	if (!username) {
		console.error(`${TAG} usage: bun run db:admin <username> [--revoke]`);
		process.exit(2);
	}

	const [user] = await db
		.select({ id: users.id, username: users.username, isAdmin: users.isAdmin })
		.from(users)
		.where(eq(users.username, username))
		.limit(1);

	if (!user) {
		console.error(`${TAG} no account with username "${username}".`);
		process.exit(1);
	}

	const target = !revoke;
	if (Boolean(user.isAdmin) === target) {
		console.log(
			`${TAG} "${username}" is already ${target ? "an admin" : "not an admin"} — no change.`,
		);
		return;
	}

	await db.update(users).set({ isAdmin: target }).where(eq(users.id, user.id));
	console.log(
		`${TAG} ${target ? "granted" : "revoked"} admin ${target ? "to" : "from"} "${username}".`,
	);
}

try {
	await main();
} catch (err) {
	console.error(`${TAG} FAILED:`, err);
	process.exit(1);
}
process.exit(0);
