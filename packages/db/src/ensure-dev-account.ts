// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dev bootstrap account — ensures a personal login exists in the local dev DB.
 *
 * Runs automatically at the top of `make dev` (after the DB is up + migrated).
 * Its purpose is credential parity: create a local account using the SAME
 * username/email/password you use on prod, so wiping the dev DB never costs you
 * the ability to log in with your usual combo. Create-if-missing and idempotent
 * — an existing account (matched by username or email) is left untouched.
 *
 * Credentials come from the environment (Bun auto-loads .env, which is
 * gitignored) so nothing sensitive is ever committed:
 *
 *   DEV_ACCOUNT_USERNAME   your prod username
 *   DEV_ACCOUNT_EMAIL      your prod email
 *   DEV_ACCOUNT_PASSWORD   your prod password
 *   DEV_ACCOUNT_CREATOR    optional, "true"/"false" (default true)
 *   DEV_ACCOUNT_ADMIN      optional, "true"/"false" (default false) — ops console
 *
 * If any of the three required vars are unset, this is a silent no-op so a fresh
 * clone without them configured still runs `make dev` cleanly. It also never
 * fails the build: any unexpected error is logged as a warning and swallowed so
 * the dev servers still start.
 *
 * Usage:
 *   bun run db:dev-account     # invoked by `make dev`; safe to run by hand too
 */

import { eq, or } from "drizzle-orm";
import { db, users } from "./index.js";

const TAG = "[dev-account]";

async function main() {
	const username = process.env.DEV_ACCOUNT_USERNAME?.trim();
	const email = process.env.DEV_ACCOUNT_EMAIL?.trim();
	const password = process.env.DEV_ACCOUNT_PASSWORD;
	// Default the bootstrap account to a creator so it can exercise creator
	// tooling; set DEV_ACCOUNT_CREATOR=false for a plain consumer account.
	const isCreator = (process.env.DEV_ACCOUNT_CREATOR ?? "true").toLowerCase() !== "false";
	// Admin (the ops console) is opt-in — off unless you set DEV_ACCOUNT_ADMIN=true.
	const isAdmin = (process.env.DEV_ACCOUNT_ADMIN ?? "false").toLowerCase() === "true";

	if (!username || !email || !password) {
		console.log(
			`${TAG} DEV_ACCOUNT_{USERNAME,EMAIL,PASSWORD} not all set — skipping (add them to .env to enable).`,
		);
		return;
	}

	// Already there (by username or email)? Leave it exactly as-is.
	const existing = await db
		.select({ id: users.id, username: users.username })
		.from(users)
		.where(or(eq(users.username, username), eq(users.email, email)))
		.limit(1);

	if (existing.length > 0) {
		console.log(`${TAG} "${existing[0].username}" already exists — skipping.`);
		return;
	}

	const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" });

	await db.insert(users).values({
		username,
		email,
		passwordHash,
		displayName: username,
		isCreator,
		isAdmin,
		emailVerified: true, // skip the verification wall for a login you actually use
	});

	console.log(
		`${TAG} created "${username}" (${email}) — email pre-verified, creator=${isCreator}, admin=${isAdmin}.`,
	);
}

try {
	await main();
} catch (err) {
	// A convenience account must never block the dev environment from starting.
	console.warn(`${TAG} WARNING: could not ensure dev account (continuing):`, err);
}
process.exit(0);
