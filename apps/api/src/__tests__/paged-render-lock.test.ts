// SPDX-License-Identifier: Apache-2.0
/**
 * The paged renderer's Work-keyed lock and its supersession check, in
 * `apps/api/src/jobs/render-paged.ts`.
 *
 * 🚨 **This suite exists because a real upload storm collided on `uq_work_pages`**
 * (2026-10-19: Work 66 arrived as 120 page images, one mutation and one queue entry each,
 * delivered two at a time; eleven queue rows failed on duplicate page numbers). Two
 * protections are tested here:
 *
 * - **The lock is keyed on the WORK**, because the colliding handlers held different
 *   `transcoding_jobs` rows. It is exercised against Postgres rather than mocked, because
 *   session scope is the property: hold `pg_advisory_lock` from a reserved session and
 *   assert the helper waits, then runs on release.
 * - **A job a newer sibling supersedes settles without rendering.** A `game` fixture with
 *   no source is deliberate: if the superseded job failed to stop, it would reach the
 *   source check and throw, so a clean resolve is the assertion that nothing downstream
 *   ran. The counterweight cases prove the check is not simply "always stop": a newer
 *   `failed` job lets this one run, and the newest job itself is never superseded.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { client, db } from "@anthers/db/client";
import { transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { PAGED_RENDER_LOCK_KEY_BASE, renderPaged, withPagedRenderLock } from "../jobs/render-paged";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure; the
// Works and their transcoding_jobs rows cascade with them.
purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
let owner = "";

beforeAll(async () => {
	owner = (await createAccount(`prl_${crypto.randomUUID().slice(0, 8)}`)).cookie;
}, DB_SETUP_TIMEOUT);

/**
 * A Work plus one ebook job row per requested status. `type: "game"` so creating it
 * queues nothing of its own — the rows under test are inserted directly, the shape the
 * other job suites use.
 */
async function makeJobs(...statuses: string[]): Promise<{ workId: number; jobIds: number[] }> {
	const res = await app.fetch(
		new Request(`http://localhost/api/content/works`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				type: "game",
				title: `paged-lock-${crypto.randomUUID().slice(0, 8)}`,
			}),
		}),
	);
	expect(res.status).toBe(201);
	const workId = (await res.json()).work.id as number;

	const jobIds: number[] = [];
	for (const status of statuses) {
		const [row] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "ebook", status, progress: 0 })
			.returning({ id: transcodingJobs.id });
		jobIds.push(row.id);
	}
	return { workId, jobIds };
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("withPagedRenderLock", () => {
	it(
		"waits while another handler holds the Work's lock, then runs",
		async () => {
			const { workId } = await makeJobs();
			const key = PAGED_RENDER_LOCK_KEY_BASE + workId;

			const holder = await client.reserve();
			const [held] = await holder`select pg_try_advisory_lock(${key}::bigint) as acquired`;
			expect(held.acquired).toBe(true);

			let ran = false;
			const pending = withPagedRenderLock(
				workId,
				async () => {
					ran = true;
				},
				20,
			);

			await tick(150);
			expect(ran).toBe(false);

			await holder`select pg_advisory_unlock(${key}::bigint)`;
			holder.release();

			await pending;
			expect(ran).toBe(true);
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"returns the lock when it returns, so the next handler can hold it",
		async () => {
			const { workId } = await makeJobs();
			const key = PAGED_RENDER_LOCK_KEY_BASE + workId;

			await withPagedRenderLock(workId, async () => {}, 20);

			const next = await client.reserve();
			const [held] = await next`select pg_try_advisory_lock(${key}::bigint) as acquired`;
			expect(held.acquired).toBe(true);
			await next`select pg_advisory_unlock(${key}::bigint)`;
			next.release();
		},
		DB_SETUP_TIMEOUT,
	);
});

describe("the supersession check", () => {
	it(
		"settles an older job without rendering when a newer one is waiting",
		async () => {
			const { jobIds } = await makeJobs("pending", "pending");
			const [older, newer] = jobIds;

			// The Work has no source. A run that got past the check would throw from the
			// source read; a clean resolve therefore proves the page pass never began.
			await renderPaged({ jobId: older });

			const [row] = await db
				.select({ status: transcodingJobs.status })
				.from(transcodingJobs)
				.where(eq(transcodingJobs.id, older));
			expect(row.status).toBe("completed");

			// The newer job is untouched and is the one that will render.
			const [next] = await db
				.select({ status: transcodingJobs.status })
				.from(transcodingJobs)
				.where(eq(transcodingJobs.id, newer));
			expect(next.status).toBe("pending");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"carries a newer job's cancellation forward instead of resurrecting the work",
		async () => {
			const { jobIds } = await makeJobs("pending", "canceled");
			const older = jobIds[0];

			await renderPaged({ jobId: older });

			const [row] = await db
				.select({ status: transcodingJobs.status })
				.from(transcodingJobs)
				.where(eq(transcodingJobs.id, older));
			expect(row.status).toBe("canceled");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"lets an older job run when the newer one failed — this may be the only chance left",
		async () => {
			const { jobIds } = await makeJobs("pending", "failed");
			const older = jobIds[0];

			// No source on the Work: reaching the body throws, which is the proof that the
			// supersession check did NOT stop it.
			await expect(renderPaged({ jobId: older })).rejects.toThrow("No source file on this Work");
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"lets the newest job run, because nothing supersedes it",
		async () => {
			const { jobIds } = await makeJobs("pending");
			const only = jobIds[0];

			await expect(renderPaged({ jobId: only })).rejects.toThrow("No source file on this Work");
		},
		DB_SETUP_TIMEOUT,
	);
});
