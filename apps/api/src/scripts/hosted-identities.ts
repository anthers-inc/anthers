// SPDX-License-Identifier: Apache-2.0
/**
 * Read the watcher's list of hosted identities, and remove a row from it on purpose.
 *
 * `watch-identities` fills `hosted_identities` from the node's own repository listing, and the
 * list only ever grows — a row that stops appearing in a listing that otherwise succeeded is an
 * alert, and nothing the watched server does may remove one. The counterpart is a person
 * deciding it should stop being watched, which until now had no door at all: the only way to
 * retire a test account without mailing an operational alert was a hand-written `delete` against
 * production.
 *
 * ⭐ **That is the whole reason this exists**: deleting an account on the node and removing its
 * row belong in the same step, because the hour between them raises *identity no longer listed
 * by its server* for an account somebody meant to remove.
 *
 * ⚠️ **`forget` prints the row and refuses to write without `--yes`.** There is no bulk form and
 * no `--all`, deliberately: a row's absence is a claim that nobody is watching that identity any
 * more, and that claim should cost a person reading the handle first.
 *
 * ⚠️ **`--credential` also drops the hub's sealed credential for the same DID**, and is only for
 * an identity that no longer exists on the node. On a live one that session is how Anthers writes
 * to the account at all. Rows that still hold a pre-session password are retired by
 * `hosted:credentials convert`, not by hand.
 *
 *   bun run hosted:identities list
 *   bun run hosted:identities forget --did did:plc:… --yes
 *
 * In production, use the wrapper Make target, which injects `DATABASE_URL` without the
 * connection string appearing on a command line:
 *   make prod-db CMD="bun run hosted:identities list"
 */
import { client, db } from "@anthers/db/client";
import { hostedAccounts, hostedIdentities, users } from "@anthers/db/schema";
import { asc, eq } from "drizzle-orm";

const USAGE = `usage:
  bun run hosted:identities list [--holdings]
  bun run hosted:identities forget --did <did> [--credential] [--yes]`;

function fail(message: string): never {
	console.error(`[hosted-identities] ${message}`);
	process.exit(1);
}

function format(value: Date | null): string {
	return value ? value.toISOString().replace(".000Z", "Z") : "—";
}

async function list(holdings: boolean): Promise<void> {
	const query = db
		.select({
			did: hostedIdentities.did,
			handle: hostedIdentities.handle,
			pdsEndpoint: hostedIdentities.pdsEndpoint,
			firstSeenAt: hostedIdentities.firstSeenAt,
			lastCheckedAt: hostedIdentities.lastCheckedAt,
			lastListedAt: hostedIdentities.lastListedAt,
			alertedAt: hostedIdentities.alertedAt,
			credentialDid: hostedAccounts.did,
			userId: users.id,
			userEmail: users.email,
		})
		.from(hostedIdentities)
		.leftJoin(hostedAccounts, eq(hostedAccounts.did, hostedIdentities.did))
		.leftJoin(users, eq(users.id, hostedAccounts.userId))
		.orderBy(asc(hostedIdentities.firstSeenAt));

	const rows = await query;

	if (rows.length === 0) {
		console.log("No hosted identities are watched.");
		return;
	}
	for (const row of rows) {
		console.log(
			[
				row.handle ?? "(no handle)",
				row.did,
				row.pdsEndpoint ?? "(no endpoint)",
				`first seen ${format(row.firstSeenAt)}`,
				`last checked ${format(row.lastCheckedAt)}`,
				`last listed ${format(row.lastListedAt)}`,
			].join("  "),
		);
		if (row.alertedAt) console.log(`    last alert ${format(row.alertedAt)}`);
		if (holdings) {
			console.log(
				row.credentialDid
					? `    credential: hub holds the password` +
							(row.userId === null ? "" : ` (user ${row.userId}, ${row.userEmail ?? "no email"})`)
					: "    credential: none",
			);
		}
	}
	console.log(`\n${rows.length} ${rows.length === 1 ? "identity" : "identities"} watched.`);
}

async function forget(argv: string[]): Promise<void> {
	let did: string | null = null;
	let yes = false;
	let credential = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--did") did = argv[++i] ?? null;
		else if (argv[i] === "--yes") yes = true;
		else if (argv[i] === "--credential") credential = true;
		else fail(`unknown argument ${argv[i]}`);
	}
	if (!did) fail("forget needs --did <did>");

	const [row] = await db
		.select({
			did: hostedIdentities.did,
			handle: hostedIdentities.handle,
			pdsEndpoint: hostedIdentities.pdsEndpoint,
			lastListedAt: hostedIdentities.lastListedAt,
		})
		.from(hostedIdentities)
		.where(eq(hostedIdentities.did, did))
		.limit(1);

	if (!row) fail(`no watched identity with DID ${did}`);

	const [held] = await db
		.select({ did: hostedAccounts.did })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.did, did))
		.limit(1);

	console.log(
		`${row.handle ?? "(no handle)"}  ${row.did}  ${row.pdsEndpoint ?? "(no endpoint)"}  ` +
			`last listed ${format(row.lastListedAt)}`,
	);
	if (held) console.log("  the hub holds a credential row for this identity");

	if (!yes) {
		console.log("\nNothing removed. Re-run with --yes to stop watching this identity.");
		process.exit(3);
	}

	await db.transaction(async (tx) => {
		await tx.delete(hostedIdentities).where(eq(hostedIdentities.did, did));
		if (credential) await tx.delete(hostedAccounts).where(eq(hostedAccounts.did, did));
	});
	console.log(
		credential && held
			? "\nRemoved the watch row and the sealed credential. The watcher stops watching it on its next run."
			: "\nRemoved the watch row. The watcher stops watching it on its next run.",
	);
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
	console.log(USAGE);
	process.exit(command ? 0 : 1);
}

if (command === "list") {
	for (const arg of rest) if (arg !== "--holdings") fail(`unknown argument ${arg}`);
	await list(rest.includes("--holdings"));
} else if (command === "forget") await forget(rest);
else fail(`unknown command ${command}\n${USAGE}`);
await client.end();
