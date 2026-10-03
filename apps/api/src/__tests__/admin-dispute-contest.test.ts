// SPDX-License-Identifier: Apache-2.0
/**
 * The contest action — the deliberate exception to the never-contest default
 * (Parker, 2026-09-15), from its one door (the admin route) to its one record
 * (the disputes row).
 *
 * What is worth pinning here, because every one of these fails silently or
 * costs real money:
 *
 *   • the guards, each with its own words — a closed dispute, a past-deadline
 *     one, and a second submission on an already-contested one are all refused,
 *     and the once-rule is Visa's own CE3.0 constraint, not ours;
 *   • the submission actually reaches Stripe with `submit: true` (a staged
 *     submission would read as contested while nothing reached the bank) and
 *     exactly the evidence the person assembled — no more, no less;
 *   • the record — who contested, when, and the evidence verbatim, written only
 *     after Stripe accepts;
 *   • nothing automatic — the route is the only caller, so the gate tests here
 *     (401 without a session, 401 an Anthers account, 404 off the admin host)
 *     are the whole "can anything else reach it" story.
 *
 * The Stripe client is a recording fake (`setStripeClient`), the same seam
 * `refunds.test.ts` uses — no network, and every assertion about what we sent
 * reads the fake's call log.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { disputes, purchases, users, works } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

// 🚨 Naming `ADMIN_URL` is what makes the wrong-host refusal real here — with it
// unset the admin host falls back to "any host in a checkout", so nothing can 404.
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `dpc_cr_${run}`;
const buyerName = `dpc_buy_${run}`;

const DAY_MS = 86_400_000;
const FAKE_KEY = "sk_test_fake_no_network";

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// ── The fake Stripe client ───────────────────────────────────────────────────

interface Call {
	method: string;
	args: unknown[];
}

function fakeStripe() {
	const calls: Call[] = [];
	const real = new Stripe(FAKE_KEY);

	const record =
		(method: string, fallback: (...args: never[]) => unknown) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return Promise.resolve((fallback as (...a: unknown[]) => unknown)(...args));
		};

	const client = {
		webhooks: real.webhooks,
		disputes: {
			// The read-back mirrors what Stripe reports after a submission: the dispute
			// moves from `needs_response` to `under_review`.
			update: record("disputes.update", () => ({
				id: `dp_${uid()}`,
				object: "dispute",
				status: "under_review",
			})),
			retrieve: record("disputes.retrieve", () => ({
				id: `dp_${uid()}`,
				object: "dispute",
				status: "under_review",
			})),
		},
	} as unknown as Stripe;

	return {
		client,
		calls,
		callsTo: (method: string) => calls.filter((c) => c.method === method),
	};
}

type Fake = ReturnType<typeof fakeStripe>;

// ── Fixtures ────────────────────────────────────────────────────────────────

let fake: Fake;
let realClient: unknown;
let adminCookie: string;
let plainCookie: string;
let creatorId: number;
let buyerId: number;
let workId: number;
/** The highest `disputes.id` before this suite ran — everything above is ours to take. */
let disputeWater = 0;
const fixtureDisputeIds: number[] = [];
const fixturePurchaseIds: number[] = [];
const accountIds: number[] = [];

const EVIDENCE = {
	product_description: "A digital purchase: the Work, permanently.",
	service_date: "October 2, 2026",
};

// A POST through the admin gate needs the admin origin (`adminHostOnly` is the CSRF
// check for everything that changes state), so every contest request carries it.
const CONTEST_HEADERS = {
	"Content-Type": "application/json",
	Origin: ADMIN_HOST,
};

async function contest(id: number, evidence: unknown = EVIDENCE) {
	return req(`/api/admin/disputes/${id}/contest`, {
		method: "POST",
		headers: { ...CONTEST_HEADERS, Cookie: adminCookie },
		body: JSON.stringify(evidence),
	});
}

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("dispute-contest")).cookie;

	const creator = await createAccount(creatorName);
	const buyer = await createAccount(buyerName);
	accountIds.push(creator.userId, buyer.userId);
	creatorId = creator.userId;
	buyerId = buyer.userId;
	plainCookie = buyer.cookie;

	const work = await insertWork({
		creatorId,
		type: "game",
		title: `Dispute contest work ${run}`,
		streamEnabled: false,
		downloadEnabled: true,
		seedAccess: [],
	});
	workId = work.id;

	const [tallest] = await db
		.select({ id: disputes.id })
		.from(disputes)
		.orderBy(sql`${disputes.id} DESC`)
		.limit(1);
	disputeWater = tallest?.id ?? 0;

	realClient = getStripe();
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	// The fake never outlives the suite.
	setStripeClient(null);
	if (realClient !== null && realClient !== undefined) {
		setStripeClient(realClient as never);
	}

	// The dispute rows are swept by high-water mark first — `disputes.user_id` and the
	// new `contested_by_admin_id` are both `set null`, so purging the account would
	// orphan them, the same shape `admin-disputes.test.ts` uses.
	if (fixtureDisputeIds.length > 0) {
		await db.delete(disputes).where(inArray(disputes.id, fixtureDisputeIds));
	}
	const strays = await db
		.select({ id: disputes.id })
		.from(disputes)
		.where(sql`${disputes.id} > ${disputeWater}`);
	if (strays.length > 0) {
		await db.delete(disputes).where(
			sql`${disputes.id} IN (${sql.join(
				strays.map((d) => sql`${d.id}`),
				sql`, `,
			)})`,
		);
	}
	await db.delete(purchases).where(inArray(purchases.id, fixturePurchaseIds));
	await db.delete(works).where(eq(works.id, workId));
	await db.delete(users).where(inArray(users.id, accountIds));
});

/** A dispute row, shaped the way `recordDisputeCreated` writes it. */
async function dispute(
	opts: {
		status?: string;
		outcome?: string | null;
		evidenceDueBy?: Date | null;
		contestedAt?: Date | null;
	} = {},
) {
	const [row] = await db
		.insert(disputes)
		.values({
			stripeDisputeId: `dp_dpc_${uid()}`,
			stripeChargeId: `ch_dpc_${uid()}`,
			stripePaymentIntentId: `pi_dpc_${uid()}`,
			amount: "5.00",
			currency: "usd",
			reason: "fraudulent",
			status: opts.status ?? "needs_response",
			purchaseId: null,
			invoiceId: null,
			userId: buyerId,
			evidenceDueBy:
				opts.evidenceDueBy === undefined ? new Date(Date.now() + 10 * DAY_MS) : opts.evidenceDueBy,
			outcome: opts.outcome ?? null,
			contestedAt: opts.contestedAt ?? null,
		})
		.returning({ id: disputes.id });
	fixtureDisputeIds.push(row.id);
	return row;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /api/admin/disputes/:id/contest — the gate", () => {
	it("401s with no session", async () => {
		const d = await dispute();
		const res = await req(`/api/admin/disputes/${d.id}/contest`, {
			method: "POST",
			headers: CONTEST_HEADERS,
			body: JSON.stringify(EVIDENCE),
		});
		expect(res.status).toBe(401);
	});

	it("401s a signed-in Anthers account", async () => {
		const d = await dispute();
		const res = await req(`/api/admin/disputes/${d.id}/contest`, {
			method: "POST",
			headers: { ...CONTEST_HEADERS, Cookie: plainCookie },
			body: JSON.stringify(EVIDENCE),
		});
		expect(res.status).toBe(401);
	});

	it("403s a POST without the admin origin — the CSRF check", async () => {
		const d = await dispute();
		const res = await req(`/api/admin/disputes/${d.id}/contest`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "http://anthers.test" },
			body: JSON.stringify(EVIDENCE),
		});
		expect(res.status).toBe(403);
	});

	it("404s off the admin host", async () => {
		const d = await dispute();
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/disputes/${d.id}/contest`, {
				method: "POST",
				headers: { ...CONTEST_HEADERS },
				body: JSON.stringify(EVIDENCE),
			}),
		);
		expect(res.status).toBe(404);
	});
});

describe("POST /api/admin/disputes/:id/contest — the submission", () => {
	beforeAll(() => {
		fake = fakeStripe();
		setStripeClient(fake.client);
	});

	it("submits the assembled evidence to Stripe with submit: true, and records the act", async () => {
		const d = await dispute();
		const res = await contest(d.id);
		expect(res.status).toBe(200);

		// What reached Stripe: the evidence exactly as assembled, submitted to the bank
		// rather than staged.
		const sent = fake.callsTo("disputes.update");
		expect(sent.length).toBe(1);
		const [disputeId, params] = sent[0].args as [string, { evidence: object; submit: boolean }];
		expect(disputeId).toBe(
			(await db.select().from(disputes).where(eq(disputes.id, d.id)))[0].stripeDisputeId,
		);
		expect(params.submit).toBe(true);
		expect(params.evidence).toEqual(EVIDENCE);

		// The record: the act is on the row, with the evidence verbatim and the admin
		// who chose it. The status is Stripe's own read-back word, verbatim as ever.
		const [row] = await db.select().from(disputes).where(eq(disputes.id, d.id));
		expect(row.contestedAt).not.toBeNull();
		expect(row.contestedByAdminId).not.toBeNull();
		expect(row.contestedEvidence).toEqual(EVIDENCE);
		expect(row.status).toBe("under_review");

		// The route answers with the list's own shape, so the row the admin app re-renders
		// carries who contested it.
		const body = (await res.json()) as { dispute: { contestedBy: { id: number } | null } };
		expect(body.dispute.contestedBy?.id).toBe(row.contestedByAdminId ?? undefined);
	});

	it("refuses a second submission on an already-contested dispute — Visa's once-rule", async () => {
		const before = fake.callsTo("disputes.update").length;
		const d = await dispute();
		const first = await contest(d.id);
		expect(first.status).toBe(200);
		const second = await contest(d.id);
		expect(second.status).toBe(409);
		const body = (await second.json()) as { code: string };
		expect(body.code).toBe("already_contested");

		// One submission reached Stripe, not two — the once-rule is held before the
		// processor call, not by Stripe refusing the second.
		expect(fake.callsTo("disputes.update").length - before).toBe(1);
	});

	it("refuses a closed dispute", async () => {
		const before = fake.callsTo("disputes.update").length;
		const d = await dispute({ status: "lost", outcome: "lost", evidenceDueBy: null });
		const res = await contest(d.id);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("closed");
		expect(fake.callsTo("disputes.update").length - before).toBe(0);

		// And the closed row was not marked contested by the refusal.
		const [row] = await db.select().from(disputes).where(eq(disputes.id, d.id));
		expect(row.contestedAt).toBeNull();
	});

	it("refuses a past-deadline dispute", async () => {
		const before = fake.callsTo("disputes.update").length;
		const d = await dispute({ evidenceDueBy: new Date(Date.now() - DAY_MS) });
		const res = await contest(d.id);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("past_deadline");
		expect(fake.callsTo("disputes.update").length - before).toBe(0);
	});

	it("refuses a dispute with no evidence window (warning_* carries none)", async () => {
		const d = await dispute({ status: "warning_needs_response", evidenceDueBy: null });
		const res = await contest(d.id);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("past_deadline");
	});

	it("refuses when payments are unconfigured, without marking the row contested", async () => {
		const d = await dispute();
		setStripeClient(null);
		try {
			const res = await contest(d.id);
			expect(res.status).toBe(503);
			const [row] = await db.select().from(disputes).where(eq(disputes.id, d.id));
			expect(row.contestedAt).toBeNull();
		} finally {
			setStripeClient(fake.client);
		}
	});

	it("404s a dispute that does not exist", async () => {
		const res = await contest(99_999_999);
		expect(res.status).toBe(404);
	});

	it("refuses an empty product description", async () => {
		const d = await dispute();
		const res = await contest(d.id, { product_description: "" });
		expect(res.status).toBe(400);
	});
});
