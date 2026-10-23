// SPDX-License-Identifier: Apache-2.0
/**
 * Migrate one account's reader state into its space, or return it to the database.
 *
 * The cutover is reversible by design, so the rollback is a first-class verb rather than a
 * manual SQL statement. Run the migration, verify the Library, then move the first account;
 * `--rollback` puts it back without deleting the space.
 *
 * Usage:
 *   bun run space:migrate-reader --user 12
 *   bun run space:migrate-reader --user 12 --rollback
 */
import {
	migrateReaderState,
	readerStateHome,
	rollbackReaderState,
} from "../services/reader-state-migration.js";

interface Args {
	userId: number | null;
	rollback: boolean;
}

function parse(argv: string[]): Args {
	const args: Args = { userId: null, rollback: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user") args.userId = Number(argv[++i]);
		else if (arg === "--rollback") args.rollback = true;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.userId || !Number.isInteger(args.userId)) throw new Error("name --user <id>");
	return args;
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));
	const userId = args.userId as number;

	if (args.rollback) {
		await rollbackReaderState(userId);
		console.log(
			JSON.stringify({ userId, readerStateHome: await readerStateHome(userId) }, null, 2),
		);
		return;
	}

	const result = await migrateReaderState(userId);
	console.log(
		JSON.stringify({ ...result, readerStateHome: await readerStateHome(userId) }, null, 2),
	);
	if (!result.ok) process.exitCode = 1;
}

await main();
