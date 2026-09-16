// SPDX-License-Identifier: Apache-2.0
/**
 * What a DMCA complainant is sent, and that it goes to the complainant rather than the creator.
 *
 * 🚨 **The counter-notice copy is the one the safe harbor rests on.** § 512(g)(2)(B) conditions
 * restoring a Work on promptly giving the complainant a copy of the counter-notice and telling them
 * when the material comes back, so a restore with no copy sent is a restore the statute does not
 * protect. A comment saying a copy is sent is not a copy sent, which is why this file reads the
 * recipient of every send rather than trusting that one happened.
 *
 * Every assertion picks sends out by recipient. The creator is emailed about the same notice at
 * the same moment, so a complainant email that went to the creator instead would still be "an email
 * was sent" — the exact wrong answer these tests exist to refuse. `sendEmail` refuses to send under
 * the test runner, so it is spied on, and each test sets whether the provider accepted the message.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { dmcaNotices, moderationActions, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
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
const COMPLAINANT = `complainant-${id}@example.com`;

let creator: FixtureAccount;
let operator: AdminFixture;
const workIds: number[] = [];

beforeAll(async () => {
	creator = await createAccount(`dmca_mail_${id}`);
	operator = await createAdminFixture("dmca-mail");
}, DB_SETUP_TIMEOUT);

// Notices and the takedown's audit rows are `set null` on the Work by design, so deleting the
// Work leaves them; they are taken explicitly, before the Works they point at.
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

/** Every send, with the provider's answer fixed by the test. */
function spyOnSends(sent: boolean) {
	return spyOn(email, "sendEmail").mockImplementation(async () => ({
		sent,
		messageId: sent ? "EXAMPLE-message-id" : null,
	}));
}

type Send = { to: string; subject: string; html: string };
const sendsTo = (spy: ReturnType<typeof spyOnSends>, to: string): Send[] =>
	spy.mock.calls.map(([args]) => args as Send).filter((s) => s.to === to);

/** A released Work of the creator's, with a notice filed against it through the public route. */
async function fileNotice(): Promise<{ workId: number; noticeId: number }> {
	const work = await insertWork({ creatorId: creator.userId, type: "game", title: `Quest ${id}` });
	workIds.push(work.id);
	const res = await post("/api/dmca/notices", undefined, {
		workId: work.id,
		complainantName: "Copyright Holder",
		complainantEmail: COMPLAINANT,
		complainantAddress: "123 Main St, Anytown, US",
		complainantPhone: "555-0100",
		copyrightedWorkDescription: "My original game, 'Example Quest', released 2024.",
		infringingMaterialDescription: "The Work at this address is a copy of my game.",
		goodFaithStatement: "I have a good faith belief that the use is not authorized.",
		authorizationStatement: "The information is accurate and I am authorized to act.",
		fairUseConsidered: true,
	});
	expect(res.status).toBe(201);
	return { workId: work.id, noticeId: (await res.json()).noticeId };
}

async function noticeRow(noticeId: number) {
	const [row] = await db.select().from(dmcaNotices).where(eq(dmcaNotices.id, noticeId));
	return row;
}

describe("taking a Work down", () => {
	it("acknowledges the complainant, separately from what the creator is told", async () => {
		const { noticeId } = await fileNotice();
		const sends = spyOnSends(true);

		const res = await post(`/api/admin/dmca/${noticeId}/act`, operator.cookie, {});

		expect(res.status).toBe(200);
		expect((await res.json()).complainantNotified).toBe(true);
		const toComplainant = sendsTo(sends, COMPLAINANT);
		expect(toComplainant, "the complainant was not acknowledged, or was twice").toHaveLength(1);
		expect(toComplainant[0].subject).toContain(`#${noticeId}`);
		expect(toComplainant[0].html).toContain("has been removed");
		// The creator hears about the takedown through their own notice and nothing addressed to the
		// complainant: nothing sent to them names the notice the way the acknowledgment does.
		expect(sendsTo(sends, creator.email).some((s) => s.subject.includes(`#${noticeId}`))).toBe(
			false,
		);
		expect((await noticeRow(noticeId)).complainantNotifiedAt).not.toBeNull();
	});

	it("leaves the notice unstamped when the provider refuses the acknowledgment", async () => {
		const { noticeId } = await fileNotice();
		const sends = spyOnSends(false);

		const res = await post(`/api/admin/dmca/${noticeId}/act`, operator.cookie, {});

		expect(res.status).toBe(200);
		expect(sendsTo(sends, COMPLAINANT)).toHaveLength(1);
		expect((await res.json()).complainantNotified).toBe(false);
		expect((await noticeRow(noticeId)).complainantNotifiedAt).toBeNull();
	});
});

describe("rejecting a notice", () => {
	it("emails the complainant the operator's reason", async () => {
		const { noticeId } = await fileNotice();
		const sends = spyOnSends(true);
		const reason = "The notice does not identify which of your works is being copied.";

		const res = await post(`/api/admin/dmca/${noticeId}/reject`, operator.cookie, { note: reason });

		expect(res.status).toBe(200);
		const toComplainant = sendsTo(sends, COMPLAINANT);
		expect(toComplainant).toHaveLength(1);
		expect(toComplainant[0].html).toContain(reason);
		expect(sendsTo(sends, creator.email)).toHaveLength(0);
		expect((await noticeRow(noticeId)).complainantNotifiedAt).not.toBeNull();
	});

	it("refuses without a reason, because the complainant would be told nothing", async () => {
		const { noticeId } = await fileNotice();
		const sends = spyOnSends(true);

		const res = await post(`/api/admin/dmca/${noticeId}/reject`, operator.cookie, { note: "   " });

		expect(res.status).toBe(400);
		expect(sends).not.toHaveBeenCalled();
		expect((await noticeRow(noticeId)).status).toBe("received");
	});
});

describe("filing a counter-notice", () => {
	const counterNotice = {
		subscriberName: "Uploader Legal Name",
		subscriberAddress: "9 Elm Road\nSpringfield, US",
		subscriberPhone: "555-0199",
		jurisdictionConsent: "I consent to the jurisdiction of the federal district court.",
		goodFaithStatement: "I swear the material was removed by mistake.",
	};

	async function takenDown() {
		const filed = await fileNotice();
		spyOnSends(true);
		expect((await post(`/api/admin/dmca/${filed.noticeId}/act`, operator.cookie, {})).status).toBe(
			200,
		);
		mock.restore();
		return filed;
	}

	it("forwards a copy to the complainant with the restore window, and stamps it", async () => {
		const { noticeId } = await takenDown();
		const sends = spyOnSends(true);

		const res = await post(`/api/dmca/notices/${noticeId}/counter`, creator.cookie, counterNotice);

		expect(res.status).toBe(201);
		const toComplainant = sendsTo(sends, COMPLAINANT);
		expect(toComplainant, "no copy of the counter-notice went to the complainant").toHaveLength(1);
		const { html } = toComplainant[0];
		// The copy itself: the § 512(g)(3) elements as the creator filed them.
		expect(html).toContain("Uploader Legal Name");
		expect(html).toContain("9 Elm Road<br>Springfield, US");
		expect(html).toContain("555-0199");
		expect(html).toContain("I swear the material was removed by mistake.");
		expect(html).toContain("penalty of perjury");
		// And what § 512(g)(2)(B) says they must be told: when it comes back, and what stops it.
		expect(html).toContain("We will restore the material between");
		expect(html).toContain("court order");
		// The creator is not sent their own details back as though they were the complainant.
		expect(sendsTo(sends, creator.email)).toHaveLength(0);

		const row = await noticeRow(noticeId);
		expect(row.status).toBe("counter_noticed");
		expect(row.counterNoticeForwardedAt).not.toBeNull();
	});

	it("leaves the forward unstamped when the provider refuses it, so a person can see it did not go", async () => {
		const { noticeId } = await takenDown();
		const sends = spyOnSends(false);

		const res = await post(`/api/dmca/notices/${noticeId}/counter`, creator.cookie, counterNotice);

		expect(res.status).toBe(201);
		expect(sendsTo(sends, COMPLAINANT)).toHaveLength(1);
		const row = await noticeRow(noticeId);
		expect(row.status).toBe("counter_noticed");
		expect(row.counterNoticeForwardedAt).toBeNull();
	});
});
