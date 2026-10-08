// SPDX-License-Identifier: Apache-2.0
/**
 * The Noun Project spend guards — the budget, the breaker and the blocklist — proved
 * against a live test-session database, because these are the rules whose failure
 * direction is money.
 *
 * 🚨 **The suite that proves the budget must never itself spend an icon call**: every
 * vendor interaction in this file is with the blocklist and the counters directly, and
 * the vendor-fetch stub answers searches without a real request.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { nounBlocklist, nounSpend } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { addToBlocklist, filterBlockedIcons, queryRefused } from "../services/noun-blocklist";
import {
	breakerAllows,
	budgetRefusal,
	checkBudget,
	DAILY_ICON_BUDGET,
	DAILY_SERVICE_BUDGET,
	recordSpend,
	spendToday,
} from "../services/noun-budget";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
let creatorId = 0;
let adminId = 0;

beforeAll(async () => {
	const creator = await createAccount(`nb_creator_${RUN}`);
	creatorId = creator.userId;
	const admin = await createAccount(`nb_admin_${RUN}`);
	adminId = admin.userId;
}, DB_SETUP_TIMEOUT);

// Every row this suite writes is taken back, on success or failure — the counters are
// per-creator rows, and the blocklist rows are named values this suite invented.
afterAll(async () => {
	await db.delete(nounSpend).where(eq(nounSpend.creatorId, creatorId));
	await db.delete(nounBlocklist).where(sql`${nounBlocklist.value} like ${"nb-test-%"}`);
});

describe("the per-creator daily budget", () => {
	it("answers a fresh creator within budget", async () => {
		const verdict = await checkBudget(creatorId, "icon");
		expect(verdict.ok).toBe(true);
		expect(verdict.iconCalls).toBe(0);
	});

	it("counts spends and refuses past the limit, degrading rather than erroring", async () => {
		for (let i = 0; i < DAILY_ICON_BUDGET; i++) await recordSpend(creatorId, "icon");
		const verdict = await checkBudget(creatorId, "icon");
		expect(verdict.ok).toBe(false);
		expect(verdict.iconCalls).toBe(DAILY_ICON_BUDGET);
		// The refusal is structured — the picker states it, the page does not break.
		const refusal = budgetRefusal(verdict, false);
		expect(refusal.code).toBe("budget_exhausted");
		expect(refusal.iconBudget).toBe(DAILY_ICON_BUDGET);
	});

	it("bounds the classes separately — service calls still work at the icon limit", async () => {
		const verdict = await checkBudget(creatorId, "service");
		expect(verdict.ok).toBe(true);
		expect(verdict.serviceBudget).toBe(DAILY_SERVICE_BUDGET);
	});

	it("records a service spend without disturbing the icon counter", async () => {
		const before = await spendToday(creatorId);
		await recordSpend(creatorId, "service");
		const after = await spendToday(creatorId);
		expect(after.serviceCalls).toBe(before.serviceCalls + 1);
		expect(after.iconCalls).toBe(before.iconCalls);
	});
});

describe("the circuit breaker", () => {
	it("is inert with no cap configured (the development posture)", async () => {
		const prior = process.env.NOUN_PROJECT_MONTHLY_CAP_USD;
		delete process.env.NOUN_PROJECT_MONTHLY_CAP_USD;
		try {
			expect(await breakerAllows("icon")).toBe(true);
		} finally {
			if (prior !== undefined) process.env.NOUN_PROJECT_MONTHLY_CAP_USD = prior;
		}
	});

	it("degrades at 90% of the configured cap, with headroom before the wall", async () => {
		const prior = process.env.NOUN_PROJECT_MONTHLY_CAP_USD;
		// Cap $1: one icon call (9.5¢) plus this suite's recorded service spend must
		// still fit; a cap of one cent must not.
		process.env.NOUN_PROJECT_MONTHLY_CAP_USD = "1";
		try {
			expect(await breakerAllows("icon")).toBe(true);
			process.env.NOUN_PROJECT_MONTHLY_CAP_USD = "0.01";
			expect(await breakerAllows("icon")).toBe(false);
		} finally {
			if (prior !== undefined) process.env.NOUN_PROJECT_MONTHLY_CAP_USD = prior;
			else delete process.env.NOUN_PROJECT_MONTHLY_CAP_USD;
		}
	});

	it("estimates the month from every creator's recorded spend", async () => {
		const spend = await import("../services/noun-budget").then((m) => m.monthSpendEstimate());
		// At least this suite's own recorded icon calls are in the month's estimate.
		expect(spend).toBeGreaterThan(0);
	});
});

describe("the blocklist", () => {
	it("🚨 refuses a query carrying a blocklisted term — before any vendor call", async () => {
		await addToBlocklist({
			kind: "term",
			value: "nb-test-forbidden",
			reason: "test fixture",
			addedBy: adminId,
		});
		expect(await queryRefused("nb-test-forbidden")).toBe(true);
		expect(await queryRefused("a nb-test-forbidden phrase")).toBe(true);
		expect(await queryRefused("wildflower")).toBe(false);
	});

	it("matches case-insensitively and normalizes whitespace", async () => {
		expect(await queryRefused("NB-TEST-FORBIDDEN")).toBe(true);
		expect(await queryRefused("  nb-test-forbidden  ")).toBe(true);
	});

	it("refuses an empty query as not-refused", async () => {
		expect(await queryRefused("")).toBe(false);
	});

	it("filters blocked icons and icons carrying a blocked collection from results", async () => {
		await addToBlocklist({
			kind: "icon",
			value: "nb-test-icon-1",
			reason: "test",
			addedBy: adminId,
		});
		await addToBlocklist({
			kind: "collection",
			value: "nb-test-coll-1",
			reason: "test",
			addedBy: adminId,
		});
		const filtered = await filterBlockedIcons([
			{ id: "nb-test-icon-1" },
			{ id: "keep-me", collections: [{ id: "nb-test-coll-1" }] },
			{ id: "also-keep", collections: [{ id: "fine" }] },
		]);
		expect(filtered.map((i) => String(i.id))).toEqual(["also-keep"]);
	});

	it("keeps a blocklist entry idempotent across a double add", async () => {
		await addToBlocklist({
			kind: "term",
			value: "nb-test-forbidden",
			reason: "again",
			addedBy: adminId,
		});
		const rows = await db
			.select()
			.from(nounBlocklist)
			.where(and(eq(nounBlocklist.kind, "term"), eq(nounBlocklist.value, "nb-test-forbidden")));
		expect(rows.length).toBe(1);
	});
});
