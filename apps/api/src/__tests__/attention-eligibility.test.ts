// SPDX-License-Identifier: Apache-2.0
/**
 * Server-side attention eligibility on POST /api/subscriptions/attention.
 *
 * `distribute-pool` sums `attention_events.duration_seconds` per creator and splits the
 * Time Pool proportionally, nightly — so a row in that table is money. The eligibility
 * rule that decides which seconds may become a row is that only a **Work** earns; posts,
 * project pages, profiles, discovery and comments are connective tissue and earn nothing.
 *
 * That rule used to be a filter inside the endpoint, policed against a schema whose column
 * said `post_id`. It is now structural — a claim names a Work or it is not a claim about
 * anything that earns — which is what these tests pin.
 *
 * The range bounds are not a substitute for eligibility and never were: they bound
 * *when* a claim could have happened — nothing in the future, nothing older than a
 * flush — and have nothing to say about *attribution*. A hand-written request could
 * carry a perfectly formed range while crediting `read` seconds against a creator who
 * had nothing to do with the Work. These tests are about attribution.
 *
 * Policy itself lives in `packages/shared/src/attention.ts` and is unit-tested there; what's
 * asserted here is that the endpoint actually consults it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents, workAssets, workBuilds } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const account = await createAccount(username);
	return {
		cookie: account.cookie,
		id: account.userId,
	};
}

type Event = {
	creatorId: number;
	eventType: string;
	durationSeconds: number;
	workId?: number;
	startedAt?: number;
	endedAt?: number;
	clientId?: string;
};

/**
 * A timed claim has to carry the range it claims happened: start/end within the
 * flush lookback, and a clientId. These helpers decorate the old duration-only
 * fixtures so eligibility — not the range bounds — is what decides each case.
 */
function withRange(e: Event, i: number): Event {
	if (e.durationSeconds <= 0) return e;
	const now = Date.now();
	return {
		...e,
		startedAt: now - e.durationSeconds * 1_000 - 1_000,
		endedAt: now - 1_000,
		clientId: `elig-${Date.now().toString(36)}-${i}-${Math.random().toString(36).slice(2, 8)}`,
	};
}

async function claim(cookie: string, events: Event[]) {
	const res = await req("/api/subscriptions/attention", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ events: events.map(withRange) }),
	});
	expect(res.status).toBe(200);
	return res.json();
}

/** Seconds this user has ever been credited toward this creator. */
async function creditedTo(userId: number, creatorId: number): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(and(eq(attentionEvents.userId, userId), eq(attentionEvents.creatorId, creatorId)));
	return row?.total ?? 0;
}

const FREE = [{ threshold: 0, allow: true, price: "0" }];
const LOCKED = [{ threshold: 0, allow: false, price: "0" }];

let user: { cookie: string; id: number };
let creator: { cookie: string; id: number };
let bystander: { cookie: string; id: number };

/** Released, free video Work → earns "watch". */
let videoWorkId: number;
/** Released, free text Work → earns "read". Prose in the Catalog earns; a post body doesn't. */
let textWorkId: number;
/** Released video Work, locked to everyone. */
let lockedWorkId: number;
/** A video Work still staging — never released, so not publicly consumable. */
let privateWorkId: number;
/**
 * A game carrying only downloadable builds → no browser deliverable, so its page is a
 * storefront and earns nothing.
 */
let downloadOnlyGameId: number;
/**
 * Both delivery flags on, but still only downloadable files. Stream being enabled does
 * not invent a browser deliverable — the files remain the only way to play it.
 */
let filesOnlyGameId: number;
/** A game with a hosted browser build → its page plays it, so it earns. */
let hostedBuildGameId: number;
/** A game with an external embed → it plays in the page, so it earns. */
let embeddedGameId: number;

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	user = await signUp(`eligviewer${stamp}`);
	creator = await signUp(`eligcreator${stamp}`);
	bystander = await signUp(`eligbystander${stamp}`);

	// Inserted rather than created through the API: creating a video Work queues a
	// transcode, and pg-boss isn't running in the test process.
	videoWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "A Film",
			access: FREE,
		})
	).id;
	textWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "text",
			title: "An Essay",
			bodyHtml: "<p>prose that earns, because it is a Work</p>",
			access: FREE,
		})
	).id;
	lockedWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "A Locked Film",
			access: LOCKED,
		})
	).id;
	privateWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "Still Editing",
			visibility: "private",
			access: FREE,
		})
	).id;

	downloadOnlyGameId = (
		await insertWork({
			creatorId: creator.id,
			type: "game",
			title: "A Download",
			access: FREE,
			streamEnabled: false,
			downloadEnabled: true,
		})
	).id;
	filesOnlyGameId = (
		await insertWork({
			creatorId: creator.id,
			type: "game",
			title: "Stream and Download, Files Only",
			access: FREE,
			streamEnabled: true,
			downloadEnabled: true,
		})
	).id;
	hostedBuildGameId = (
		await insertWork({
			creatorId: creator.id,
			type: "game",
			title: "Plays in the Browser",
			access: FREE,
			streamEnabled: true,
		})
	).id;
	embeddedGameId = (
		await insertWork({
			creatorId: creator.id,
			type: "game",
			title: "Embedded",
			access: FREE,
			streamEnabled: true,
			embedUrl: "https://example.com/play",
		})
	).id;

	// The only difference between the two halves is this: file rows on the Work, or a
	// primary browser build. Both are legitimate released Works of the same type.
	await db.insert(workAssets).values(
		[downloadOnlyGameId, filesOnlyGameId].map((workId, i) => ({
			workId,
			file: `creators/${creator.id}/assets/eligibility-game-${i}.zip`,
			filename: `eligibility-game-${i}.zip`,
			fileSize: 100,
			mimeType: "application/zip",
			platform: "windows",
			isPrimary: true,
		})),
	);
	await db.insert(workBuilds).values({
		workId: hostedBuildGameId,
		entryPath: "index.html",
		isPrimary: true,
	});
}, DB_SETUP_TIMEOUT);

describe("attention eligibility is decided server-side", () => {
	it("credits time against a Work whose type earns it", async () => {
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 30, workId: videoWorkId },
			{ creatorId: creator.id, eventType: "read", durationSeconds: 20, workId: textWorkId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(user.id, creator.id)).toBe(before + 50);
	});

	it("refuses an event type the Work's own type doesn't earn", async () => {
		// A text Work has no video, so "watch" against it is not a real observation.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: textWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});

	it("refuses time credited to someone who isn't the Work's creator", async () => {
		// Straightforward attribution forgery: real Work, right type, wrong payee.
		const before = await creditedTo(user.id, bystander.id);
		const body = await claim(user.cookie, [
			{ creatorId: bystander.id, eventType: "watch", durationSeconds: 60, workId: videoWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, bystander.id)).toBe(before);
	});

	it("refuses time against a Work the user can't access", async () => {
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: lockedWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});

	it("refuses time against a Work that hasn't been released", async () => {
		// Private staging is not public consumption. The Work is free and the user would
		// clear its gate — being unreleased is the whole reason this is refused.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: privateWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});

	it("refuses time against a download-only Work whose page is a storefront", async () => {
		// The Work is free and released, and its page is all a reader meets — but the page
		// carries the download card rather than a medium, so a `play` range there says a
		// person played something they never opened. This is the record Parker's activity
		// history showed for a downloadable title.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "play", durationSeconds: 60, workId: downloadOnlyGameId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});

	it("refuses time against a files-only Work even when streaming is switched on", async () => {
		// `streamEnabled` alone does not create a browser deliverable. With only
		// downloadable builds the page still renders the download card.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "play", durationSeconds: 60, workId: filesOnlyGameId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});

	it("credits time against a build Work that plays in the browser", async () => {
		// A hosted build and an embed are both browser deliverables; their pages mount
		// the thing itself, so time there is consumption.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "play", durationSeconds: 30, workId: hostedBuildGameId },
			{ creatorId: creator.id, eventType: "play", durationSeconds: 20, workId: embeddedGameId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(user.id, creator.id)).toBe(before + 50);
	});

	it("refuses time with no Work context at all", async () => {
		// A claim naming no Work is connective tissue by definition — a post, a profile,
		// discovery. This is the shape a naive forged request takes.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60 },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});

	it("refuses time against a Work that doesn't exist", async () => {
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: 2_000_000_000 },
		]);
		expect(body.ineligible).toBe(1);
	});

	it("refuses time a creator claims on their own Work", async () => {
		// The account the seconds would be recorded against is the Work's own creator, so
		// this is a creator paying themselves out of the Time Pool for watching themselves.
		const before = await creditedTo(creator.id, creator.id);
		const body = await claim(creator.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, workId: videoWorkId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(creator.id, creator.id)).toBe(before);
	});

	it("still records zero-duration visit pings, with or without a Work", async () => {
		// These carry no time so they cannot over-credit, and they are deliberately the
		// analytics signal for surfaces that earn nothing. Dropping them would lose that.
		const before = await creditedTo(user.id, creator.id);
		const body = await claim(user.cookie, [
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0 },
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0, workId: videoWorkId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(user.id, creator.id)).toBe(before);
	});
});
