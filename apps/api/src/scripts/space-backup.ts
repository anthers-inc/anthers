// SPDX-License-Identifier: Apache-2.0
/**
 * Capture one account's spaces on demand.
 *
 * The nightly sweep is the ordinary path; this is for the drill, for a capture before a risky
 * migration, and for an operator answering a support request with a fresh copy in hand.
 *
 * Usage:
 *   bun run space:backup --user 12
 *   bun run space:backup --space at://did:plc:…/space/org.anthers.userSpace/self
 *   bun run space:backup --space at://did:plc:…/space/org.anthers.creatorSpace/7
 *
 * ⚠️ **`--user` captures every space the account owns**, not just the Library: a creator's
 * studio and one gated space per published Work are spaces of their own, and a capture that
 * carried only the Library would be the exact hole this command exists to close.
 */
import { db } from "@anthers/db/client";
import { type spaceBackups, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { captureOwnedSpaces, captureSpace } from "../services/space-backup.js";
import { parseSpaceAddress } from "../services/space-registry.js";

interface Args {
	userId: number | null;
	spaceUri: string | null;
}

function parse(argv: string[]): Args {
	const args: Args = { userId: null, spaceUri: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user") args.userId = Number(argv[++i]);
		else if (arg === "--space") args.spaceUri = argv[++i] ?? null;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.userId && !args.spaceUri) throw new Error("name --user <id> or --space <uri>");
	return args;
}

async function ownerOf(spaceUri: string): Promise<number> {
	const address = parseSpaceAddress(spaceUri);
	if (!address) throw new Error(`not a space address: ${spaceUri}`);
	const [row] = await db
		.select({ userId: users.id })
		.from(users)
		.where(eq(users.atprotoDid, address.did))
		.limit(1);
	if (!row) throw new Error(`no account owns ${address.did}`);
	return row.userId;
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));

	if (args.spaceUri) {
		const userId = args.userId ?? (await ownerOf(args.spaceUri));
		const address = parseSpaceAddress(args.spaceUri);
		if (!address) throw new Error(`not a space address: ${args.spaceUri}`);
		const captured = await captureSpace(
			{ did: address.did, spaceUri: args.spaceUri, spaceType: address.spaceType },
			userId,
		);
		if (!captured.ok) {
			console.error(`capture failed: ${captured.reason}`);
			process.exitCode = 1;
			return;
		}
		console.log(JSON.stringify(summarize(captured.backup), null, 2));
		return;
	}

	const captured = await captureOwnedSpaces(args.userId as number);
	if (!captured.ok) {
		console.error(`capture failed: ${captured.reason}`);
		process.exitCode = 1;
		return;
	}
	console.log(JSON.stringify({ spaces: captured.backups.map(summarize) }, null, 2));
	if (captured.backups.some((backup) => backup.status === "failed")) process.exitCode = 1;
}

function summarize(backup: typeof spaceBackups.$inferSelect) {
	return {
		id: backup.id,
		spaceUri: backup.spaceUri,
		capturedAt: backup.capturedAt.toISOString(),
		status: backup.status,
		records: backup.recordCount,
		blobs: backup.blobCount,
		blobBytes: backup.blobBytes,
		rev: backup.rev,
		prefix: backup.prefix,
		starBytes: backup.starBytes,
		lastError: backup.lastError,
	};
}

await main();
