// SPDX-License-Identifier: Apache-2.0
/**
 * An operator's door to the password column's retirement.
 *
 * The judgment lives in `services/hosted-credentials.ts` — this is the CLI, so the shell a person
 * types and the thing the test suite exercises are the same code.
 *
 *   bun run hosted:credentials report
 *   bun run hosted:credentials convert [--yes]
 *
 * In production, use the wrapper Make target, which injects `DATABASE_URL` without the connection
 * string appearing on a command line:
 *   make prod-db CMD="bun run hosted:credentials report"
 */
import { client } from "@anthers/db/client";
import { convertSealedPasswords, sealedPasswordRows } from "../services/hosted-credentials.js";

const TAG = "[hosted-credentials]";

const USAGE = `usage:
  bun run hosted:credentials report
  bun run hosted:credentials convert [--yes]`;

async function report(): Promise<void> {
	const rows = await sealedPasswordRows();
	if (rows.length === 0) {
		console.log(`${TAG} no hosted account holds a password. Nothing to convert.`);
		return;
	}
	console.log(`${TAG} ${rows.length} hosted account(s) still hold a password:`);
	for (const row of rows) {
		const sealed = row.openable ? "openable" : "UNOPENABLE";
		const session = row.hasSession ? "session on file" : "no session";
		console.log(`  ${row.handle} (${row.did}) — ${sealed}, ${session}`);
	}
	console.log(`${TAG} \`convert\` opens a session with each openable password and then drops it.`);
}

async function convert(confirmed: boolean): Promise<void> {
	if (!confirmed) {
		const rows = await convertSealedPasswords({ dryRun: true });
		if (rows.length === 0) {
			console.log(`${TAG} no hosted account holds a password. Nothing to convert.`);
			return;
		}
		console.log(`${TAG} would convert ${rows.length} row(s):`);
		for (const row of rows) console.log(`  ${row.handle} (${row.did})`);
		console.log(`${TAG} pass --yes to write.`);
		return;
	}

	const outcomes = await convertSealedPasswords();
	const converted = outcomes.filter((o) => o.converted);
	const refused = outcomes.filter((o) => !o.converted);
	console.log(`${TAG} converted ${converted.length}, left ${refused.length}:`);
	for (const outcome of converted) {
		console.log(`  ✓ ${outcome.handle} (${outcome.did}) — session on file, password dropped`);
	}
	for (const outcome of refused) {
		console.log(`  ✗ ${outcome.handle} (${outcome.did}) — ${outcome.refused ?? "unknown"}`);
	}
	if (refused.length > 0) {
		console.log(
			`${TAG} a refused row keeps its password. Its holder can replace it by signing in, or ` +
				`through Settings → Identity → Your Identity Server.`,
		);
	}
}

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2);
	if (!command || command === "--help" || command === "-h") {
		console.log(USAGE);
		return;
	}
	if (command === "report") {
		await report();
		return;
	}
	if (command === "convert") {
		await convert(rest.includes("--yes"));
		return;
	}
	console.error(`${TAG} unknown command "${command}"`);
	console.log(USAGE);
	process.exitCode = 1;
}

main()
	.catch((err) => {
		console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
		process.exitCode = 1;
	})
	.finally(() => client.end());
