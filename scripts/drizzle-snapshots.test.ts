// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The snapshot guard, driven against doctored journals rather than the real one — the
 * same technique `webhook-check` uses for its input files, and for the same reason: a
 * check whose only exercise is the healthy repository has never been seen to fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "drizzle-snapshots.ts");
const made: string[] = [];

afterEach(() => {
	for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a drizzle directory with the given entries, snapshotting only those named. */
function fixture(entries: [number, string][], withSnapshots: number[]): string {
	const dir = mkdtempSync(join(tmpdir(), "drizzle-snap-"));
	made.push(dir);
	mkdirSync(join(dir, "meta"), { recursive: true });
	writeFileSync(
		join(dir, "meta", "_journal.json"),
		JSON.stringify({
			version: "7",
			dialect: "postgresql",
			entries: entries.map(([idx, tag]) => ({
				idx,
				version: "7",
				when: idx,
				tag,
				breakpoints: true,
			})),
		}),
	);
	for (const idx of withSnapshots) {
		writeFileSync(join(dir, "meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "{}");
	}
	return dir;
}

async function run(dir: string) {
	const proc = Bun.spawn(["bun", "run", SCRIPT], {
		env: { ...process.env, DRIZZLE_DIR: dir },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

describe("drizzle snapshot guard", () => {
	it("passes when every migration is snapshotted", async () => {
		const r = await run(
			fixture(
				[
					[0, "a"],
					[1, "b"],
				],
				[0, 1],
			),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("all snapshotted");
	});

	it("fails when the NEWEST migration has no snapshot", async () => {
		// This is the real defect: drizzle diffs against the latest snapshot, so a gap at
		// the end silently makes every future generate wrong.
		const r = await run(
			fixture(
				[
					[0, "a"],
					[1, "hand_written"],
				],
				[0],
			),
		);
		expect(r.code).toBe(1);
		expect(r.err).toContain("hand_written");
		expect(r.err).toContain("0001_snapshot.json");
	});

	it("tolerates a historical gap, and says so rather than staying silent", async () => {
		// 0041–0043 are exactly this shape. Failing here would be unfixable in retrospect,
		// because a historical snapshot describes an intermediate schema nobody can
		// reconstruct — but the untidiness should still be visible.
		const r = await run(
			fixture(
				[
					[0, "a"],
					[1, "skipped"],
					[2, "c"],
				],
				[0, 2],
			),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("historical gap");
		expect(r.out).toContain("skipped");
	});

	it("accepts a journal with no migrations at all", async () => {
		const r = await run(fixture([], []));
		expect(r.code).toBe(0);
	});

	it("reports a missing journal as a tooling fault, not a finding", async () => {
		// Exit 2 rather than 1, matching `deploy-status`: "could not determine" and
		// "found a problem" must not look the same to CI.
		const dir = mkdtempSync(join(tmpdir(), "drizzle-snap-"));
		made.push(dir);
		const r = await run(dir);
		expect(r.code).toBe(2);
	});
});
