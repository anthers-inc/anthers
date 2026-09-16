// SPDX-License-Identifier: Apache-2.0
/**
 * Each operator action on a DMCA notice refuses a notice whose status does not allow it.
 *
 * 🚨 **The admin app offering each button only where it applies is not the rule.** It is one client's
 * courtesy, and without these refusals the API would reject a notice whose Work was already down and
 * leave the Work down, take a Work down on a notice it had rejected, or restore a Work nothing had
 * removed. Every disallowed pair is asserted, generated from the table below rather than from the
 * service's own, so widening what an action accepts has to be done in two places on purpose.
 *
 * A notice is put into each status directly rather than walked there through the actions, because
 * the walk is exactly what is under test. The Work's own state is asserted unchanged after every
 * refusal, since a refusal that still moved the Work would be the bug with a 409 on top.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { type DmcaNoticeStatus, dmcaNotices, moderationActions, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);

const STATUSES: DmcaNoticeStatus[] = [
	"received",
	"actioned",
	"counter_noticed",
	"restored",
	"rejected",
];

/** What each action may start from. Kept here rather than imported — see the file comment. */
const ALLOWED: Record<"act" | "reject" | "restore" | "suit", DmcaNoticeStatus[]> = {
	act: ["received"],
	reject: ["received"],
	restore: ["actioned", "counter_noticed"],
	suit: ["counter_noticed"],
};

let creatorId: number;
let adminCookie: string;
const workIds: number[] = [];
const noticeIds: number[] = [];

beforeAll(async () => {
	creatorId = (await createAccount(`dmca_status_${id}`)).userId;
	adminCookie = (await createAdminFixture("dmca-status")).cookie;
}, DB_SETUP_TIMEOUT);

// Notices and audit rows are `set null` on the Work by design, so they are taken explicitly.
afterAll(async () => {
	if (noticeIds.length > 0) await db.delete(dmcaNotices).where(inArray(dmcaNotices.id, noticeIds));
	if (workIds.length > 0) {
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "work"),
					inArray(moderationActions.subjectId, workIds),
				),
			);
		await db.delete(works).where(inArray(works.id, workIds));
	}
});

/** A Work and a notice against it, in `status`, with the Work down exactly when the status says so. */
async function noticeIn(status: DmcaNoticeStatus, extra: { suitFiledAt?: Date } = {}) {
	const down = status === "actioned" || status === "counter_noticed";
	const work = await insertWork({ creatorId, type: "game", title: `Status ${status} ${id}` });
	workIds.push(work.id);
	if (down)
		await db.update(works).set({ takedownStatus: "taken_down" }).where(eq(works.id, work.id));
	const [notice] = await db
		.insert(dmcaNotices)
		.values({
			workId: work.id,
			workTitle: work.title ?? "",
			complainantName: "Copyright Holder",
			complainantEmail: `status-${id}@example.com`,
			complainantAddress: "123 Main St, Anytown, US",
			copyrightedWorkDescription: "An original game.",
			infringingMaterialDescription: "A copy of it.",
			goodFaithStatement: "Not authorized.",
			authorizationStatement: "Authorized to act.",
			fairUseConsidered: true,
			attestationTextSnapshot: "EXAMPLE attestation",
			status,
			...extra,
		})
		.returning({ id: dmcaNotices.id });
	noticeIds.push(notice.id);
	return { noticeId: notice.id, workId: work.id, workWas: down ? "taken_down" : "active" };
}

function post(action: string, noticeId: number, body: Record<string, unknown> = {}) {
	return app.fetch(
		new Request(`http://localhost/api/admin/dmca/${noticeId}/${action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: adminCookie },
			body: JSON.stringify(body),
		}),
	);
}

async function state(noticeId: number, workId: number) {
	const [notice] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, noticeId));
	const [work] = await db
		.select({ takedownStatus: works.takedownStatus })
		.from(works)
		.where(eq(works.id, workId));
	return { status: notice.status, suitFiledAt: notice.suitFiledAt, work: work.takedownStatus };
}

describe("an operator action on a notice its status does not allow", () => {
	for (const [action, allowed] of Object.entries(ALLOWED)) {
		for (const status of STATUSES.filter((s) => !allowed.includes(s))) {
			it(`${action} refuses a ${status} notice, and changes nothing`, async () => {
				const { noticeId, workId, workWas } = await noticeIn(status);
				// A reject needs its reason, or the refusal below would be the reason's rather than the status's.
				const res = await post(
					action,
					noticeId,
					action === "reject" ? { note: "Lacks a signature." } : {},
				);

				expect(res.status).toBe(409);
				const body = await res.json();
				expect(body.code).toBe("notice_status");
				expect(body.noticeStatus).toBe(status);
				expect(await state(noticeId, workId)).toEqual({ status, suitFiledAt: null, work: workWas });
			});
		}
	}
});

describe("a recorded suit", () => {
	it("refuses a restore unless the operator overrides it on purpose", async () => {
		const suitFiledAt = new Date();
		const { noticeId, workId } = await noticeIn("counter_noticed", { suitFiledAt });

		const refused = await post("restore", noticeId, {});
		expect(refused.status).toBe(409);
		expect((await refused.json()).code).toBe("suit_recorded");
		expect((await state(noticeId, workId)).work).toBe("taken_down");

		const overridden = await post("restore", noticeId, { overrideSuit: true });
		expect(overridden.status).toBe(200);
		expect(await state(noticeId, workId)).toMatchObject({ status: "restored", work: "active" });
	});

	it("cannot be recorded twice, which would move the date the restore was stopped", async () => {
		const suitFiledAt = new Date(Date.now() - 86_400_000);
		const { noticeId, workId } = await noticeIn("counter_noticed", { suitFiledAt });

		const res = await post("suit", noticeId);

		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("suit_already_recorded");
		expect((await state(noticeId, workId)).suitFiledAt?.getTime()).toBe(suitFiledAt.getTime());
	});
});

describe("the operator queue", () => {
	it("lists notices in lifecycle order, with the ones waiting for a decision first", async () => {
		// Created in reverse, so creation order cannot pass for lifecycle order.
		const mine: number[] = [];
		for (const status of [...STATUSES].reverse()) mine.push((await noticeIn(status)).noticeId);

		const res = await app.fetch(
			new Request("http://localhost/api/admin/dmca", { headers: { Cookie: adminCookie } }),
		);
		expect(res.status).toBe(200);
		const { items } = (await res.json()) as { items: { id: number; status: string }[] };
		const statuses = items.filter((item) => mine.includes(item.id)).map((item) => item.status);
		expect(statuses).toEqual(STATUSES);
	});
});
