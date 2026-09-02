// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Share links — the one exception to "consuming a Work requires an account", and the four
 * things it must not become.
 *
 * 🚨 **Most of this file is about what a share link CANNOT open**, and that is the right
 * shape for it. The feature's whole risk is that "the recipient may watch without an account"
 * quietly grows into "the recipient may watch whatever the sharer could" — so the assertions
 * that earn their place are the refusals: a gated Work, a priced Work, an **Adult** Work, and
 * a token pointed at some other Work entirely.
 *
 * ⚠️ **The gated and priced refusals are a consequence of where ONE line sits**, not of two
 * separate checks. A share context resolves with a **null viewer** carrying `sharedBy`, and
 * `resolveAccessSync` reads `sharedBy` at exactly the branch reached by universally-free work.
 * Everything above that line runs on the ordinary rules against a viewer who has given nobody
 * anything and cannot have opted into anything.
 *
 * 🚨 **Adult and the token's scope each have a SECOND, independent guard, and sabotage is how
 * that was established rather than assumed.** Hoisting the share clause to the top of the
 * resolver turns gated and priced work red — and leaves Adult green, because the *route*
 * 404s an Adult Work before the resolver is reached, and leaves the skeleton-key test green,
 * because `requireViewerOrShareLink` refuses a token naming a different Work before that. Both
 * are genuinely layered rather than duplicated, so both are asserted **twice** below: once at
 * the surface a recipient actually lands on, and once at a delivery route, which has neither
 * of those outer guards and therefore reaches the resolver's own answer.
 *
 * The economics are the other half: viewing draws the **sharer's** month, from a budget that
 * is separate from their own ten hours, so sharing never costs the sharer anything they were
 * already spending. See `SHARE_LINK_POOL_FRACTION`.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents, shareLinks, transcodingJobs, users } from "@anthers/db/schema";
import { SHARED_PUBLIC_ACCESS_SECONDS } from "@anthers/shared/public-access";
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
const OPEN = { seedAccess: [{ threshold: 0, allow: true, price: "0" }] };
/** A creator gate: the baseline denied, a rung above it. */
const GATED = {
	seedAccess: [
		{ threshold: 0, allow: false, price: "0" },
		{ threshold: 3, allow: true, price: "0" },
	],
};
/** Free to everyone, for a price. */
const PRICED = { seedAccess: [{ threshold: 0, allow: true, price: "5.00" }] };

const TEXT_BODY = "<p>shared-prose</p>";

const id = crypto.randomUUID().slice(0, 8);
const sharerName = `sl_sharer_${id}`;
const creatorName = `sl_creator_${id}`;
const otherName = `sl_other_${id}`;

/** Mint a link straight into the table, for the Works the API would refuse to share. */
async function forceLink(sharerId: number, workId: number): Promise<string> {
	const token = `f${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 32);
	await db.insert(shareLinks).values({ token, workId, sharerId });
	return token;
}

describe("Share links", () => {
	let sharerCookie: string;
	let creatorCookie: string;
	let sharerId: number;
	let creatorId: number;
	let otherId: number;
	let openId: number;
	let openToken: string;
	let textId: number;
	let gatedId: number;
	let pricedId: number;
	let adultId: number;

	beforeAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${sharerName}, ${creatorName}, ${otherName})`,
		);
		sharerCookie = await signUp(sharerName);
		creatorCookie = await signUp(creatorName);
		await signUp(otherName);
		const rows = await db
			.select({ id: users.id, username: users.username })
			.from(users)
			.where(sql`username IN (${sharerName}, ${creatorName}, ${otherName})`);
		sharerId = rows.find((r) => r.username === sharerName)!.id;
		creatorId = rows.find((r) => r.username === creatorName)!.id;
		otherId = rows.find((r) => r.username === otherName)!.id;

		const open = await insertWork({
			creatorId,
			type: "video",
			title: "Open video",
			streamEnabled: true,
			...OPEN,
		});
		openId = open.id;
		await db.insert(transcodingJobs).values({
			workId: openId,
			mediaType: "video",
			status: "completed",
			hlsManifestUrl: "https://cdn.example.com/creators/x/videos/hls/shared/master.m3u8",
		});

		const text = await insertWork({
			creatorId,
			type: "text",
			title: "Open essay",
			bodyHtml: TEXT_BODY,
			streamEnabled: true,
			...OPEN,
		});
		textId = text.id;

		gatedId = (
			await insertWork({ creatorId, type: "text", title: "Gated", streamEnabled: true, ...GATED })
		).id;
		pricedId = (
			await insertWork({ creatorId, type: "text", title: "Priced", streamEnabled: true, ...PRICED })
		).id;
		adultId = (
			await insertWork({
				creatorId,
				type: "text",
				title: "Adult",
				maturity: "adult",
				streamEnabled: true,
				...OPEN,
			})
		).id;

		const res = await req(`/api/content/works/${openId}/share-link`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: sharerCookie },
		});
		expect(res.status).toBe(201);
		openToken = (await res.json()).token;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.execute(
			sql`DELETE FROM users WHERE username IN (${sharerName}, ${creatorName}, ${otherName})`,
		);
	});

	// ── The exception, working ────────────────────────────────────────────────

	it("lets a signed-out recipient watch free work that would otherwise need an account", async () => {
		// The rule this exists to bend. Without the token the same request is a 401 —
		// asserted in `delivery-requires-account.test.ts`, which is the other half.
		const res = await req(`/api/content/works/${openId}/hls/master.m3u8?share=${openToken}`, {
			redirect: "manual",
		});
		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(403);
	});

	it("hands over a text Work's prose, and says who shared it", async () => {
		const res = await req(`/api/content/works/${textId}?share=${await sharedTextToken()}`);
		const { work } = await res.json();
		expect(work.bodyHtml).toBe(TEXT_BODY);
		expect(work.access.canAccess).toBe(true);
		expect(work.sharedBy).toBe(sharerName);
	});

	/** A link for the text Work, minted the ordinary way. */
	async function sharedTextToken(): Promise<string> {
		const res = await req(`/api/content/works/${textId}/share-link`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: sharerCookie },
		});
		return (await res.json()).token;
	}

	it("is idempotent, so the URL somebody already pasted keeps working", async () => {
		const again = await req(`/api/content/works/${openId}/share-link`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: sharerCookie },
		});
		expect((await again.json()).token).toBe(openToken);
	});

	it("points at the Work's canonical page and nothing else", async () => {
		// The resolution endpoint answers *where*, never *whether* — a serialized Work from
		// here would be a second path to the deliverable and a second place for the rules to
		// drift.
		const res = await req(`/api/content/share/${openToken}`);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.workId).toBe(openId);
		expect(body.sharedBy).toBe(sharerName);
		expect(body).not.toHaveProperty("bodyHtml");
		expect(body).not.toHaveProperty("access");
	});

	// ── The four things it must not become ────────────────────────────────────

	it("🚨 cannot open a GATED Work, even with a token minted for it", async () => {
		const token = await forceLink(sharerId, gatedId);
		const res = await req(`/api/content/works/${gatedId}?share=${token}`);
		const { work } = await res.json();
		expect(work.access.canAccess).toBe(false);
		expect(work.bodyHtml).toBe("");
	});

	it("🚨 cannot open a PRICED Work, even with a token minted for it", async () => {
		const token = await forceLink(sharerId, pricedId);
		const res = await req(`/api/content/works/${pricedId}?share=${token}`);
		const { work } = await res.json();
		expect(work.access.canAccess).toBe(false);
		expect(work.access.reason).toBe("payment_required");
	});

	it("🚨 cannot open — or even reveal — an ADULT Work", async () => {
		/*
		 * The strongest of the four, and the reason it is stronger: Adult work is **invisible**
		 * to a signed-out visitor rather than merely locked, existence and title included. A
		 * share link is precisely the surface that would breach that, because whoever follows
		 * one has no account and therefore has no opt-in setting to consult. So this asserts a
		 * 404 rather than a denial — a response saying "this exists and you may not have it"
		 * would leak exactly what the rung withholds. The wiki's *The Rating Standard* § *A share link is a locator*.
		 */
		const token = await forceLink(sharerId, adultId);
		const res = await req(`/api/content/works/${adultId}?share=${token}`);
		expect(res.status).toBe(404);

		// ...and again one layer down. That 404 is the *route's* invisibility rule, which
		// would still fire if the resolver had been taught to trust a token — sabotage proved
		// exactly that. A delivery route has no such guard in front of it, so this is where
		// the resolver has to answer for itself: `adult_gated`, because a share context
		// carries no opt-in and can never be given one.
		const delivered = await req(`/api/content/works/${adultId}/pages/1?share=${token}`, {
			redirect: "manual",
		});
		expect(delivered.status).toBe(403);
	});

	it("🚨 a token is scoped to ONE Work and is not a skeleton key", async () => {
		// Without this the recipient would still be refused gated and Adult work — but they
		// would be drawing the sharer's budget across a catalog the sharer never shared.
		const res = await req(`/api/content/works/${textId}/pages/1?share=${openToken}`, {
			redirect: "manual",
		});
		expect(res.status).toBe(401);

		// The same refusal one layer down, at the page a recipient lands on. `viewerFor`
		// discards a token naming a different Work independently of the middleware, so a
		// token for the video reads as no token at all here.
		const { work } = await (await req(`/api/content/works/${textId}?share=${openToken}`)).json();
		expect(work.access.reason).toBe("login_required");
		expect(work.bodyHtml).toBe("");
	});

	it("refuses to mint a link for work that isn't free to everyone", async () => {
		for (const workId of [gatedId, pricedId, adultId]) {
			const res = await req(`/api/content/works/${workId}/share-link`, {
				method: "POST",
				headers: { Origin: ORIGIN, Cookie: creatorCookie },
			});
			expect(res.status, `work ${workId}`).toBe(409);
		}
	});

	it("stops working once revoked, and says no more than that", async () => {
		const target = await insertWork({
			creatorId,
			type: "text",
			title: "Revocable",
			bodyHtml: TEXT_BODY,
			streamEnabled: true,
			...OPEN,
		});
		const minted = await req(`/api/content/works/${target.id}/share-link`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: sharerCookie },
		});
		const token = (await minted.json()).token;

		await req(`/api/content/works/${target.id}/share-link`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: sharerCookie },
		});

		// 404, not 403: a link that was turned off and a link that never existed read the same
		// to whoever is holding one, and telling them apart would confirm somebody had shared
		// something.
		expect((await req(`/api/content/share/${token}`)).status).toBe(404);
		const { work } = await (await req(`/api/content/works/${target.id}?share=${token}`)).json();
		expect(work.access.canAccess).toBe(false);
	});

	// ── Whose month pays ──────────────────────────────────────────────────────

	it("🚨 attributes the time to the SHARER, flagged as a relay", async () => {
		const before = await db
			.select({ id: attentionEvents.id })
			.from(attentionEvents)
			.where(eq(attentionEvents.userId, sharerId));

		const res = await req(`/api/subscriptions/attention?share=${openToken}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				events: [{ creatorId, eventType: "watch", durationSeconds: 60, workId: openId }],
			}),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).recorded).toBe(1);

		const after = await db
			.select({
				userId: attentionEvents.userId,
				viaShareLink: attentionEvents.viaShareLink,
				publicAccess: attentionEvents.publicAccess,
			})
			.from(attentionEvents)
			.where(eq(attentionEvents.userId, sharerId));
		expect(after.length).toBe(before.length + 1);
		// The row belongs to the sharer — nobody else could be paid on behalf of a stranger —
		// and it is marked so the two budgets and the pool split can tell it apart.
		const row = after.at(-1)!;
		expect(row.viaShareLink).toBe(true);
		expect(row.publicAccess).toBe(true);
	});

	it("🚨 a session beats a token, so nobody watches on somebody else's meter", async () => {
		const res = await req(`/api/subscriptions/attention?share=${openToken}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: creatorCookie,
			},
			body: JSON.stringify({
				events: [{ creatorId, eventType: "watch", durationSeconds: 5, workId: openId }],
			}),
		});
		expect(res.status).toBe(200);

		const mine = await db
			.select({ viaShareLink: attentionEvents.viaShareLink })
			.from(attentionEvents)
			.where(eq(attentionEvents.userId, creatorId));
		// Recorded against the signed-in caller, and not as a relay. A link followed by
		// somebody with an account does nothing at all.
		expect(mine.some((r) => r.viaShareLink)).toBe(false);
	});

	it("🚨 a creator's own Work earns them nothing through their own link", async () => {
		// A share context has a null viewer, so the owner branch never fires and `isFree` comes
		// back true — the same refusal has to be made at the stamp instead, or the sharer's
		// Time Pool would pay the sharer. The seconds are still recorded, because the relay
		// budget bounds how much viewing one account may fund and this is the case most in
		// need of a bound.
		const mine = await insertWork({
			creatorId: sharerId,
			type: "text",
			title: "My own",
			bodyHtml: TEXT_BODY,
			streamEnabled: true,
			...OPEN,
		});
		const minted = await req(`/api/content/works/${mine.id}/share-link`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: sharerCookie },
		});
		const token = (await minted.json()).token;

		await req(`/api/subscriptions/attention?share=${token}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				events: [{ creatorId: sharerId, eventType: "read", durationSeconds: 30, workId: mine.id }],
			}),
		});

		const rows = await db
			.select({ publicAccess: attentionEvents.publicAccess })
			.from(attentionEvents)
			.where(eq(attentionEvents.workId, mine.id));
		expect(rows.length).toBe(1);
		expect(rows[0].publicAccess).toBe(false);
	});

	it("bounds the relay at a flat budget that the Public Access price does not lift", async () => {
		// Giving Anthers the Public Access price removes the limit on *your* viewing and buys
		// no relay for strangers. Deriving the relay budget from the sharer's own allowance
		// would make an unlimited account's relay unlimited — anonymous unmetered streaming,
		// for $3 a month and one link.
		await db.execute(sql`UPDATE accounts SET anthers_support = '12' WHERE user_id = ${otherId}`);
		const spender = await insertWork({
			creatorId,
			type: "text",
			title: "Relay bound",
			bodyHtml: TEXT_BODY,
			streamEnabled: true,
			...OPEN,
		});
		const token = await forceLink(otherId, spender.id);
		await db.insert(attentionEvents).values({
			userId: otherId,
			creatorId,
			workId: spender.id,
			eventType: "read",
			durationSeconds: SHARED_PUBLIC_ACCESS_SECONDS,
			publicAccess: true,
			viaShareLink: true,
		});

		const { work } = await (await req(`/api/content/works/${spender.id}?share=${token}`)).json();
		// Still free, still the commons, still reachable — what ran out belongs to the sharer.
		expect(work.access.isFree).toBe(true);
		expect(work.bodyHtml).toBe("");
	});
});
