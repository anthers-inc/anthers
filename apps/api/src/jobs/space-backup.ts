// SPDX-License-Identifier: Apache-2.0
/**
 * The nightly logical space backup, and the retention sweep that keeps it bounded.
 *
 * ⭐ **The prune runs in the same job as the capture, after it.** A retention window that is a
 * second cron is a window that can be forgotten when the first is rescheduled; running them
 * together means the sweep that creates captures is the sweep that retires them, and the two
 * read the same clock.
 *
 * ⚠️ **Quiet when there was nothing to do.** A nightly sweep whose ordinary answer is zero
 * captures (no registered spaces yet) should not write a line that trains a reader to skip the
 * output.
 */
import { backupRegisteredSpaces, pruneSpaceBackups } from "../services/space-backup.js";

export interface SpaceBackupJobData {
	limit?: number;
}

export async function spaceBackupJob(data: SpaceBackupJobData = {}): Promise<void> {
	const captured = await backupRegisteredSpaces({ limit: data.limit ?? 100 });
	const pruned = await pruneSpaceBackups();
	if (captured.complete > 0 || captured.partial > 0 || captured.failed > 0 || pruned.removed > 0) {
		console.log(
			`[space-backup] ${captured.spaces} space(s): ${captured.complete} complete, ` +
				`${captured.partial} partial, ${captured.failed} failed, ${captured.skipped} skipped; ` +
				`pruned ${pruned.removed}, kept ${pruned.kept}`,
		);
	}
}
