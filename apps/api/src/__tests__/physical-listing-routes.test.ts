// SPDX-License-Identifier: Apache-2.0
/**
 * A physical Work's listing over HTTP — the four answers, and who may give them.
 *
 * The suite's claims, one spec each:
 * - **The owner reads and writes; a stranger sees nothing.** A stranger's GET and PUT both
 *   answer 404 rather than 403, because confirming that a private Work exists is a question
 *   a stranger cannot ask.
 * - **Only a physical good carries one.** A video Work answers 400 `not_physical` on both
 *   routes rather than growing a shipping row nobody will ever read.
 * - **Unset reads as the defaults.** A good nobody has set up is shippable at zero with a
 *   three-day handling time, not a broken checkout.
 * - **The service's normalization is what lands.** A price typed `4.9` is stored `4.90`, and
 *   the options round-trip in the creator's order with a blank stock staying unlimited.
 * - **A refusal changes nothing.** Every problem comes back at once, and the row that was
 *   there before the refusal is the row that is there after it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { workPhysicalListings, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere, purgeWorkIds } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";

let creator: FixtureAccount;
let stranger: FixtureAccount;
const workIds: number[] = [];

let physicalWork: number;
let videoWork: number;

function call(method: string, path: string, cookie?: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				...(cookie ? { Cookie: cookie } : {}),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: "manual",
		}),
	);
}

interface ListingJson {
	listing?: {
		shippingPrice: string;
		handlingBusinessDays: number;
		taxCategory: string;
		options: Array<{ name: string; values: Array<{ label: string; stock: number | null }> }>;
	};
	error?: string;
	code?: string;
	problems?: Array<{ field: string; message: string }>;
}

const GOOD = {
	shippingPrice: "4.9",
	handlingBusinessDays: 5,
	taxCategory: "clothing",
	options: [
		{
			name: "Size",
			values: [
				{ label: "M", stock: 4 },
				{ label: "L", stock: null },
			],
		},
	],
};

describe("a physical Work's listing", () => {
	beforeAll(async () => {
		const run = crypto.randomUUID().slice(0, 8);
		creator = await createAccount(`plist-owner-${run}`, {
			emailVerified: true,
			fields: { creatorMode: true },
		});
		stranger = await createAccount(`plist-stranger-${run}`, { emailVerified: true });

		const good = await insertWork({ creatorId: creator.userId, type: "physical" });
		physicalWork = good.id;
		workIds.push(good.id);

		const video = await insertWork({ creatorId: creator.userId, type: "video" });
		videoWork = video.id;
		workIds.push(video.id);
	}, 60_000);

	afterAll(async () => {
		await purgeWorkIds(workIds);
	});

	it("reads the defaults for a good nobody has set up", async () => {
		const res = await call("GET", `/api/content/works/${physicalWork}/physical`, creator.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListingJson;
		expect(body.listing).toEqual({
			shippingPrice: "0.00",
			handlingBusinessDays: 3,
			taxCategory: "general",
			options: [],
		});
	});

	it("saves what the creator answered, normalized", async () => {
		const res = await call(
			"PUT",
			`/api/content/works/${physicalWork}/physical`,
			creator.cookie,
			GOOD,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as ListingJson;
		expect(body.listing?.shippingPrice).toBe("4.90");
		expect(body.listing?.handlingBusinessDays).toBe(5);
		expect(body.listing?.taxCategory).toBe("clothing");
		expect(body.listing?.options[0].values).toEqual([
			{ label: "M", stock: 4 },
			{ label: "L", stock: null },
		]);
	});

	it("round-trips through a re-read", async () => {
		const res = await call("GET", `/api/content/works/${physicalWork}/physical`, creator.cookie);
		const body = (await res.json()) as ListingJson;
		expect(body.listing?.shippingPrice).toBe("4.90");
		expect(body.listing?.options[0].name).toBe("Size");
	});

	it("replaces rather than accumulates on a second save", async () => {
		const res = await call("PUT", `/api/content/works/${physicalWork}/physical`, creator.cookie, {
			shippingPrice: "0",
			handlingBusinessDays: 2,
			taxCategory: "general",
			options: [],
		});
		expect(res.status).toBe(200);
		const rows = await db
			.select()
			.from(workPhysicalListings)
			.where(eq(workPhysicalListings.workId, physicalWork));
		expect(rows).toHaveLength(1);
		expect(rows[0].options).toEqual([]);
		expect(rows[0].shippingPrice).toBe("0.00");
	});

	it("refuses a stranger with a 404, on both routes", async () => {
		const read = await call("GET", `/api/content/works/${physicalWork}/physical`, stranger.cookie);
		expect(read.status).toBe(404);
		const write = await call(
			"PUT",
			`/api/content/works/${physicalWork}/physical`,
			stranger.cookie,
			GOOD,
		);
		expect(write.status).toBe(404);
	});

	it("refuses a Work that is not a physical good", async () => {
		const read = await call("GET", `/api/content/works/${videoWork}/physical`, creator.cookie);
		expect(read.status).toBe(400);
		expect(((await read.json()) as ListingJson).code).toBe("not_physical");
		const write = await call(
			"PUT",
			`/api/content/works/${videoWork}/physical`,
			creator.cookie,
			GOOD,
		);
		expect(write.status).toBe(400);
	});

	it("reports every problem at once and leaves the saved row alone", async () => {
		const before = await db
			.select()
			.from(workPhysicalListings)
			.where(eq(workPhysicalListings.workId, physicalWork));

		const res = await call("PUT", `/api/content/works/${physicalWork}/physical`, creator.cookie, {
			shippingPrice: "four",
			handlingBusinessDays: 3,
			taxCategory: "livestock",
			options: [],
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as ListingJson;
		expect(body.problems?.length).toBe(2);

		const after = await db
			.select()
			.from(workPhysicalListings)
			.where(eq(workPhysicalListings.workId, physicalWork));
		expect(after).toEqual(before);
	});

	it("requires a session", async () => {
		const res = await call("GET", `/api/content/works/${physicalWork}/physical`);
		expect(res.status).toBe(401);
	});

	it("keeps the listing one-to-one with the Work", async () => {
		const rows = await db
			.select()
			.from(workPhysicalListings)
			.where(eq(workPhysicalListings.workId, physicalWork));
		expect(rows).toHaveLength(1);
		// The Work itself is untouched by any of this — the price and the art stay its own.
		const [work] = await db.select().from(works).where(eq(works.id, physicalWork));
		expect(work.type).toBe("physical");
	});
});
