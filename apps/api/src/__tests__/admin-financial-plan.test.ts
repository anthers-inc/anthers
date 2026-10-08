// SPDX-License-Identifier: Apache-2.0
/**
 * The financial-plan routes — the admin tool's HTTP surface, proved end to end.
 *
 * The properties pinned:
 *
 * 1. **The gate holds**: no session → 401, and the whole surface 404s off the admin host
 *    (the same pins as `admin-books-forecast.test.ts`).
 * 2. **Reads carry inputs plus computed ledgers** — the conservation property at the HTTP
 *    boundary, not only in the service.
 * 3. **Writes accept inputs only; computed values restate from them** — a PUT that edited
 *    accounts restates the ledger on the next read.
 * 4. **Create appends in phase order; delete removes** — the tool's table lifecycle.
 *
 * The plan tables are wiped around each test; nothing else's rows are touched (the
 * tables are this feature's alone).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { financialPlanPhases, financialPlanSettings } from "@anthers/db/schema";
import app from "../index";
import { createAdminFixture } from "./admin-fixture";
import { purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}/api/admin${path}`, options));
}

let adminCookie: string;

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;
	adminCookie = (await createAdminFixture("finplan")).cookie;
	// Start the plan from a known state: defaults seed on first read.
	await db.delete(financialPlanPhases);
	await db.delete(financialPlanSettings);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	process.env.ADMIN_URL = savedAdminUrl;
	await db.delete(financialPlanPhases);
	await db.delete(financialPlanSettings);
});

function get(path: string) {
	return req(path, { headers: { cookie: adminCookie } });
}

async function put(path: string, body: unknown) {
	return req(path, {
		method: "PUT",
		headers: {
			cookie: adminCookie,
			"content-type": "application/json",
			// A mutation passes adminHostOnly's origin check, which in this suite reads the
			// ADMIN_URL the beforeAll sets.
			Origin: ADMIN_HOST,
		},
		body: JSON.stringify(body),
	});
}

interface PhasePayload {
	id: number;
	phase: number;
	label: string;
	accounts: number;
	ledger: {
		charitableRevenue: number;
		adminBudget: number;
		fund: number;
		freeStorage: number;
		programs: number;
		solvent: boolean;
	};
}

describe("the financial-plan routes", () => {
	it("refuses without a session", async () => {
		const res = await req("/financial-plan");
		expect(res.status).toBe(401);
	});

	it("404s off the admin host", async () => {
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/financial-plan`, { headers: { cookie: adminCookie } }),
		);
		expect(res.status).toBe(404);
	});

	it("reads the seeded plan with ledgers that conserve", async () => {
		const res = await get("/financial-plan");
		expect(res.status).toBe(200);
		const { settings, phases } = (await res.json()) as {
			settings: { adminBudgetShare: number; fundShare: number };
			phases: PhasePayload[];
		};
		expect(settings.adminBudgetShare).toBeCloseTo(0.3, 6);
		expect(settings.fundShare).toBeCloseTo(0.1, 6);
		expect(phases.length).toBeGreaterThanOrEqual(9);
		for (const p of phases) {
			const L = p.ledger;
			expect(L.adminBudget + L.fund + L.freeStorage + L.programs).toBeCloseTo(
				L.charitableRevenue,
				6,
			);
			expect(L.solvent).toBe(true);
		}
	});

	it("a PUT to one phase restates its ledger on the next read", async () => {
		const read1 = (await (await get("/financial-plan")).json()) as { phases: PhasePayload[] };
		const target = read1.phases[0];
		const accounts = target.accounts + 5_000;
		const res = await put(`/financial-plan/phases/${target.id}`, { accounts });
		expect(res.status).toBe(200);
		const read2 = (await (await get("/financial-plan")).json()) as { phases: PhasePayload[] };
		const edited = read2.phases.find((p) => p.id === target.id)!;
		expect(edited.accounts).toBe(accounts);
		// Revenue moved with the edited input, computed, never stored.
		expect(edited.ledger.charitableRevenue).toBeGreaterThan(target.ledger.charitableRevenue);
	});

	it("create appends after the last phase; delete removes it", async () => {
		const before = (await (await get("/financial-plan")).json()) as { phases: PhasePayload[] };
		const res = await req("/financial-plan/phases", {
			method: "POST",
			headers: {
				cookie: adminCookie,
				"content-type": "application/json",
				Origin: ADMIN_HOST,
			},
			body: JSON.stringify({
				label: "Route test phase",
				accounts: 5_000,
				payingShare: 0.3,
				staff: 0,
				tooling: 0,
				services: 0,
			}),
		});
		expect(res.status).toBe(201);
		const created = (await res.json()) as { id: number };
		const after = (await (await get("/financial-plan")).json()) as { phases: PhasePayload[] };
		expect(after.phases.length).toBe(before.phases.length + 1);
		expect(after.phases.at(-1)?.label).toBe("Route test phase");

		const del = await req(`/financial-plan/phases/${created.id}`, {
			method: "DELETE",
			headers: { cookie: adminCookie, Origin: ADMIN_HOST },
		});
		expect(del.status).toBe(200);
		const final = (await (await get("/financial-plan")).json()) as { phases: PhasePayload[] };
		expect(final.phases.length).toBe(before.phases.length);
	});

	it("settings PUT changes the fund share the ledgers read", async () => {
		const res = await put("/financial-plan/settings", { fundShare: 0.2 });
		expect(res.status).toBe(200);
		const { settings, phases } = (await (await get("/financial-plan")).json()) as {
			settings: { fundShare: number };
			phases: PhasePayload[];
		};
		expect(settings.fundShare).toBeCloseTo(0.2, 6);
		for (const p of phases) {
			// Defaults carry no override, so every ledger restates beside the new share.
			expect(p.ledger.fund / p.ledger.charitableRevenue).toBeCloseTo(0.2 * 0.7, 2);
		}
	});
});
