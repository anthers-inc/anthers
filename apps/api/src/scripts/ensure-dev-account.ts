// SPDX-License-Identifier: Apache-2.0
/**
 * Your dev account, created at the start of every `make dev` session as a real identity on the
 * session's AT Protocol network.
 *
 * Every session starts from an empty database (`scripts/session.ts`), so this creates rather than
 * reconciles: the account matching your production username and email, pre-verified, with
 * the creator and admin flags `.env` asks for. Sign-in is the emailed code, read from the
 * session's mail catcher (make dev: http://localhost:8025) — no account holds a password, so
 * there is nothing to put in `.env` for it.
 *
 * ⚠️ **Its handle is not your username when the server would refuse that name.** A handle may not
 * carry an underscore, and a few names are reserved outright (`parkerhdavis` among them), so the
 * account asks for `<username>-dev` instead — see `localHandleName`.
 *
 * Credentials come from the environment (Bun auto-loads .env, which is gitignored):
 *
 *   DEV_ACCOUNT_USERNAME   your prod username
 *   DEV_ACCOUNT_EMAIL      your prod email
 *   DEV_ACCOUNT_CREATOR    optional, "true"/"false" (default true)
 *   DEV_ACCOUNT_ADMIN      optional, "true"/"false" (default false) — also give DEV_ACCOUNT_EMAIL a
 *                          super-admin account in the admin app, signed into by emailed code
 *
 * If either required var is unset, this is a silent no-op so a fresh clone without them
 * still runs `make dev` cleanly. It never fails the session: an unexpected error is logged as a
 * warning and the dev servers still start.
 *
 * Usage:
 *   bun run db:dev-account     # run by `make dev` through `bun run db:seed`
 */

import { db } from "@anthers/db/client";
import { devCheckoutRoot } from "@anthers/db/dev-only";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { createAdminAccount, findAdminAccountByEmail } from "../services/admin-accounts.js";
import { hostedHandleSuffix } from "../services/hosted-accounts.js";
import { createLocalAccount, localHandleName } from "./local-accounts.js";

const TAG = "[dev-account]";

async function main() {
	// This can create an admin account, so it must never run against a deployed database. The guard is the
	// deployment's SHAPE — a checkout's root files, which the API image does not copy — rather than
	// a label somebody has to remember to set; `dev-only.ts` has the reasoning.
	if (!devCheckoutRoot()) {
		console.warn(
			`${TAG} no repository checkout around this file — refusing to run. This is a dev-only bootstrap.`,
		);
		return;
	}

	const username = process.env.DEV_ACCOUNT_USERNAME?.trim();
	const email = process.env.DEV_ACCOUNT_EMAIL?.trim();
	const isCreator = (process.env.DEV_ACCOUNT_CREATOR ?? "true").toLowerCase() !== "false";
	const isAdmin = (process.env.DEV_ACCOUNT_ADMIN ?? "false").toLowerCase() === "true";

	if (!username || !email) {
		console.log(
			`${TAG} DEV_ACCOUNT_{USERNAME,EMAIL} not both set — skipping (add them to .env to enable).`,
		);
		return;
	}

	// An admin account is its own identity, so it is made beside the Anthers account rather than as a
	// flag on it, and signing in to the admin app is by a code sent to the same address.
	if (isAdmin && !(await findAdminAccountByEmail(email))) {
		await createAdminAccount({ email, displayName: username, isSuperAdmin: true }, null);
		console.log(`${TAG} created a super-admin account for ${email} in the admin app.`);
	}

	// The account's lookup key is the handle its creation actually wrote: the preferred name
	// when the server would issue it, or the `-dev` fallback `localHandleName` picks when it
	// would not. Reconciling on the plain username would miss a fallback row every time.
	const handle = `${localHandleName(username)}.${await hostedHandleSuffix()}`;
	const [existing] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, handle))
		.limit(1);
	if (existing) {
		console.log(`${TAG} "${username}" already exists in this session.`);
		return;
	}

	const user = await createLocalAccount({
		email,
		handleName: username,
		emailVerified: true,
		fields: { displayName: username, isCreator },
	});
	console.log(
		`${TAG} created "${username}" (${email}) as @${user.atprotoHandle} — creator=${isCreator}.`,
	);
}

try {
	await main();
} catch (err) {
	// A convenience account must never block the dev environment from starting.
	console.warn(`${TAG} WARNING: could not create the dev account (continuing):`, err);
}
process.exit(0);
