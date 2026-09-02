// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Dev bootstrap account — ensures a personal login exists in the local dev DB.
 *
 * Runs automatically at the top of `make dev` (after the DB is up + migrated).
 * Its purpose is credential parity: keep a local account matching the SAME
 * username/email/password you use on prod, so wiping the dev DB never costs you
 * the ability to log in with your usual combo.
 *
 * It **ensures**, not merely creates. Missing → created. Already there → the
 * declarative fields are reconciled to what `.env` says: email, creator, admin,
 * verified. That matters because these vars describe *one account you own*, and
 * a create-if-missing bootstrap silently diverges the moment you change one —
 * a fresh clone would pick the change up while your actual working database
 * never would, which is the worst of both (it looks configured and isn't).
 *
 * The password is the deliberate exception: it is never rewritten, because
 * overwriting a credential is the one change here that could lock you out of a
 * session or a flow mid-test. A drift is *reported* instead, with the fix.
 *
 * 🚨 A `$` in DEV_ACCOUNT_PASSWORD is silently mangled, and the reported drift is
 * then the only sign. Bun's `.env` parser performs variable expansion **even
 * inside single quotes**, so `'p$ssw0rd'` loses everything from the `$` to the
 * next word boundary and the value this script compares against is not the value
 * you typed. Escape each as `\$`, or pick a password without one.
 *
 * Credentials come from the environment (Bun auto-loads .env, which is
 * gitignored) so nothing sensitive is ever committed:
 *
 *   DEV_ACCOUNT_USERNAME   your prod username — the STABLE identity this matches on
 *   DEV_ACCOUNT_EMAIL      your prod email
 *   DEV_ACCOUNT_PASSWORD   your prod password
 *   DEV_ACCOUNT_CREATOR    optional, "true"/"false" (default true)
 *   DEV_ACCOUNT_ADMIN      optional, "true"/"false" (default false) — ops console
 *                          + the moderation queue
 *
 * If any of the three required vars are unset, this is a silent no-op so a fresh
 * clone without them configured still runs `make dev` cleanly. It also never
 * fails the build: any unexpected error is logged as a warning and swallowed so
 * the dev servers still start.
 *
 * Usage:
 *   bun run db:dev-account     # invoked by `make dev`; safe to run by hand too
 */

import { and, eq, ne } from "drizzle-orm";
import { devCheckoutRoot } from "./dev-only.js";
import { db, users } from "./index.js";

const TAG = "[dev-account]";

async function main() {
	// This can grant admin AND rewrite an existing row, so it must never run against a
	// deployed database. The guard is the deployment's SHAPE — a checkout's root files, which
	// the API image does not copy — rather than a label somebody has to remember to set.
	//
	// 🚨 It was `NODE_ENV === "production"` until 2026-08-23, and `NODE_ENV` is set nowhere in
	// this app, so the refusal never fired in production. Nothing in the deploy calls this, so
	// it was a trap rather than a live defect; the reasoning and why an `https FRONTEND_URL`
	// check would NOT have worked here are in `dev-only.ts`.
	if (!devCheckoutRoot()) {
		console.warn(
			`${TAG} no repository checkout around this file — refusing to run. This is a dev-only bootstrap.`,
		);
		return;
	}

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

	// Match on USERNAME — the stable identity. Matching on email too would mean
	// that changing DEV_ACCOUNT_EMAIL could silently rebrand whichever row the
	// database happened to return first.
	const [existing] = await db
		.select({
			id: users.id,
			username: users.username,
			email: users.email,
			passwordHash: users.passwordHash,
			isCreator: users.isCreator,
			isAdmin: users.isAdmin,
			emailVerified: users.emailVerified,
		})
		.from(users)
		.where(eq(users.username, username))
		.limit(1);

	if (!existing) {
		// No account under that username. Guard the email too: it's unique, so a
		// collision would throw, and "some other row already has this address" is
		// a far more useful thing to read than a constraint violation.
		const [emailOwner] = await db
			.select({ username: users.username })
			.from(users)
			.where(eq(users.email, email))
			.limit(1);
		if (emailOwner) {
			console.warn(
				`${TAG} "${emailOwner.username}" already uses ${email} — not creating "${username}". ` +
					`Pick a different DEV_ACCOUNT_EMAIL, or delete that row.`,
			);
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
		return;
	}

	// ── Reconcile the existing row against what .env declares ────────────────
	const changes: string[] = [];
	const patch: Partial<typeof users.$inferInsert> = {};

	if (existing.email !== email) {
		// Unique column: refuse rather than throw if someone else holds it.
		const [conflict] = await db
			.select({ username: users.username })
			.from(users)
			.where(and(eq(users.email, email), ne(users.id, existing.id)))
			.limit(1);
		if (conflict) {
			console.warn(
				`${TAG} cannot move "${username}" to ${email} — "${conflict.username}" already uses it. Leaving the email as ${existing.email}.`,
			);
		} else {
			patch.email = email;
			// A dev bootstrap email is verified by fiat; re-verifying an address
			// you control would just park this account behind the email wall.
			patch.emailVerified = true;
			changes.push(`email ${existing.email} → ${email}`);
		}
	}

	if (existing.isCreator !== isCreator) {
		patch.isCreator = isCreator;
		changes.push(`creator ${existing.isCreator} → ${isCreator}`);
	}
	if (existing.isAdmin !== isAdmin) {
		patch.isAdmin = isAdmin;
		changes.push(`admin ${existing.isAdmin} → ${isAdmin}`);
	}
	if (!existing.emailVerified && patch.emailVerified === undefined) {
		patch.emailVerified = true;
		changes.push("email verified");
	}

	if (Object.keys(patch).length > 0) {
		await db.update(users).set(patch).where(eq(users.id, existing.id));
		console.log(`${TAG} reconciled "${username}": ${changes.join(", ")}.`);
	} else {
		console.log(`${TAG} "${username}" is already as configured.`);
	}

	// The password is never rewritten — see the module note. But say so out loud
	// when it has drifted, because the old silent skip meant a changed
	// DEV_ACCOUNT_PASSWORD looked applied and wasn't. `passwordHash` is nullable
	// (an ATProto-linked account may never have set one), and a null hash is a
	// drift too — the .env password won't sign you in.
	const passwordMatches = existing.passwordHash
		? await Bun.password.verify(password, existing.passwordHash)
		: false;
	if (!passwordMatches) {
		console.warn(
			`${TAG} NOTE: DEV_ACCOUNT_PASSWORD differs from the stored password for "${username}", and is NOT applied ` +
				`(this script never overwrites a credential). Sign in with the stored one, change it in Settings, ` +
				`or delete the row and re-run to adopt the .env value.`,
		);
	}
}

try {
	await main();
} catch (err) {
	// A convenience account must never block the dev environment from starting.
	console.warn(`${TAG} WARNING: could not ensure dev account (continuing):`, err);
}
process.exit(0);
