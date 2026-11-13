// SPDX-License-Identifier: Apache-2.0
/**
 * Repair a Badge recurrence that a completed checkout left without a subscription.
 *
 * Dry run (the default) reads Stripe and the database and prints what it would do. Add
 * `--apply` to attach the cards, create the trialing subscriptions and record the
 * day-exact reductions. The handles are required so a canceled subscription is never
 * resurrected by a blind sweep.
 *
 * Production form, with both secrets injected rather than typed:
 *   make repair-badge-recurrences HANDLES="amaiguri.bsky.social parkerhdavis.com" APPLY=1
 */
import { db } from "@anthers/db/client";
import { repairMissingBadgeRecurrences } from "../services/badge-recurrence-repair.js";

const apply = process.argv.includes("--apply");
const handles = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
if (handles.length === 0) {
	console.error(
		"Usage: bun run apps/api/src/scripts/repair-badge-recurrences.ts [--apply] <handle> [handle...]",
	);
	process.exit(64);
}

if (apply) {
	const secret = process.env.STRIPE_SECRET_KEY ?? "";
	const database = process.env.DATABASE_URL ?? "";
	if (!secret.startsWith("sk_live_")) throw new Error("refusing: --apply needs a live Stripe key");
	if (!database || /localhost|127\.0\.0\.1/.test(database))
		throw new Error("refusing: --apply needs the production database");
}

try {
	const summary = await repairMissingBadgeRecurrences({ handles, apply });
	console.log(JSON.stringify({ applied: apply, summary }, null, 2));
} finally {
	await db.$client.end();
}
