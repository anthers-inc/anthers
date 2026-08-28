// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Consuming a Work requires an account — the guard, and the line it draws.
 *
 * 🚨 **This file exists because its subject is an ABSENCE, and an absence is the one thing
 * a passing suite cannot notice.** There was no decision to allow anonymous viewing. There
 * was no `requireAuth` on four delivery routes, and a justification for the gap was written
 * down afterwards — *"anonymous streaming of the commons is the shop window"* — which then
 * propagated into 21.01 §9.1, the Roadmap's Free-Limit lane, the meter's module docs and
 * `allowanceSpent`'s own docstring, where it read like settled policy because it was written
 * in the voice of one. Every test in the repo passed throughout. The repo has now been
 * bitten three times by a missing check that nothing asserted the presence of, which is why
 * these assertions are about **refusals** rather than about reasons.
 *
 * What it cost while it was live, concretely, and neither half errored:
 *
 *   1. `POST /attention` **is** authenticated, so bytes went out and no attention event was
 *      ever written. **The creator earned nothing for anonymous viewing of their Public
 *      Access work** — silently, nothing logged.
 *   2. `loadPublicAccessBudget(null)` handed back the full allowance, so anonymous
 *      streaming was *unlimited* while signing in reduced you to ten hours a month. The
 *      incentive ran backwards directly underneath the platform's only conversion event.
 *
 * **The line is the page versus the bytes**, and both halves are asserted here. A Work's
 * page stays public — title, cover, duration, the access verdict, `publicAccess: true` —
 * so it is shareable, indexable and unfurls properly. Delivery is what asks who is calling.
 *
 * ⚠️ **Two independent guards, and neither is redundant.** `requireAuth` covers the four
 * routes that hand over media. `resolveAccessSync` refusing a null viewer covers text,
 * games, images and software, whose deliverable rides inside `GET /works/:id` and passes no
 * route of its own. Sabotage either one and a different half of this file goes red.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, transcodingJobs, users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string) {
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
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

/** Public Access: the baseline row allowed at $0, on a streaming Work. */
const PUBLIC_ACCESS = { seedAccess: [{ threshold: 0, allow: true, price: "0" }] };

const TEXT_BODY = "<p>prose-that-requires-an-account</p>";

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `dra_creator_${id}`;
const viewerName = `dra_viewer_${id}`;

describe("Consuming a Work requires an account", () => {
	let creatorCookie: string;
	let viewerCookie: string;
	let creatorId: number;
	/** A Public Access audio Work with a completed transcode — the media half. */
	let audioId: number;
	/** A Public Access video Work with a completed transcode. */
	let videoId: number;
	/** A Public Access text Work — the half with no delivery route of its own. */
	let textId: number;
	/** A Public Access Work with a downloadable asset. */
	let downloadId: number;
	let assetId: number;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
		creatorCookie = await signUp(creatorName);
		viewerCookie = await signUp(viewerName);
		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName))
			.limit(1);
		creatorId = creator!.id;

		const audio = await insertWork({
			creatorId,
			type: "audio",
			title: "Public Access audio",
			streamEnabled: true,
			...PUBLIC_ACCESS,
		});
		audioId = audio.id;
		await db.insert(transcodingJobs).values({
			workId: audioId,
			mediaType: "audio",
			status: "completed",
			outputFileUrl: "https://cdn.example.com/creators/x/audio/processed/open.mp3",
		});

		const video = await insertWork({
			creatorId,
			type: "video",
			title: "Public Access video",
			streamEnabled: true,
			...PUBLIC_ACCESS,
		});
		videoId = video.id;
		await db.insert(transcodingJobs).values({
			workId: videoId,
			mediaType: "video",
			status: "completed",
			hlsManifestUrl: "https://cdn.example.com/creators/x/videos/hls/open/master.m3u8",
		});

		const text = await insertWork({
			creatorId,
			type: "text",
			title: "Public Access essay",
			description: "The blurb, which is public.",
			bodyHtml: TEXT_BODY,
			body: TEXT_BODY,
			streamEnabled: true,
			...PUBLIC_ACCESS,
		});
		textId = text.id;

		const downloadable = await insertWork({
			creatorId,
			type: "software",
			title: "Public Access download",
			streamEnabled: true,
			downloadEnabled: true,
			...PUBLIC_ACCESS,
		});
		downloadId = downloadable.id;
		const [asset] = await db
			.insert(assets)
			.values({
				workId: downloadId,
				file: "creators/x/assets/build.zip",
				filename: "build.zip",
				fileSize: 1024,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			})
			.returning();
		assetId = asset.id;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
	});

	// ── The four routes that hand something over ──────────────────────────────

	/**
	 * Every one of these was a 200 for a signed-out caller before 2026-08-28, on work that
	 * is free to everyone — which is exactly why the gap survived: nothing looked broken.
	 */
	it("🚨 401s every delivery route for a signed-out caller, on FREE work", async () => {
		const routes: [string, RequestInit][] = [
			[`/api/content/works/${audioId}/audio`, { redirect: "manual" }],
			[`/api/content/works/${videoId}/hls/master.m3u8`, { redirect: "manual" }],
			[`/api/content/works/${textId}/pages/1`, { redirect: "manual" }],
			[
				`/api/content/works/${downloadId}/assets/${assetId}/download`,
				{ method: "POST", headers: { Origin: ORIGIN } },
			],
		];
		for (const [path, options] of routes) {
			const res = await req(path, options);
			expect(res.status, path).toBe(401);
		}
	});

	it("serves the same routes to an account", async () => {
		// The other direction, and it has to be here: a guard that refuses everybody is
		// indistinguishable from a working one in a file that only asserts refusals.
		const audio = await req(`/api/content/works/${audioId}/audio`, {
			headers: { Cookie: viewerCookie },
			redirect: "manual",
		});
		expect(audio.status).toBe(302);

		const download = await req(`/api/content/works/${downloadId}/assets/${assetId}/download`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(download.status).toBe(200);
		expect((await download.json()).url).toBeTruthy();
	});

	// ── The media with no route of their own ──────────────────────────────────

	it("🚨 withholds a text Work's prose from a signed-out reader, and keeps its page", async () => {
		// `requireAuth` does nothing for this one: a text Work's deliverable rides inside
		// `GET /works/:id`. Only the resolver refusing a null viewer closes it.
		const res = await req(`/api/content/works/${textId}`);
		expect(res.status).toBe(200);
		const { work } = await res.json();

		expect(work.bodyHtml).toBe("");
		expect(work.body).toBe("");
		expect(work.access.canAccess).toBe(false);
		expect(work.access.reason).toBe("login_required");

		// ...and the page itself is intact, which is the other half of the rule.
		expect(work.title).toBe("Public Access essay");
		expect(work.description).toBe("The blurb, which is public.");
	});

	it("still hands the creator their own prose", async () => {
		// The owner branch sits above this refusal in the resolver, and a rule about
		// accounts must not become a rule that locks somebody out of their own Work.
		const res = await req(`/api/content/works/${textId}`, {
			headers: { Cookie: creatorCookie },
		});
		const { work } = await res.json();
		expect(work.bodyHtml).toBe(TEXT_BODY);
	});

	it("withholds every pointer at the media from a signed-out viewer", async () => {
		for (const workId of [audioId, videoId]) {
			const res = await req(`/api/content/works/${workId}`);
			expect(res.status).toBe(200);
			const { work } = await res.json();
			expect(work.transcoding.outputFileUrl, `work ${workId}`).toBeNull();
			expect(work.transcoding.hlsManifestUrl, `work ${workId}`).toBeNull();
			expect(work.sourceKey).toBe("");
		}
	});

	it("hands an asset's file to nobody without an account", async () => {
		const res = await req(`/api/content/works/${downloadId}`);
		const { work } = await res.json();
		expect(work.assets.map((a: { file: string }) => a.file)).toEqual([""]);
	});

	// ── What the refusal must NOT do ──────────────────────────────────────────

	/**
	 * 🚨 The regression this rule invites, and the reason `isFree` survives the refusal.
	 *
	 * Reading `!canAccess` as "locked" would put a padlock and "members-only work from this
	 * creator" on every Public Access Work on Discover, shown to precisely the visitor the
	 * public page exists for. The Work is free to everyone and stays free to everyone; what
	 * is missing is an account for the time to be attributed to. `presentsAsLocked` in
	 * `web-shared/post/unlock.tsx` is the browser-side half of this, and it reads exactly
	 * the two fields asserted here.
	 */
	it("🚨 still reports free work as free, and as the commons", async () => {
		const res = await req(`/api/content/works/${textId}`);
		const { work } = await res.json();
		expect(work.access.isFree).toBe(true);
		expect(work.publicAccess).toBe(true);
	});

	it("leaves a gated Work's price on the public page rather than hiding it behind a login", async () => {
		// `payment_required` and `gated` already refuse a signed-out visitor, and both tell
		// them something true about the price of entry. Collapsing them into
		// `login_required` would subtract the price from a page that is already obeying the
		// rule — so the refusal is placed where access would otherwise be GRANTED, not at
		// the top of the resolver.
		const forSale = await insertWork({
			creatorId,
			type: "text",
			title: "For sale",
			bodyHtml: TEXT_BODY,
			streamEnabled: true,
			seedAccess: [{ threshold: 0, allow: true, price: "5.00" }],
		});
		const res = await req(`/api/content/works/${forSale.id}`);
		const { work } = await res.json();
		expect(work.access.reason).toBe("payment_required");
		expect(work.access.price).toBe("5.00");
		expect(work.bodyHtml).toBe("");
	});

	// ── The allowance ─────────────────────────────────────────────────────────

	it("🚨 gives a signed-out caller no allowance, rather than an unlimited one", async () => {
		// This returned ten hours with nothing spent, which is what made anonymous
		// streaming unlimited. `limitSeconds: 0` is the honest reading — an allowance
		// belongs to an account, and there is no account here.
		const budget = await (await req("/api/subscriptions/public-access")).json();
		expect(budget.allowed).toBe(false);
		expect(budget.limitSeconds).toBe(0);
		expect(budget.usedSeconds).toBe(0);
		expect(budget.unlimited).toBe(false);
	});
});
