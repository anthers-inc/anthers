// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Public Access meter, enforced end-to-end: a free account watches 10 hours of the
 * commons a month, the Public Access price given to Anthers removes the limit, and nothing
 * above it buys more.
 *
 * The policy is pinned purely in `packages/shared/src/public-access.test.ts`. What this
 * file is for is everything that file *cannot* see:
 *
 *   - that the meter actually **withholds bytes**, at the endpoints that serve them,
 *     rather than merely reporting a smaller number somewhere;
 *   - that it withholds them for **Public Access only** — gated work the viewer cleared,
 *     work they bought and their own catalog must never draw the allowance;
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
import {
	accounts,
	assets,
	attentionEvents,
	purchases,
	transcodingJobs,
	users,
} from "@anthers/db/schema";
import { PUBLIC_ACCESS_PRICE } from "@anthers/shared/constants";
import { FREE_PUBLIC_ACCESS_SECONDS } from "@anthers/shared/public-access";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const HLS_URL = "https://cdn.example.com/creators/x/videos/hls/pa/master.m3u8";
/** Distinctive enough that finding it in a payload is unambiguous. */
const TEXT_BODY = "<p>the-essay-body-that-must-not-leak</p>";
const GAME_EMBED = "https://games.example.com/embed/pa-game";
const ASSET_KEY = "creators/x/builds/pa-download.zip";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const creatorName = `pam_creator_${run}`;
const viewerName = `pam_viewer_${run}`;
const seededName = `pam_seeded_${run}`;

/** Ungated + streaming + free to everyone. This is what Public Access *is*. */
const PUBLIC_ACCESS = [{ threshold: 0, allow: true, price: "0" }];
/** Gated at $1 to the creator — reachable, but not part of the commons. */
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
let textWorkId: number;
let gameWorkId: number;
let gatedTextWorkId: number;
let downloadableWorkId: number;

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

/**
 * Put a viewer at exactly `seconds` spent, clearing whatever came before.
 *
 * ⚠️ `spend` above **accumulates** — it inserts an event — so tests that need a viewer
 * *inside* their allowance cannot use it once an earlier test has spent one. That
 * ordering coupling is fine for a suite that only ever climbs; it is a trap for one that
 * moves in both directions, which is why this exists.
 */
async function setSpent(userId: number, seconds: number) {
	await db
		.delete(attentionEvents)
		.where(and(eq(attentionEvents.userId, userId), eq(attentionEvents.publicAccess, true)));
	if (seconds > 0) await spend(userId, seconds);
}

/** Ask for the playlist — the last point at which delivery can be declined. */
function playlist(workId: number, cookie?: string) {
	return req(`/api/content/works/${workId}/hls/master.m3u8`, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

/**
 * Set what this user gives Anthers, **in dollars**.
 *
 * ⚠️ This helper once took a different unit from the function it drove — which is how
 * this suite stayed green while `publicAccessBudget` compared dollars against `>= 1` and
 * $1 a month bought unlimited access priced at $3.
 */
async function setSupport(userId: number, anthersSupport: number) {
	await db
		.insert(accounts)
		.values({ userId, anthersSupport: anthersSupport.toFixed(2), isActive: true })
		.onConflictDoUpdate({
			target: accounts.userId,
			set: { anthersSupport: anthersSupport.toFixed(2) },
		});
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

	// Text and a browser game. Neither has a delivery endpoint of its own — the
	// deliverable rides inside `GET /works/:id`, which is exactly why the meter missed
	// them for two PRs while their attention was being counted the whole time.
	const text = await insertWork({
		creatorId,
		type: "text",
		title: "Public Access essay",
		streamEnabled: true,
		bodyHtml: TEXT_BODY,
		seedAccess: PUBLIC_ACCESS,
	});
	textWorkId = text.id;

	const game = await insertWork({
		creatorId,
		type: "game",
		title: "Public Access game",
		streamEnabled: true,
		embedUrl: GAME_EMBED,
		seedAccess: PUBLIC_ACCESS,
	});
	gameWorkId = game.id;

	const gatedText = await insertWork({
		creatorId,
		type: "text",
		title: "Seed-gated essay",
		streamEnabled: true,
		bodyHtml: TEXT_BODY,
		seedAccess: SEED_GATED,
	});
	gatedTextWorkId = gatedText.id;

	// Public Access *and* downloadable — the pair that proves the meter stops at bytes.
	const withFile = await insertWork({
		creatorId,
		type: "video",
		title: "Public Access with a download",
		streamEnabled: true,
		downloadEnabled: true,
		seedAccess: PUBLIC_ACCESS,
	});
	downloadableWorkId = withFile.id;
	await db.insert(assets).values({
		workId: withFile.id,
		file: ASSET_KEY,
		filename: "build.zip",
		fileSize: 1024,
	});

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
		await setSupport(viewerId, 0);
		await spend(viewerId, 60);
		// Not a 402. (Storage has no real playlist behind the fixture URL, so a 404 here
		// is the *pass* — it means the request got past every gate to the fetch.)
		expect((await playlist(paWorkId, viewerCookie)).status).not.toBe(402);
	});

	it("refuses Public Access once the allowance is spent — 402, not 403", async () => {
		await setSupport(viewerId, 0);
		await spend(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const res = await playlist(paWorkId, viewerCookie);
		// 402 Payment Required, deliberately: the viewer is not forbidden, they have spent
		// a monthly allowance that the Public Access price removes. 403 would say "you may not" where the
		// truth is "you may, and here is how".
		expect(res.status).toBe(402);
		const body = await res.json();
		expect(body.reason).toBe("public_access_limit");
		expect(body.budget.remainingSeconds).toBe(0);
	});

	/**
	 * 🚨 The claim the whole model rests on: **access is binary and arrives whole at the
	 * Public Access price.** A regression would most plausibly look like a per-dollar allowance
	 * creeping back in — the stratified commons the binary model exists to prevent.
	 */
	it("the Public Access price removes the limit, however much has been watched", async () => {
		await setSupport(seededId, PUBLIC_ACCESS_PRICE);
		await spend(seededId, FREE_PUBLIC_ACCESS_SECONDS * 5);
		expect((await playlist(paWorkId, seededCookie)).status).not.toBe(402);
	});
});

describe("what the meter must NOT charge for", () => {
	it("gated work the viewer cleared draws no allowance", async () => {
		// Over the limit AND having given this creator money: the gate opens, and the
		// meter must not close it. Billing a supporter's free allowance for work they paid
		// a creator to reach charges them twice for one thing.
		await setSupport(viewerId, 0);
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

	it("a creator's own catalog draws no allowance", async () => {
		// The creator is over any limit by construction — they have an account that gives
		// nothing — and `owner` access is not free access.
		await setSupport(creatorId, 0);
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
		await setSupport(id, 0);
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
		await setSupport(id, 0);

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
		await setSupport(id, 0);
		// Money given to this creator this cycle: the gate opens for this viewer.
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
	/*
	 * 🚨 **This block asserted the opposite until 2026-08-28**, under the heading *"gets
	 * the full allowance rather than a refusal"*: `allowed: true`, and a playlist request
	 * that was not a 402. Both were true, and together they were the defect — anonymous
	 * Public Access streaming was **unlimited** while a signed-in viewer got ten hours a
	 * month, and since `POST /attention` requires an account, none of that time was ever
	 * attributed and **the creator earned nothing for it**. The incentive ran backwards
	 * directly underneath the platform's only conversion event.
	 *
	 * Nobody decided that. It was a missing `requireAuth` with a justification written
	 * afterwards ("anonymous streaming of the commons is the shop window"), which then
	 * propagated into the onboarding doc, the Roadmap, this test's own comment and the meter's module
	 * docs — where it read as settled policy because it was written in the voice of one.
	 */
	it("has no allowance at all, because an allowance belongs to an account", async () => {
		const res = await req("/api/subscriptions/public-access");
		const budget = await res.json();
		expect(budget.allowed).toBe(false);
		expect(budget.limitSeconds).toBe(0);
		// Not `usedSeconds: FREE_PUBLIC_ACCESS_SECONDS`. Both readings refuse, but only one
		// of them is true — a signed-out visitor has consumed nothing we could attribute.
		expect(budget.usedSeconds).toBe(0);
	});

	it("is refused the playlist outright rather than metered on it", async () => {
		// 401, not 402: they have not spent an allowance, they have no account. The meter
		// is never consulted, because `requireAuth` refuses before the route runs.
		expect((await playlist(paWorkId)).status).toBe(401);
	});
});

describe("media with no player of their own", () => {
	/*
	 * 🚨 The bug this block exists for, and it shipped twice.
	 *
	 * `attention_events.public_access` is stamped for **any** Work that is ungated +
	 * streaming + released, and `stream_enabled` is genuinely true for text and games —
	 * so reading and playing have always **spent** the ten hours. But `publicAccessGate`
	 * was applied at exactly two call sites, `/works/:id/audio` and `/works/:id/hls/:file`,
	 * because those are the only media with a delivery endpoint to gate.
	 *
	 * The result was that reading silently burned the video allowance and then stopped a
	 * video, with no warning anywhere near the reading. Nothing errored; the meter simply
	 * counted a thing it never enforced.
	 *
	 * Text, games and images deliver **inside `GET /works/:id`**, so the choke point is
	 * serialization rather than a route, and these assertions are about the payload.
	 */
	async function fetchWork(id: number, cookie: string) {
		const res = await req(`/api/content/works/${id}`, { headers: { Cookie: cookie } });
		return (await res.json()) as {
			work: {
				bodyHtml: string;
				embedUrl: string;
				access: { canAccess: boolean; isFree: boolean };
				publicAccess: boolean;
			};
		};
	}

	it("serves a Public Access essay inside the allowance", async () => {
		await setSupport(viewerId, 0);
		await setSpent(viewerId, 60);

		const { work } = await fetchWork(textWorkId, viewerCookie);
		expect(work.bodyHtml).toBe(TEXT_BODY);
	});

	it("withholds the essay once the allowance is spent", async () => {
		await setSupport(viewerId, 0);
		await setSpent(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const { work } = await fetchWork(textWorkId, viewerCookie);
		// The body is the deliverable for a text Work. Hiding it in the client would be
		// decoration; the bytes must not arrive.
		expect(work.bodyHtml).toBe("");
	});

	it("withholds a game's embed once the allowance is spent", async () => {
		await setSupport(viewerId, 0);
		await setSpent(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const { work } = await fetchWork(gameWorkId, viewerCookie);
		expect(work.embedUrl).toBe("");
	});

	it("🚨 still reports the Work as FREE — the meter is not a gate on the Work", async () => {
		await setSupport(viewerId, 0);
		await setSpent(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const { work } = await fetchWork(textWorkId, viewerCookie);
		/*
		 * The whole distinction the model rests on. The Work is free to everyone and stays
		 * free to everyone; what ran out belongs to the *account*. If `access` ever starts
		 * reporting denied here, the commons has quietly re-stratified — which is the exact
		 * thing the binary model forbids — and the UI would show a lock ("you may
		 * not") where the truth is a spent allowance ("you may, and here is how").
		 */
		expect(work.access.isFree).toBe(true);
		expect(work.access.canAccess).toBe(true);
		expect(work.publicAccess).toBe(true);
	});

	it("the Public Access price restores it, and nothing above it buys more", async () => {
		await setSpent(viewerId, FREE_PUBLIC_ACCESS_SECONDS);
		await setSupport(viewerId, PUBLIC_ACCESS_PRICE);
		expect((await fetchWork(textWorkId, viewerCookie)).work.bodyHtml).toBe(TEXT_BODY);

		await setSupport(viewerId, PUBLIC_ACCESS_PRICE * 4);
		expect((await fetchWork(textWorkId, viewerCookie)).work.bodyHtml).toBe(TEXT_BODY);
	});

	it("🚨 gated text the viewer CLEARED survives a spent allowance", async () => {
		/*
		 * The don't-bill-them-twice property, for the media that have no delivery endpoint.
		 *
		 * By this point the viewer has given this creator money (an earlier test in
		 * this file did so), so the gate is open to them. Their allowance is also
		 * gone. Those two facts must not interact: they paid a creator to reach this, it
		 * was never part of the commons, and it never drew an allowance — so an empty
		 * allowance has no claim on it.
		 *
		 * The mechanism that makes this true is worth naming, because it is easy to break:
		 * `deliverable` withholds only when `publicAccess` is true, and `publicAccess`
		 * requires `access.isFree`. Gated work the viewer cleared is accessible but NOT
		 * free, so it is untouched. Widen that condition to "canAccess" and this fails.
		 */
		await setSupport(viewerId, 0);
		await setSpent(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const { work } = await fetchWork(gatedTextWorkId, viewerCookie);
		expect(work.access.canAccess).toBe(true);
		expect(work.publicAccess).toBe(false);
		expect(work.bodyHtml).toBe(TEXT_BODY);
	});

	it("gated text the viewer has NOT cleared is withheld for access, not for the meter", async () => {
		// A viewer with no Seed to this creator, and a full allowance. Empty for the
		// access reason alone — asserted so a refactor cannot collapse the two reasons
		// into one flag: they mean different things and produce different UI.
		const { cookie, id } = await signUp(`pam_nogate_${run}`);
		await setSupport(id, 0);
		await setSpent(id, 0);

		const { work } = await fetchWork(gatedTextWorkId, cookie);
		expect(work.bodyHtml).toBe("");
		expect(work.access.canAccess).toBe(false);
		expect(work.publicAccess).toBe(false);
	});

	it("🚨 an anonymous reader gets the page and never the prose", async () => {
		/*
		 * The account requirement, at the one choke point text passes through.
		 *
		 * This asserted `bodyHtml === TEXT_BODY` until 2026-08-28 — *"an anonymous reader
		 * is never withheld from"* — and text is the medium where that mattered most,
		 * because a text Work has no delivery endpoint of its own. Its deliverable rides
		 * inside `GET /works/:id`, so adding `requireAuth` to the four media routes does
		 * nothing for it; only `resolveAccessSync` refusing a null viewer closes it. That
		 * is why neither guard is redundant.
		 *
		 * The rest of the payload staying present is the other half of the rule: the page
		 * is public, the bytes are not.
		 */
		const res = await req(`/api/content/works/${textWorkId}`);
		expect(res.status).toBe(200);
		const { work } = (await res.json()) as {
			work: {
				bodyHtml: string;
				title: string | null;
				access: { reason: string };
				publicAccess: boolean;
			};
		};
		expect(work.bodyHtml).toBe("");
		expect(work.access.reason).toBe("login_required");
		// Still described as the commons, and still carrying everything a listing needs.
		expect(work.publicAccess).toBe(true);
		expect(work.title).toBeTruthy();
	});

	it("⚠️ a spent allowance never withholds a DOWNLOAD", async () => {
		/*
		 * The meter measures **attention to the commons, not bytes**, and this is the only
		 * assertion holding that line.
		 *
		 * Delivery has cost $0 at any volume since R2, so there is no per-byte reason to
		 * ration a file, and the allowance was never spent on one — downloads draw nothing,
		 * which is why they are excluded from `public_access` stamping in the first place.
		 * Metering them here would invent a limit the model does not have, and it would do
		 * it invisibly: the key would simply be missing and the download button would do
		 * nothing.
		 *
		 * Found by sabotage — switching `assets` from `canAccess` to `deliverable` broke
		 * no test in the entire suite before this one existed.
		 */
		await setSupport(viewerId, 0);
		await setSpent(viewerId, FREE_PUBLIC_ACCESS_SECONDS);

		const res = await req(`/api/content/works/${downloadableWorkId}`, {
			headers: { Cookie: viewerCookie },
		});
		const { work } = (await res.json()) as {
			work: { assets: { file: string }[]; publicAccess: boolean };
		};

		// Public Access, allowance gone — and the file key still arrives.
		expect(work.publicAccess).toBe(true);
		expect(work.assets[0]?.file).toBe(ASSET_KEY);
	});
});
