// SPDX-License-Identifier: Apache-2.0
/**
 * Capture one account's space on demand.
 *
 * The nightly sweep is the ordinary path; this is for the drill, for a capture before a risky
 * migration, and for an operator answering a support request with a fresh copy in hand.
 *
 * Usage:
 *   bun run space:backup --user 12
 *   bun run space:backup --space at://did:plc:…/space/org.anthers.userSpace/self
 */
import { db } from "@anthers/db/client";
import { userSpaces } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { captureSpace } from "../services/space-backup.js";

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

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));
	let userId = args.userId;
	if (!userId) {
		const [row] = await db
			.select({ userId: userSpaces.userId })
			.from(userSpaces)
			.where(eq(userSpaces.spaceUri, args.spaceUri as string))
			.limit(1);
		if (!row) throw new Error(`no registered space at ${args.spaceUri}`);
		userId = row.userId;
	}

	const captured = await captureSpace(userId);
	if (!captured.ok) {
		console.error(`capture failed: ${captured.reason}`);
		process.exitCode = 1;
		return;
	}
	const backup = captured.backup;
	console.log(
		JSON.stringify(
			{
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
			},
			null,
			2,
		),
	);
}

await main();
