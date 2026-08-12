// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Public Access meter, enforced end-to-end: a free account watches 10 hours of the
 * commons a month, the first Seed given to Anthers removes the limit, and nothing above
 * it buys more.
 *
 * The policy is pinned purely in `packages/shared/src/public-access.test.ts`. What this
 * file is for is everything that file *cannot* see:
 *
 *   - that the meter actually **withholds bytes**, at the endpoints that serve them,
 *     rather than merely reporting a smaller number somewhere;
 *   - that it withholds them for **Public Access only** — gated work the viewer cleared,
 *     work they bought and their own catalogue must never draw the allowance;
 *   - that the `public_access` flag is **stamped at write time** from the access the
 *     viewer actually had, so re-gating a Work later cannot retroactively bill someone.
 *
 * Same reasoning as `delivery-access.test.ts`: a reason-only suite is structurally
 * incapable of catching a delivery leak, so these assertions are about status codes on
 * the media routes.
 *
 * Works are inserted directly rather than through `POST /works`, which queues a transcode
 * that pg-boss isn't running to consume.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, attentionEvents, purchases, transcodingJobs, users } from "@anthers/db/schema";
import { FREE_PUBLIC_ACCESS_SECONDS } from "@anthers/shared/public-access";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const HLS_URL = "https://cdn.example.com/creators/x/videos/hls/pa/master.m3u8";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `pam_creator_${run}`;
const viewerName = `pam_viewer_${run}`;
const seededName = `pam_seeded_${run}`;

/** Ungated + streaming + free to everyone. This is what Public Access *is*. */
const PUBLIC_ACCESS = [{ threshold: 0, allow: true, price: "0" }];
/** Gated at 1 Seed to the creator — reachable, but not part of the commons. */
const SEED_GATED = [
	{ threshold: 0, allow: false, price: "0" },
	{ threshold: 1, allow: true, price: "0" },
];
/** Buyable by anyone. Also not the commons. */
const FOR_SALE = [{ threshold: 0, allow: true, price: "5.00" }];

let creatorId: number;
let creatorCookie: string;
let viewerId: number;
let viewerCookie: string;
let seededId: number;
let seededCookie: string;
let paWorkId: number;
let gatedWorkId: number;
let boughtWorkId: number;

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const [{ id }] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, username));
	return { cookie: res.headers.get("Set-Cookie")!.split(";")[0], id };
}

/** Put `seconds` of Public Access on the clock for a viewer, this month. */
async function spend(userId: number, seconds: number, publicAccess = true) {
	await db.insert(attentionEvents).values({
		userId,
		creatorId,
		workId: paWorkId,
		eventType: "watch",
		durationSeconds: seconds,
		publicAccess,
	});
}

/** Ask for the playlist — the last point at which delivery can be declined. */
function playlist(workId: number, cookie?: string) {
	return req(`/api/content/works/${workId}/hls/master.m3u8`, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

async function setSeeds(userId: number, anthersSeeds: number) {
	await db
		.insert(accounts)
		.values({ userId, anthersSeeds, isActive: true })
		.onConflictDoUpdate({ target: accounts.userId, set: { anthersSeeds } });
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName}, ${seededName})`,
	);
	({ cookie: creatorCookie, id: creatorId } = await signUp(creatorName));
	({ cookie: viewerCookie, id: viewerId } = await signUp(viewerName));
	({ cookie: seededCookie, id: seededId } = await signUp(seededName));

	const pa = await insertWork({
		creatorId,
		type: "video",
		title: "Public Access video",
		streamEnabled: true,
		seedAccess: PUBLIC_ACCESS,
	});
	paWorkId = pa.id;

	const gated = await insertWork({
		creatorId,
		type: "video",
		title: "Seed-gated video",
		streamEnabled: true,
		seedAccess: SEED_GATED,
	});
	gatedWorkId = gated.id;

	const bought = await insertWork({
		creatorId,
		type: "video",
		title: "Purchased video",
		streamEnabled: true,
		seedAccess: FOR_SALE,
	});
	boughtWorkId = bought.id;

	// A completed job on each, so delivery has something to reach for and a 402 can be
	// distinguished from a 404.
	for (const workId of [paWorkId, gatedWorkId, boughtWorkId]) {
		await db.insert(transcodingJobs).values({
			workId,
			mediaType: "video",
			status: "completed",
			hlsManifestUrl: HLS_URL,
		});
	}
}, DB_SETUP_TIMEOUT);

describe("the meter withholds bytes, not just numbers", () => {
	it("serves Public Access to a free account inside its allowance", async () => {
		await setSeeds(viewerId, 0);
		await spend(viewerId, 60);
		// Not a 402. (Storage has no real playlist behind the fixture URL, so a 404 here
		// is the *pass* — it means the request got past every gate to the fetch.)
		expect((await playlist(paWorkId, viewerCookie)).status).not.toBe(402);
	});

	it("refuses Public Access once the allowance is spent — 402, not 403", async () => {
		await setSeeds(viewerId, 0);
		await spend(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const res = await playlist(paWorkId, viewerCookie);
		// 402 Payment Required, deliberately: the viewer is not forbidden, they have spent
		// a monthly allowance that a $3 Seed removes. 403 would say "you may not" where the
		// truth is "you may, and here is how".
		expect(res.status).toBe(402);
		const body = await res.json();
		expect(body.reason).toBe("public_access_limit");
		expect(body.budget.remainingSeconds).toBe(0);
	});

	/**
	 * 🚨 The claim the whole model rests on: **access is binary and arrives whole at the
	 * first Seed.** A regression would most plausibly look like a per-Seed allowance
	 * creeping back in — the stratified commons retiring Anthers Gates was meant to end.
	 */
	it("one Seed removes the limit, however much has been watched", async () => {
		await setSeeds(seededId, 1);
		await spend(seededId, FREE_PUBLIC_ACCESS_SECONDS * 5);
		expect((await playlist(paWorkId, seededCookie)).status).not.toBe(402);
	});
});

describe("what the meter must NOT charge for", () => {
	it("gated work the viewer cleared draws no allowance", async () => {
		// Over the limit AND holding a Seed given to this creator: the gate opens, and the
		// meter must not close it. Billing a supporter's free allowance for work they paid
		// a creator to reach charges them twice for one thing.
		await setSeeds(viewerId, 0);
		await db.execute(sql`
			INSERT INTO seed_allocations (user_id, creator_id, amount, billing_cycle)
			VALUES (${viewerId}, ${creatorId}, '3.00', to_char(now(), 'YYYY-MM-01'))
			ON CONFLICT DO NOTHING
		`);
		expect((await playlist(gatedWorkId, viewerCookie)).status).not.toBe(402);
	});

	it("purchased work draws no allowance", async () => {
		await db.insert(purchases).values({
			buyerId: viewerId,
			workId: boughtWorkId,
			creatorId,
			workTitle: "Purchased video",
			workType: "video",
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			crfFee: "0.00",
			salesTax: "0.33",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_pam_${run}`,
			status: "completed",
		});
		expect((await playlist(boughtWorkId, viewerCookie)).status).not.toBe(402);
	});

	it("a creator's own catalogue draws no allowance", async () => {
		// The creator is over any limit by construction — they have an account with no
		// Seeds — and `owner` access is not free access.
		await setSeeds(creatorId, 0);
		await spend(creatorId, FREE_PUBLIC_ACCESS_SECONDS * 2);
		expect((await playlist(paWorkId, creatorCookie)).status).not.toBe(402);
	});
});

describe("the stamp is taken at write time", () => {
	/**
	 * ⚠️ The property the `public_access` column exists for. Seconds recorded against
	 * gated work must never count toward the commons, *whatever the Work's access says
	 * later* — a creator opening something up must not retroactively bill the people who
	 * had paid to see it while it was closed.
	 */
	it("seconds stamped as non-Public-Access never draw the allowance", async () => {
		const { cookie, id } = await signUp(`pam_stamp_${run}`);
		await setSeeds(id, 0);
		// Far past the limit, but none of it was the commons.
		await spend(id, FREE_PUBLIC_ACCESS_SECONDS * 3, false);

		const res = await req("/api/subscriptions/public-access", { headers: { Cookie: cookie } });
		const budget = await res.json();
		expect(budget.usedSeconds).toBe(0);
		expect(budget.allowed).toBe(true);
		expect((await playlist(paWorkId, cookie)).status).not.toBe(402);
	});

	it("the attention endpoint stamps the flag from the viewer's real access", async () => {
		const { cookie, id } = await signUp(`pam_write_${run}`);
		await setSeeds(id, 0);

		const post = (workId: number) =>
			req("/api/subscriptions/attention", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
				body: JSON.stringify({
					events: [{ creatorId, workId, eventType: "watch", durationSeconds: 120 }],
				}),
			});

		// The commons: counted.
		expect((await post(paWorkId)).status).toBe(200);
		const after = await (
			await req("/api/subscriptions/public-access", { headers: { Cookie: cookie } })
		).json();
		expect(after.usedSeconds).toBe(120);

		// A Work this viewer cannot reach at all is ineligible and records nothing — so it
		// cannot draw the allowance either. Two protections, and this asserts the outer one.
		const denied = await post(gatedWorkId);
		expect((await denied.json()).recorded).toBe(0);
		const unchanged = await (
			await req("/api/subscriptions/public-access", { headers: { Cookie: cookie } })
		).json();
		expect(unchanged.usedSeconds).toBe(120);
	});

	/**
	 * 🚨 **The inner protection, and the one a sabotage pass showed nothing else covered.**
	 * The test above only proves that *inaccessible* work records nothing — which a
	 * `publicAccess: true` stamp on every row would satisfy just as happily. The load-
	 * bearing case is work the viewer genuinely CAN reach that is not the commons: they
	 * cleared the creator's gate, so the seconds are eligible, recorded, and paid from the
	 * Time Pool — and must still not draw a free allowance they were never spending.
	 */
	it("records gated work the viewer CLEARED without stamping it Public Access", async () => {
		const { cookie, id } = await signUp(`pam_cleared_${run}`);
		await setSeeds(id, 0);
		// A Seed given to this creator this cycle: the gate opens for this viewer.
		await db.execute(sql`
			INSERT INTO seed_allocations (user_id, creator_id, amount, billing_cycle)
			VALUES (${id}, ${creatorId}, '3.00', to_char(now(), 'YYYY-MM-01'))
			ON CONFLICT DO NOTHING
		`);

		const res = await req("/api/subscriptions/attention", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({
				events: [{ creatorId, workId: gatedWorkId, eventType: "watch", durationSeconds: 300 }],
			}),
		});
		// Eligible and recorded — the creator is paid for this time.
		expect((await res.json()).recorded).toBe(1);

		// But none of it is the commons, so the allowance is untouched.
		const budget = await (
			await req("/api/subscriptions/public-access", { headers: { Cookie: cookie } })
		).json();
		expect(budget.usedSeconds).toBe(0);
	});
});

describe("an anonymous viewer", () => {
	it("gets the full allowance rather than a refusal", async () => {
		// Anonymous streaming of the commons is the shop window; the honest place to meter
		// someone is once there is an account to meter.
		const res = await req("/api/subscriptions/public-access");
		const budget = await res.json();
		expect(budget.usedSeconds).toBe(0);
		expect(budget.allowed).toBe(true);
		expect((await playlist(paWorkId)).status).not.toBe(402);
	});
});
