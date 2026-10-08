// SPDX-License-Identifier: Apache-2.0
/**
 * Seed the Noun Project blocklist — the starter term list, run ONCE against production
 * through the prod-db door:
 *
 *     make prod-db CMD="bun run scripts/seed-noun-blocklist.ts"
 *
 * 🚨 **The terms live in the seed script because they must be reviewed IN the open, in a
 * diff, beside the reasoning that put each there** — an opaque list "in the vault
 * somewhere" is exactly the unownable mechanism the sourcing document warned about. The
 * categories and their reasons are the seed document's
 * (`Anthers-Wiki/Internal Wiki/Transient/Noun Project Blocklist Seed.md`); the script is
 * the mechanical half that makes the rows exist.
 *
 * Idempotent on (kind, value): re-running adds nothing and removes nothing. Removals are
 * admin-door actions, never here — a seed script that deletes would silently unwrap a
 * protection on a later run.
 *
 * ⚠️ **The vendor-side push is NOT this script's job.** After this lands rows locally,
 * one `POST /api/admin/noun-blocklist/sync` from an operator session (or the sync that
 * rides inline on the first admin add) carries them up. Keeping the two separated keeps
 * this script free of vendor credentials, which a prod-db context has no business
 * holding.
 */

import { db } from "@anthers/db/client";
import { adminAccounts, nounBlocklist } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { TERMS } from "./seed-noun-blocklist-terms";

// The admin operator the seed rows name as their adder: the first super admin. The
// Badge Maker's blocklist rows are org safety decisions, and a real admin account id is
// the honest attribution — a seed that invented a row would defeat the "who added this"
// question the column exists to answer. Fails helpfully rather than inventing.
const adminAccountColumns = {
	id: adminAccounts.id,
} as const;
const [admin] = await db
	.select(adminAccountColumns)
	.from(adminAccounts)
	.where(eq(adminAccounts.isSuperAdmin, true))
	.orderBy(adminAccounts.id)
	.limit(1);
if (!admin) {
	console.error(
		"seed-noun-blocklist: no super admin account in this database — create one first " +
			"(the admin-account script), because every entry's addedBy names a real operator.",
	);
	process.exit(2);
}

let added = 0;
for (const { value, reason } of TERMS) {
	const result = await db
		.insert(nounBlocklist)
		.values({ kind: "term", value, reason, addedBy: admin.id })
		.onConflictDoNothing()
		.returning({ id: nounBlocklist.id });
	added += result.length;
}
console.log(
	`seed-noun-blocklist: ${added} of ${TERMS.length} term(s) added (${TERMS.length - added} already present).`,
);
process.exit(0);
