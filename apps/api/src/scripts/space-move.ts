// SPDX-License-Identifier: Apache-2.0
/**
 * Move one identity to another PDS.
 *
 * The operator's command for the five-step move. The export is the copy a person carries; this
 * is for an identity that has a destination, and it verifies every artifact before it retires
 * anything.
 *
 * Usage:
 *   SPACE_MOVE_PASSWORD=… SPACE_MOVE_PLC_TOKEN=… bun run space:move \
 *     --user 12 --to https://new-pds.example --email person@example.com [--handle name.example]
 *
 * The password and the PLC email token come from the environment rather than the command line,
 * because both are credentials and a shell history is a file.
 */
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { moveAccount } from "../services/space-move.js";

interface Args {
	userId: number | null;
	to: string | null;
	email: string | null;
	handle: string | null;
	retire: boolean;
}

function parse(argv: string[]): Args {
	const args: Args = { userId: null, to: null, email: null, handle: null, retire: true };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--user") args.userId = Number(argv[++i]);
		else if (arg === "--to") args.to = argv[++i] ?? null;
		else if (arg === "--email") args.email = argv[++i] ?? null;
		else if (arg === "--handle") args.handle = argv[++i] ?? null;
		else if (arg === "--no-retire") args.retire = false;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.userId || !args.to || !args.email) {
		throw new Error("name --user <id>, --to <pds url> and --email <address>");
	}
	return args;
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));
	const password = process.env.SPACE_MOVE_PASSWORD;
	const plcToken = process.env.SPACE_MOVE_PLC_TOKEN;
	if (!password) throw new Error("SPACE_MOVE_PASSWORD is unset");
	if (!plcToken) throw new Error("SPACE_MOVE_PLC_TOKEN is unset");

	const [user] = await db
		.select({ handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, args.userId as number))
		.limit(1);
	if (!user) throw new Error(`no account ${args.userId}`);

	const result = await moveAccount(args.userId as number, {
		target: {
			pdsUrl: args.to as string,
			email: args.email as string,
			password,
			handle: args.handle ?? user.handle,
		},
		plcToken,
		retire: args.retire,
	});

	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
}

await main();
