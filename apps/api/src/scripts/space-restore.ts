// SPDX-License-Identifier: Apache-2.0
/**
 * Restore one space from its logical backup, or say what a restore would do.
 *
 * The runbook's executable: the drill and a real recovery both go through the same service, so
 * the path exercised on staging is the path an operator runs.
 *
 * Usage:
 *   bun run space:restore --backup 42                 # restore capture 42, refusing a live space
 *   bun run space:restore --backup 42 --replace        # delete the live space first
 *   bun run space:restore --space at://did/space/…     # the newest complete capture of a space
 *   bun run space:restore --backup 42 --dry-run        # print the manifest and write nothing
 *
 * ⚠️ **`--replace` is a deletion of the live space.** It exists because the drill must be able
 * to restore over the space it just captured, and because a recovery after a corrupt space is
 * exactly that operation. It is never implied.
 */
import { backupById, latestBackup } from "../services/space-backup.js";
import { restoreSpace } from "../services/space-restore.js";

interface Args {
	backupId: number | null;
	spaceUri: string | null;
	replace: boolean;
	dryRun: boolean;
}

function parse(argv: string[]): Args {
	const args: Args = { backupId: null, spaceUri: null, replace: false, dryRun: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--backup") args.backupId = Number(argv[++i]);
		else if (arg === "--space") args.spaceUri = argv[++i] ?? null;
		else if (arg === "--replace") args.replace = true;
		else if (arg === "--dry-run") args.dryRun = true;
		else throw new Error(`unknown argument ${arg}`);
	}
	if (!args.backupId && !args.spaceUri) {
		throw new Error("name a capture with --backup <id> or a space with --space <uri>");
	}
	if (args.backupId !== null && !Number.isInteger(args.backupId)) {
		throw new Error("--backup takes a manifest id");
	}
	return args;
}

async function main(): Promise<void> {
	const args = parse(process.argv.slice(2));
	const backup = args.backupId
		? await backupById(args.backupId)
		: await latestBackup(args.spaceUri as string);

	if (!backup) {
		console.error("no capture found");
		process.exitCode = 1;
		return;
	}

	if (args.dryRun) {
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
					wouldReplace: args.replace,
				},
				null,
				2,
			),
		);
		return;
	}

	const restored = await restoreSpace(backup.id, { replace: args.replace });
	if (!restored.ok) {
		console.error(`restore refused: ${restored.reason}`);
		process.exitCode = 1;
		return;
	}
	console.log(JSON.stringify(restored.report, null, 2));
	const report = restored.report;
	const clean =
		report.records.mismatched.length === 0 &&
		report.blobs.missing.length === 0 &&
		report.files.missing.length === 0 &&
		report.policy.matches &&
		report.commit.matches !== false;
	if (!clean) process.exitCode = 1;
}

await main();
