// SPDX-License-Identifier: Apache-2.0
/**
 * The transcode job runs exactly once per attempt, by configuration and by lock.
 *
 * 🚨 **pg-boss treats a job whose handler runs past `expireInSeconds` as expired and
 * re-delivers it while the abandoned handler keeps encoding** — that is how one long
 * production source came to be encoded twice in full on 2026-10-11, pegging the worker
 * and wasting a ladder. The defense is three parts and this refuses a source that loses
 * any of them:
 *
 * 1. `JOB_OPTIONS[MEDIA]` (the single-file lane's shared budget) carries an expiry sized
 *    for real encode runtimes (expiry *is* the handler's runtime cap under pg-boss v12 —
 *    see the constant's comment) and a heartbeat, which is the fast "worker died
 *    mid-encode" detection a long expiry does not provide;
 * 2. `toBossSendOptions` forwards the heartbeat, or no job would ever have one;
 * 3. the handler wraps its body in `withTranscodeLock` — the database advisory lock a
 *    re-delivery waits on — and owes the row `ensureStillOurs` re-reads before the
 *    operations a zombie run must not perform. Nothing else in the worker is allowed to
 *    touch the advisory-lock functions, for the same reason `ffmpegCommand` is the only
 *    thing allowed to spawn ffmpeg: a second lock shape is a second semantics nobody
 *    planned.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { JOB_OPTIONS, QUEUES, toBossSendOptions } from "../apps/api/src/jobs/queue";

const ROOT = "apps/api/src";
const HELPER = "jobs/transcode-video.ts";

function isExempt(rel: string): boolean {
	return (
		rel === HELPER ||
		rel.startsWith("scripts/") ||
		rel.includes("__tests__/") ||
		/\.test\.tsx?$/.test(rel)
	);
}

/** The API's sources, as paths relative to `apps/api/src`. */
async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: ROOT })) {
		if (!rel.includes("node_modules/")) found.push(rel);
	}
	return found;
}

/** The Postgres advisory-lock family, which the transcode handler owns alone. */
const NAMES_ADVISORY = /pg_(try_advisory|advisory)/;

describe("transcode expiry and heartbeat", () => {
	it("sends the media queue an expiry sized past real encode runtimes", () => {
		const options = JOB_OPTIONS[QUEUES.MEDIA];
		// The measured long encode (2026-10-11) took 54 minutes; the guard's floor is one
		// hour, so a revert to the old 45-minute window or any "back to short" tuning
		// fails here before production does.
		expect(options.expireInMinutes).toBeGreaterThan(60);
	});

	it("carries a heartbeat, so a worker that died mid-encode is caught in minutes", () => {
		const options = JOB_OPTIONS[QUEUES.MEDIA];
		// pg-boss's own floor is 10s; below it the send is refused and the job would
		// never land, which is a worse failure mode than expiring blind.
		expect(options.heartbeatSeconds).toBeGreaterThanOrEqual(10);
	});

	it("forwards heartbeatSeconds to pg-boss, or no job would ever carry one", () => {
		const mapped = toBossSendOptions({ heartbeatSeconds: 120, expireInMinutes: 720 });
		expect(mapped.heartbeatSeconds).toBe(120);
		expect(mapped.expireInSeconds).toBe(720 * 60);
	});
});

describe("the handler's single-encode guard", () => {
	it("scans the worker's sources, so a broken glob cannot pass silently", async () => {
		const files = await sourceFiles();
		expect(files).toContain("jobs/transcode-video.ts");
		expect(files).toContain("jobs/worker.ts");
	});

	it("wraps the transcode body in the encode lock and owes the row its re-checks", async () => {
		const source = await Bun.file(join(ROOT, HELPER)).text();
		// The entry point hands the body to the lock, not to free-running code.
		expect(source).toContain("withTranscodeLock(data.jobId");
		expect(source).toContain("pg_try_advisory_lock");
		// The zombie run's re-check rides the upload and guards the completion write:
		// three call sites, and a revert to "check only at claim time" fails here.
		expect(source.match(/await ensureStillOurs\(\)/g)?.length).toBeGreaterThanOrEqual(3);
	});

	it("finds no source that touches the advisory locks outside the helper", async () => {
		const offenders: string[] = [];
		for (const rel of await sourceFiles()) {
			if (isExempt(rel)) continue;
			if (NAMES_ADVISORY.test(await Bun.file(join(ROOT, rel)).text())) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});
});
