// SPDX-License-Identifier: Apache-2.0
/**
 * A counter-noticed Work is never restored before the complainant has their copy of the
 * counter-notice.
 *
 * 🚨 **The two ways to be late are not equally costly, and this file pins which one Anthers picks.**
 * Restoring without the copy gives up § 512(g)(4)'s protection from infringement liability for the
 * restored material; restoring after the 14th business day gives up only § 512(g)(1)'s protection
 * from the creator's claims about the takedown. So an unsent copy holds the restore, the daily sweep
 * retries it, the operator is alerted when it fails and again as the 14th day nears, and a copy that
 * goes out late moves the restore so the complainant still gets the ten business days it promises.
 *
 * The sweep is exercised through `retryUnsentCounterNotices` with an explicit `now`, so "thirteen
 * business days later" is a date passed in rather than a clock waited on. `sendEmail` and
 * `sendOperationalAlert` are spied on, since the first refuses under the test runner and the second
 * only sends from a public deployment; each test decides what the provider says.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { dmcaNotices, moderationActions, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import {
	addBusinessDays,
	noticesReadyForRestore,
	retryUnsentCounterNotices,
} from "../services/dmca.js";
import * as email from "../services/email.js";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { type AdminFixture, createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);

let creator: FixtureAccount;
let operator: AdminFixture;
const workIds: number[] = [];

beforeAll(async () => {
	creator = await createAccount(`dmca_hold_${id}`);
	operator = await createAdminFixture("dmca-hold");
}, DB_SETUP_TIMEOUT);

// Notices and the takedown's audit rows are `set null` on the Work by design, so they go first.
afterAll(async () => {
	if (workIds.length === 0) return;
	await db.delete(dmcaNotices).where(inArray(dmcaNotices.workId, workIds));
	await db
		.delete(moderationActions)
		.where(
			and(eq(moderationActions.subjectType, "work"), inArray(moderationActions.subjectId, workIds)),
		);
	await db.delete(works).where(inArray(works.id, workIds));
});

afterEach(() => mock.restore());

function post(path: string, cookie: string | undefined, body: unknown) {
	const headers: Record<string, string> = { "Content-Type": "application/json", Origin: ORIGIN };
	if (cookie) headers.Cookie = cookie;
	return app.fetch(
		new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
	);
}

/** Every email, with the provider's answer fixed by the test. */
function spyOnSends(sent: boolean) {
	return spyOn(email, "sendEmail").mockImplementation(async () => ({
		sent,
		messageId: sent ? "EXAMPLE-message-id" : null,
	}));
}

/** Every operator alert, accepted. */
function spyOnAlerts() {
	return spyOn(email, "sendOperationalAlert").mockImplementation(async () => ({
		sent: true,
		messageId: "EXAMPLE-alert-id",
	}));
}

/**
 * The sends to one notice's complainant. Each notice gets its own address because the sweep retries
 * every unsent copy in the database, including ones earlier tests here left unsent.
 */
const sendsTo = (spy: ReturnType<typeof spyOnSends>, complainant: string) =>
	spy.mock.calls.map(([args]) => args).filter((args) => args.to === complainant);

const alertsAbout = (spy: ReturnType<typeof spyOnAlerts>, noticeId: number) =>
	spy.mock.calls.filter(([args]) => args.subject.includes(`#${noticeId}:`));

/**
 * A taken-down Work with a counter-notice filed against its notice, filed while the email provider
 * gave `copySent` as its answer.
 */
async function counterNoticed(copySent: boolean) {
	const work = await insertWork({ creatorId: creator.userId, type: "game", title: `Hold ${id}` });
	workIds.push(work.id);
	const complainant = `hold-${id}-${work.id}@example.com`;
	spyOnSends(true);
	const filed = await post("/api/dmca/notices", undefined, {
		workId: work.id,
		complainantName: "Copyright Holder",
		complainantEmail: complainant,
		complainantAddress: "123 Main St, Anytown, US",
		copyrightedWorkDescription: "My original game.",
		infringingMaterialDescription: "The Work at this address is a copy of it.",
		goodFaithStatement: "I have a good faith belief that the use is not authorized.",
		authorizationStatement: "The information is accurate and I am authorized to act.",
		fairUseConsidered: true,
	});
	const noticeId = (await filed.json()).noticeId as number;
	expect((await post(`/api/admin/dmca/${noticeId}/act`, operator.cookie, {})).status).toBe(200);
	mock.restore();

	const sends = spyOnSends(copySent);
	const alerts = spyOnAlerts();
	const res = await post(`/api/dmca/notices/${noticeId}/counter`, creator.cookie, {
		subscriberName: "Uploader Legal Name",
		subscriberAddress: "9 Elm Road, Springfield, US",
		subscriberPhone: "555-0199",
		jurisdictionConsent: "I consent to the jurisdiction of the federal district court.",
		goodFaithStatement: "I swear the material was removed by mistake.",
	});
	expect(res.status).toBe(201);
	const row = await noticeRow(noticeId);
	return { noticeId, complainant, filedAt: row.counterNoticeFiledAt as Date, sends, alerts };
}

async function noticeRow(noticeId: number) {
	const [row] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, noticeId));
	return row;
}

/** Move the restore date into the past, as though the ten business days had run out. */
async function restoreDateHasArrived(noticeId: number) {
	await db
		.update(dmcaNotices)
		.set({ restoreNoEarlierThan: new Date(Date.now() - 60_000) })
		.where(eq(dmcaNotices.id, noticeId));
}

describe("a counter-notice whose copy did not go", () => {
	it("alerts the operator at once", async () => {
		const { noticeId, alerts } = await counterNoticed(false);
		expect(alertsAbout(alerts, noticeId), "nobody was told the copy did not go").toHaveLength(1);
		expect((await noticeRow(noticeId)).counterNoticeForwardedAt).toBeNull();
	});

	it("is not restored when its restore date arrives", async () => {
		const { noticeId } = await counterNoticed(false);
		await restoreDateHasArrived(noticeId);

		const ready = await noticesReadyForRestore();
		expect(
			ready.some((n) => n.noticeId === noticeId),
			"restored without the copy",
		).toBe(false);
	});

	it("is restored once the copy has gone and the date arrives", async () => {
		const { noticeId } = await counterNoticed(true);
		await restoreDateHasArrived(noticeId);

		const ready = await noticesReadyForRestore();
		expect(ready.some((n) => n.noticeId === noticeId)).toBe(true);
	});
});

describe("the daily sweep", () => {
	it("sends a copy the provider now accepts, keeping the original date when it goes the same day", async () => {
		const { noticeId, complainant, filedAt } = await counterNoticed(false);
		mock.restore();
		const sends = spyOnSends(true);

		await retryUnsentCounterNotices(filedAt);

		expect(sendsTo(sends, complainant)).toHaveLength(1);
		const row = await noticeRow(noticeId);
		expect(row.counterNoticeForwardedAt).not.toBeNull();
		expect(row.restoreNoEarlierThan?.getTime()).toBe(addBusinessDays(filedAt, 10).getTime());
	});

	it("moves the restore so a late copy still gives the complainant ten business days", async () => {
		const { noticeId, complainant, filedAt } = await counterNoticed(false);
		mock.restore();
		const sends = spyOnSends(true);
		const late = addBusinessDays(filedAt, 6);

		await retryUnsentCounterNotices(late);

		const row = await noticeRow(noticeId);
		expect(row.restoreNoEarlierThan?.getTime()).toBe(addBusinessDays(late, 10).getTime());
		// And the copy says so, rather than quoting the window that has already partly passed.
		const [copy] = sendsTo(sends, complainant);
		const quoted = addBusinessDays(late, 10).toLocaleDateString("en-US", {
			year: "numeric",
			month: "long",
			day: "numeric",
			timeZone: "UTC",
		});
		expect(copy.html).toContain(`between ${quoted}`);
	});

	it("stays quiet while the 14th business day is still some way off", async () => {
		const { noticeId, filedAt } = await counterNoticed(false);
		mock.restore();
		spyOnSends(false);
		const alerts = spyOnAlerts();

		await retryUnsentCounterNotices(addBusinessDays(filedAt, 5));

		expect(alertsAbout(alerts, noticeId)).toHaveLength(0);
	});

	it("alerts again once the 14th business day is one business day away", async () => {
		const { noticeId, filedAt } = await counterNoticed(false);
		mock.restore();
		spyOnSends(false);
		const alerts = spyOnAlerts();

		await retryUnsentCounterNotices(addBusinessDays(filedAt, 13));

		expect(alertsAbout(alerts, noticeId)).toHaveLength(1);
		expect((await noticeRow(noticeId)).counterNoticeForwardedAt).toBeNull();
	});
});

describe("an operator settling an unsent copy", () => {
	it("can record a copy they emailed themselves, which sends nothing", async () => {
		const { noticeId, complainant } = await counterNoticed(false);
		mock.restore();
		const sends = spyOnSends(true);

		const res = await post(`/api/admin/dmca/${noticeId}/forward`, operator.cookie, {
			sentByHand: true,
		});

		expect(res.status).toBe(200);
		expect(sendsTo(sends, complainant)).toHaveLength(0);
		expect((await noticeRow(noticeId)).counterNoticeForwardedAt).not.toBeNull();
	});

	it("can send it again, and hears plainly when the provider refuses a second time", async () => {
		const { noticeId } = await counterNoticed(false);

		const refused = await post(`/api/admin/dmca/${noticeId}/forward`, operator.cookie, {});
		expect(refused.status).toBe(502);
		expect((await refused.json()).code).toBe("not_sent");

		mock.restore();
		spyOnSends(true);
		const sent = await post(`/api/admin/dmca/${noticeId}/forward`, operator.cookie, {});
		expect(sent.status).toBe(200);

		const again = await post(`/api/admin/dmca/${noticeId}/forward`, operator.cookie, {});
		expect(again.status).toBe(409);
		expect((await again.json()).code).toBe("already_forwarded");
	});
});
