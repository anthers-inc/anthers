// SPDX-License-Identifier: Apache-2.0
/**
 * The resource view's endpoint — the gate, the honest empty state, and the render from
 * seeded snapshots.
 *
 * Pinned here:
 *
 * 1. **The gate holds the way every admin surface's does**: no session → 401, a signed-in
 *    Anthers account → 401, and the whole route 404s off the admin host.
 * 2. **No snapshots is a rendered empty state, not a fabricated one.** `hasSnapshots` is
 *    false, the response names `make resource-snapshot`, and every component still appears
 *    with `null` size and count — an invented shape from the committed spec would be the
 *    exact drift this view exists to replace.
 * 3. **Snapshots render from the rows**: the latest row's size and count become the
 *    component's current shape, and the trend series is newest-first with the metrics
 *    each row carried.
 * 4. **A component the snapshot script has never covered still renders its card**, with
 *    the static sites carrying empty signals and their why-note.
 *
 * The snapshots this suite writes are its own (taken far in the past, under a distinct
 * component set from any real run), and they are deleted in `afterAll` on success or failure.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { resourceSnapshots } from "@anthers/db/schema";
import { lt } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

/**
 * 🚨 **Naming `ADMIN_URL` is what makes the wrong-host refusal real here.** With it unset the
 * admin host falls back to "any host in a checkout" (`isAdminHost`), so nothing can 404 — the
 * same reason `admin-books.test.ts` pins it before asserting host behavior.
 */
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

interface TrendPoint {
	takenAt: string;
	cpuPct: number | null;
	memoryPct: number | null;
	restartCount: number | null;
}

interface ComponentView {
	component: string;
	kind: string;
	note: string;
	bands: Array<{
		signal: string;
		soonAt: number;
		nowAt: number;
		remedy: string;
		precondition: string | null;
	}>;
	instanceSize: string | null;
	instanceCount: number | null;
	snapshottedAt: string | null;
	latest: {
		cpuPct: number | null;
		memoryPct: number | null;
		restartCount: number | null;
		notes: string;
	} | null;
	trend: TrendPoint[];
}

interface ResourcesBody {
	hasSnapshots: boolean;
	howToSnapshot: string;
	components: ComponentView[];
	spendNote: string;
}

let adminCookie: string;
let plainCookie: string;

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("resources")).cookie;
	plainCookie = (await createAccount(`resources_visitor_${crypto.randomUUID().slice(0, 8)}`))
		.cookie;
}, DB_SETUP_TIMEOUT);

/** A snapshot row this suite owns, dated under its own epoch so the sweep cannot miss it. */
async function insertSnapshot(opts: {
	component: string;
	takenAt: Date;
	instanceSize?: string | null;
	instanceCount?: number | null;
	cpuPct?: number | null;
	memoryPct?: number | null;
	restartCount?: number | null;
	notes?: string;
}) {
	await db.insert(resourceSnapshots).values({
		takenAt: opts.takenAt,
		component: opts.component,
		instanceSize: opts.instanceSize ?? null,
		instanceCount: opts.instanceCount ?? null,
		cpuPct: opts.cpuPct ?? null,
		memoryPct: opts.memoryPct ?? null,
		restartCount: opts.restartCount ?? null,
		notes: opts.notes ?? "",
	});
}

async function resources(): Promise<ResourcesBody> {
	const res = await req("/api/admin/infrastructure/resources", {
		headers: { Cookie: adminCookie },
	});
	expect(res.status).toBe(200);
	return (await res.json()) as ResourcesBody;
}

describe("The admin resource view's gate", () => {
	it("rejects unauthenticated requests with 401", async () => {
		expect((await req("/api/admin/infrastructure/resources")).status).toBe(401);
	});

	it("refuses a signed-in Anthers account, whose session cookie is not an admin session", async () => {
		const res = await req("/api/admin/infrastructure/resources", {
			headers: { Cookie: plainCookie },
		});
		expect(res.status).toBe(401);
	});

	it("does not advertise the surface off the admin host (404, not 401)", async () => {
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/infrastructure/resources`, {
				headers: { Cookie: adminCookie },
			}),
		);
		expect(res.status).toBe(404);
	});
});

describe("The honest empty state", () => {
	it("renders every component with null shape and names the snapshot command", async () => {
		const body = await resources();
		expect(body.hasSnapshots).toBe(false);
		expect(body.howToSnapshot).toBe("make resource-snapshot");
		// Five components: the three compute ones plus the two static sites, all with their
		// cards rather than a shortened list.
		expect(body.components.map((c) => c.component).sort()).toEqual([
			"admin",
			"api",
			"migrate",
			"web",
			"worker",
		]);
		for (const c of body.components) {
			expect(c.instanceSize).toBeNull();
			expect(c.instanceCount).toBeNull();
			expect(c.snapshottedAt).toBeNull();
			expect(c.latest).toBeNull();
		}
		// The static sites say why they carry no signals.
		const web = body.components.find((c) => c.component === "web");
		expect(web?.bands).toEqual([]);
		expect(web?.note).toContain("static site");
	});

	it("states the spend boundary rather than a per-component number", async () => {
		const body = await resources();
		expect(body.spendNote).toContain("per account");
	});
});

describe("Rendering from seeded snapshots", () => {
	// Seed a small history: three api snapshots (one hour apart, oldest first in intent) and
	// one worker snapshot. The latest of each is what the component's shape renders from.
	const early = new Date("2001-01-01T00:00:00Z");
	const mid = new Date("2001-01-01T01:00:00Z");
	const late = new Date("2001-01-01T02:00:00Z");

	beforeAll(async () => {
		await insertSnapshot({
			component: "api",
			takenAt: early,
			instanceSize: "basic-xxs",
			instanceCount: 1,
			cpuPct: 10,
			memoryPct: 20,
			restartCount: 0,
		});
		await insertSnapshot({
			component: "api",
			takenAt: mid,
			instanceSize: "basic-xxs",
			instanceCount: 2,
			cpuPct: 40,
			memoryPct: 50,
			restartCount: 1,
		});
		await insertSnapshot({
			component: "api",
			takenAt: late,
			instanceSize: "basic-xs",
			instanceCount: 2,
			cpuPct: 80,
			memoryPct: 60,
			restartCount: 2,
			notes: "",
		});
		await insertSnapshot({
			component: "worker",
			takenAt: late,
			instanceSize: "basic-s",
			instanceCount: 1,
			cpuPct: 5,
			memoryPct: 30,
			restartCount: 0,
		});
	});

	it("renders the LATEST snapshot's recorded size and count, not the committed spec's", async () => {
		const body = await resources();
		expect(body.hasSnapshots).toBe(true);
		const api = body.components.find((c) => c.component === "api");
		expect(api?.instanceSize).toBe("basic-xs"); // the late row, not the early one
		expect(api?.instanceCount).toBe(2);
		// postgres-js returns timestamptz as Date, so the row's instant is compared as one.
		expect(api && new Date(api.snapshottedAt ?? "").toISOString()).toBe(late.toISOString());
		expect(api?.latest?.cpuPct).toBe(80);
		expect(api?.latest?.restartCount).toBe(2);
	});

	it("carries the trend series newest-first with every row's metrics", async () => {
		const body = await resources();
		const api = body.components.find((c) => c.component === "api");
		expect(api?.trend).toHaveLength(3);
		expect(api?.trend[0]?.cpuPct).toBe(80); // newest first
		expect(api?.trend[2]?.cpuPct).toBe(10);
		expect(api?.trend[1]?.restartCount).toBe(1);
	});

	it("renders the shared threshold table beside the rows, bands and all", async () => {
		const body = await resources();
		const api = body.components.find((c) => c.component === "api");
		const cpu = api?.bands.find((b) => b.signal === "cpu");
		expect(cpu?.soonAt).toBe(70);
		expect(cpu?.nowAt).toBe(90);
		expect(cpu?.remedy).toBe("bigger");
	});

	it("still renders a component the snapshots do not cover", async () => {
		const body = await resources();
		const migrate = body.components.find((c) => c.component === "migrate");
		expect(migrate?.instanceSize).toBeNull();
		expect(migrate?.latest).toBeNull();
		// And the duration-only signal rides along from the shared table.
		expect(migrate?.bands.map((b) => b.signal)).toEqual(["duration"]);
	});
});

// Every snapshot this suite wrote goes in afterAll, on success or failure — the rows are
// dated under the suite's own epoch so the sweep cannot touch a real snapshot's timestamps.
afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	await db
		.delete(resourceSnapshots)
		.where(lt(resourceSnapshots.takenAt, new Date("2002-01-01T00:00:00Z")));
});
