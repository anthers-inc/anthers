// SPDX-License-Identifier: Apache-2.0
/**
 * Every change to a processing job's status also says when it happened.
 *
 * The Studio Dashboard's processing panel keeps a Work for a day after it finishes, and it reads
 * "when it finished" from `transcoding_jobs.updated_at`. That column has no trigger and no
 * `$onUpdate`, so it moves only when a writer sets it — and the video and audio jobs did not,
 * which left every finished encode dated to when it was queued. **The failure is an empty
 * panel**, which is also what a creator with nothing recent is supposed to see, so nothing
 * would ever report it.
 *
 * The jobs themselves need ffmpeg and storage and have no suite that runs them to completion,
 * so this reads their source: each `.update(transcodingJobs).set({ … })` that names a `status`
 * must name `updatedAt` too.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

const JOBS = join(import.meta.dir, "../jobs");

/** The object literal of each status-setting write to `transcodingJobs` in `source`. */
export function statusWrites(source: string): string[] {
	const writes: string[] = [];
	const pattern = /\.update\(transcodingJobs\)\s*\.set\(\{([\s\S]*?)\}\)/g;
	for (const match of source.matchAll(pattern)) {
		if (/\bstatus\s*:/.test(match[1])) writes.push(match[1]);
	}
	return writes;
}

describe("processing job status writes", () => {
	it("finds the writes it is guarding, so an empty scan cannot pass", async () => {
		let total = 0;
		for await (const file of new Bun.Glob("*.ts").scan({ cwd: JOBS })) {
			total += statusWrites(await Bun.file(join(JOBS, file)).text()).length;
		}
		// Start, completion and failure in the video, audio and ebook jobs, plus the orphan sweep.
		expect(total).toBeGreaterThanOrEqual(10);
	});

	it("stamps updatedAt on every one", async () => {
		const missing: string[] = [];
		for await (const file of new Bun.Glob("*.ts").scan({ cwd: JOBS })) {
			for (const write of statusWrites(await Bun.file(join(JOBS, file)).text())) {
				if (!/\bupdatedAt\s*:/.test(write)) {
					missing.push(`${file}: { ${write.replace(/\s+/g, " ").trim()} }`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
