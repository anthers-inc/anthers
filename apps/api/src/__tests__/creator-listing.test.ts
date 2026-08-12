// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The creator listing's derived columns, and the reason this file exists.
 *
 * 🚨 Every count on `/api/accounts/creators` was **silently wrong** until 2026-08-11.
 * The correlated subqueries interpolated `${users.id}` inside a `sql` template sitting in
 * a SELECT list, which drizzle renders **unqualified** — bare `"id"`. Inside
 * `SELECT ... FROM follows` that binds to `follows.id`, so `WHERE creator_id = ${users.id}`
 * was really `WHERE creator_id = follows.id`. Postgres raised nothing, the response shape
 * was right, and a creator with followers reported `followerCount: 0`.
 *
 * That is why every assertion here compares against a **separately counted truth** rather
 * than against the route's own arithmetic: an assertion derived from the implementation
 * would have agreed with the broken version just as happily. Verified to fail against the
 * unqualified form before being committed against the fixed one.
 *
 * `mediums` is covered here too — it is the field /subscribe's medium chips shuffle on,
 * and it shares the same correlation, so it shares the same failure mode.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { follows, users, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const ORIGIN = "http://localhost:3000";

interface ListedCreator {
	id: number;
	username: string;
	followerCount: number;
	projectCount: number;
	isFollowing: boolean;
	mediums?: string[];
}

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
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

async function listCreators(cookie?: string): Promise<ListedCreator[]> {
	const res = await req("/api/accounts/creators", {
		headers: cookie ? { Cookie: cookie } : {},
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { creators: ListedCreator[] }).creators;
}

const id = crypto.randomUUID().slice(0, 8);
const makerName = `cl_maker_${id}`;
const fanName = `cl_fan_${id}`;

let makerId: number;
let fanCookie: string;

beforeAll(async () => {
	await signUp(makerName);
	fanCookie = await signUp(fanName);

	const [maker] = await db.select().from(users).where(eq(users.username, makerName));
	makerId = maker.id;
	await db.update(users).set({ isCreator: true }).where(eq(users.id, makerId));

	// Two released Works of different types, plus one that is NOT released — the
	// unreleased one is what proves `mediums` describes the public catalog rather than
	// everything on disk.
	const base = {
		creatorId: makerId,
		title: "fixture",
		streamEnabled: true,
		anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		seedAccess: [],
	};
	// `public_id` is unique, so it has to vary per run or the second run dies on the
	// insert rather than on an assertion — which is the failure that hides a real one.
	const pid = 940_000_000 + (Number.parseInt(id, 16) % 900_000) * 3;
	await db.insert(works).values([
		{ ...base, publicId: pid, slug: `cl-video-${id}`, type: "video", visibility: "released" },
		{ ...base, publicId: pid + 1, slug: `cl-audio-${id}`, type: "audio", visibility: "released" },
		{ ...base, publicId: pid + 2, slug: `cl-draft-${id}`, type: "game", visibility: "private" },
	]);

	await req(`/api/accounts/users/${makerName}/follow`, {
		method: "POST",
		headers: { Origin: ORIGIN, Cookie: fanCookie },
	});
}, DB_SETUP_TIMEOUT);

describe("creator listing — derived columns", () => {
	it("reports the follower count the follows table actually holds", async () => {
		// Truth counted independently of the route, so a wrong route can't define right.
		const actual = await db.select().from(follows).where(eq(follows.creatorId, makerId));
		expect(actual.length).toBeGreaterThan(0);

		const listed = (await listCreators()).find((c) => c.id === makerId);
		expect(listed).toBeDefined();
		expect(listed?.followerCount).toBe(actual.length);
	});

	it("reports the mediums the creator has actually released, and not the drafts", async () => {
		const listed = (await listCreators()).find((c) => c.id === makerId);
		expect(listed?.mediums?.slice().sort()).toEqual(["audio", "video"]);
		// The private Work's type must not appear: a draft is not something anyone can find.
		expect(listed?.mediums).not.toContain("game");
	});

	it("tells a signed-in follower that they follow, and a stranger that they do not", async () => {
		const asFan = (await listCreators(fanCookie)).find((c) => c.id === makerId);
		expect(asFan?.isFollowing).toBe(true);

		const asStranger = (await listCreators()).find((c) => c.id === makerId);
		expect(asStranger?.isFollowing).toBe(false);
	});
});
