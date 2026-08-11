// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Peer discovery — the membership list for the swarm (45.01 § 3).
 *
 * Two suites, because there are two genuinely different things to be sure of.
 *
 * **The guard** is pure and gets hammered: which URLs may be announced, and which addresses
 * the hub may be talked into contacting. This is the SSRF surface — the one place in the
 * codebase where a user hands us a URL and we make a request to it — so it is tested as a
 * function, with an injected resolver, rather than only through the route where a mistake
 * would be masked by the probe failing anyway.
 *
 * **The routes** are the behaviour: who may announce, who may list, what a lease does, and
 * that a peer nobody can reach never makes it onto anyone's list.
 *
 * What is deliberately NOT asserted here: that a listed peer serves correct bytes. It
 * cannot be made to — every downloader verifies every chunk against the manifest no matter
 * who served it, which is `apps/anthersp2p/src/swarm.test.ts`'s subject. A peer list is a
 * convenience, and the tests are shaped to keep it from quietly becoming a trust statement.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, p2pPeers, users, works } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import {
	isBlockedAddress,
	normalizeOrigin,
	originIsContactable,
	PEERS_PER_USER_PER_ASSET,
} from "../p2p/peers";
import { _setPrivateKeyForTest, generateKeyPair } from "../p2p/token";
import { storage } from "../services/storage/index.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const ORIGIN = "http://localhost:3000";
const req = (path: string, options?: RequestInit) =>
	app.fetch(new Request(`http://localhost${path}`, options));

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

// ─────────────────────────────────────────────────────────────────────────────────────
// The guard
// ─────────────────────────────────────────────────────────────────────────────────────

describe("what may be announced", () => {
	const strict = { allowInsecure: false };

	it("accepts an https origin and normalizes it", () => {
		// Normalization is what makes the unique index mean something: the same host written
		// three ways has to become one row, or it occupies three slots in every peer list.
		for (const raw of [
			"https://seed.example.org",
			"https://Seed.Example.ORG/",
			"https://seed.example.org:443",
		]) {
			const result = normalizeOrigin(raw, strict);
			expect(result).toEqual({ origin: "https://seed.example.org" });
		}
		expect(normalizeOrigin("https://seed.example.org:8443", strict)).toEqual({
			origin: "https://seed.example.org:8443",
		});
	});

	it("refuses http, because a browser on an https page cannot fetch it at all", () => {
		// Not a posture choice. Mixed content is blocked, so listing an http peer would
		// advertise a host the primary downloader is structurally unable to use.
		expect(normalizeOrigin("http://seed.example.org", strict)).toEqual({ rejected: "scheme" });
	});

	it("refuses schemes that are not http(s) at all", () => {
		for (const raw of ["file:///etc/passwd", "gopher://example.org", "ftp://example.org"]) {
			expect(normalizeOrigin(raw, strict)).toEqual({ rejected: "scheme" });
		}
	});

	it("refuses embedded credentials and anything beyond a bare origin", () => {
		expect(normalizeOrigin("https://u:p@seed.example.org", strict)).toEqual({
			rejected: "credentials",
		});
		// A path would aim the hub's probe at somebody else's endpoint.
		expect(normalizeOrigin("https://seed.example.org/some/path", strict)).toEqual({
			rejected: "path",
		});
		expect(normalizeOrigin("https://seed.example.org/?x=1", strict)).toEqual({ rejected: "path" });
		expect(normalizeOrigin("not a url", strict)).toEqual({ rejected: "not_a_url" });
	});

	it("allows http only when the insecure escape hatch is explicitly on", () => {
		expect(normalizeOrigin("http://localhost:8080", { allowInsecure: true })).toEqual({
			origin: "http://localhost:8080",
		});
	});
});

describe("addresses the hub must never be talked into contacting", () => {
	it("blocks every private, loopback, link-local and reserved IPv4 range", () => {
		for (const addr of [
			"0.0.0.0",
			"10.0.0.1",
			"127.0.0.1",
			"169.254.169.254", // the cloud metadata address — the one that matters most
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"100.64.0.1", // carrier-grade NAT
			"192.0.0.1",
			"198.18.0.1",
			"224.0.0.1",
			"255.255.255.255",
		]) {
			expect({ addr, blocked: isBlockedAddress(addr) }).toEqual({ addr, blocked: true });
		}
	});

	it("blocks the IPv6 equivalents, including the v4-mapped form", () => {
		for (const addr of [
			"::1",
			"::",
			"fe80::1",
			"fd00::1",
			"fc00::1",
			"ff02::1",
			// The usual bypass: an allow-list that only understands dotted quads sees this as
			// an opaque IPv6 address and lets it through to a loopback connection.
			"::ffff:127.0.0.1",
			"::ffff:169.254.169.254",
		]) {
			expect({ addr, blocked: isBlockedAddress(addr) }).toEqual({ addr, blocked: true });
		}
	});

	it("permits ordinary public addresses", () => {
		for (const addr of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"]) {
			expect({ addr, blocked: isBlockedAddress(addr) }).toEqual({ addr, blocked: false });
		}
	});

	it("checks EVERY address a hostname resolves to, not just the first", async () => {
		// A hostname with one public and one private record is the interesting case: check
		// only the first and the guard passes, and the request then goes out on whichever
		// address the OS happens to pick.
		const mixed = await originIsContactable("https://sneaky.example.org", {
			allowInsecure: false,
			resolve: async () => ["93.184.216.34", "10.0.0.7"],
		});
		expect(mixed).toEqual({ rejected: "private_address" });

		const clean = await originIsContactable("https://honest.example.org", {
			allowInsecure: false,
			resolve: async () => ["93.184.216.34"],
		});
		expect(clean).toEqual({ ok: true });
	});

	it("refuses a hostname that resolves to nothing", async () => {
		expect(
			await originIsContactable("https://nowhere.example.org", {
				allowInsecure: false,
				resolve: async () => [],
			}),
		).toEqual({ rejected: "unresolvable" });
		expect(
			await originIsContactable("https://broken.example.org", {
				allowInsecure: false,
				resolve: async () => {
					throw new Error("SERVFAIL");
				},
			}),
		).toEqual({ rejected: "unresolvable" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The routes
// ─────────────────────────────────────────────────────────────────────────────────────

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `peers_${id}`;
const viewerName = `peers_viewer_${id}`;
const FILE_SIZE = 300 * 1024;
const STORAGE_KEY = `test/p2p-peers-${id}/file.zip`;

function testBytes(size: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(size);
	let state = 0x2468ace0;
	for (let i = 0; i < size; i++) {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		out[i] = (state >> 16) & 0xff;
	}
	return out;
}

/**
 * A stand-in seeder: answers `/health` for this asset and 401s an unauthenticated chunk
 * request, which is exactly what `anthersp2p seed` does.
 *
 * `answersChunkZero` makes it misbehave on demand. A host that hands chunk 0 to an
 * anonymous request is not running the token check, and the probe treats a 401 as the pass.
 */
function fakeSeeder(opts: { assetId: number; healthy?: boolean; openServer?: boolean }) {
	return Bun.serve({
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/health") {
				if (opts.healthy === false) return new Response("no", { status: 503 });
				return Response.json({ status: "ok", assetId: opts.assetId, chunks: 2 });
			}
			if (path.includes("/chunks/0")) {
				if (opts.openServer) return new Response(new Uint8Array(16), { status: 200 });
				return new Response("Token required", { status: 401 });
			}
			return new Response("no", { status: 404 });
		},
	});
}

describe("peer discovery over the API", () => {
	let creatorCookie: string;
	let viewerCookie: string;
	let workId: number;
	let assetId: number;
	const servers: ReturnType<typeof Bun.serve>[] = [];

	beforeAll(async () => {
		// The probe targets are localhost, which the guard exists to refuse. This is the
		// escape hatch it documents, and setting it here is also what keeps the guard's own
		// tests above honest: they run against the strict policy, not this one.
		process.env.P2P_ALLOW_INSECURE_PEERS = "1";

		const kp = await generateKeyPair();
		_setPrivateKeyForTest(kp.privateKeyB64);

		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
		creatorCookie = await signUp(creatorName);
		viewerCookie = await signUp(viewerName);

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorName))
			.limit(1);

		const work = await insertWork({
			creatorId: creator.id,
			type: "game",
			title: "Peer Discovery Test",
			downloadEnabled: true,
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		workId = work.id;

		await storage.upload(STORAGE_KEY, testBytes(FILE_SIZE), "application/zip", "private");
		const [asset] = await db
			.insert(assets)
			.values({
				workId,
				file: STORAGE_KEY,
				filename: "peers.zip",
				fileSize: FILE_SIZE,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			})
			.returning();
		assetId = asset.id;

		// Force the manifest to be built and stored: the announce probe checks chunk 0
		// against it, so an asset that has never been hashed cannot accept a peer.
		const res = await req(`/api/p2p/works/${workId}/assets/${assetId}/manifest`, {
			method: "POST",
			headers: { Cookie: viewerCookie, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		for (const s of servers) s.stop(true);
		await db.delete(p2pPeers).where(eq(p2pPeers.workId, workId));
		await storage.delete(STORAGE_KEY).catch(() => {});
		await db.delete(assets).where(eq(assets.workId, workId));
		await db.delete(works).where(eq(works.id, workId));
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerName})`);
		process.env.P2P_ALLOW_INSECURE_PEERS = undefined as unknown as string;
	});

	const announce = (url: string, cookie: string) =>
		req(`/api/p2p/works/${workId}/assets/${assetId}/announce`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
			body: JSON.stringify({ url }),
		});

	const listPeers = (cookie?: string) =>
		req(`/api/p2p/works/${workId}/assets/${assetId}/peers`, {
			headers: cookie ? { Cookie: cookie } : {},
		});

	it("lists a peer that answers the probe, and drops it on withdrawal", async () => {
		const seeder = fakeSeeder({ assetId });
		servers.push(seeder);
		const origin = `http://localhost:${seeder.port}`;

		const res = await announce(origin, viewerCookie);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.origin).toBe(origin);
		expect(body.renewed).toBe(false);
		expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

		const listed = await listPeers(viewerCookie);
		expect(listed.status).toBe(200);
		expect((await listed.json()).peers).toContain(origin);

		const withdrawn = await req(`/api/p2p/works/${workId}/assets/${assetId}/announce`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json", Cookie: viewerCookie, Origin: ORIGIN },
			body: JSON.stringify({ url: origin }),
		});
		expect((await withdrawn.json()).withdrawn).toBe(true);
		expect((await (await listPeers(viewerCookie)).json()).peers).not.toContain(origin);
	});

	it("re-announcing renews the lease instead of stacking a second row", async () => {
		const seeder = fakeSeeder({ assetId });
		servers.push(seeder);
		const origin = `http://localhost:${seeder.port}`;

		expect((await announce(origin, viewerCookie)).status).toBe(200);
		const second = await announce(origin, viewerCookie);
		expect(second.status).toBe(200);
		expect((await second.json()).renewed).toBe(true);

		const rows = await db
			.select({ id: p2pPeers.id })
			.from(p2pPeers)
			.where(eq(p2pPeers.url, origin));
		expect(rows.length).toBe(1);
	});

	it("refuses a host that does not answer as a seeder for this asset", async () => {
		// The whole point of probing: the hub's peer list is a recommendation, and anyone
		// who could put an arbitrary URL on it could point a crowd of downloaders at a host
		// that never volunteered.
		const wrongAsset = fakeSeeder({ assetId: assetId + 9999 });
		const down = fakeSeeder({ assetId, healthy: false });
		servers.push(wrongAsset, down);

		for (const s of [wrongAsset, down]) {
			const res = await announce(`http://localhost:${s.port}`, viewerCookie);
			expect(res.status).toBe(400);
			expect((await res.json()).reason).toBe("unreachable");
		}

		// And a port with nothing listening on it at all.
		const dead = await announce("http://localhost:1", viewerCookie);
		expect(dead.status).toBe(400);
		expect((await dead.json()).reason).toBe("unreachable");
	});

	it("refuses a host that serves chunk 0 to an anonymous request", async () => {
		// A seeder that skips the token check is an open file server, not a swarm member —
		// 45.03's boundary is drawn by the check, so a host that doesn't run it isn't inside.
		const open = fakeSeeder({ assetId, openServer: true });
		servers.push(open);
		const res = await announce(`http://localhost:${open.port}`, viewerCookie);
		expect(res.status).toBe(400);
		expect((await res.json()).reason).toBe("unreachable");
	});

	it("refuses an http origin unless the insecure escape hatch is on", async () => {
		const previous = process.env.P2P_ALLOW_INSECURE_PEERS;
		process.env.P2P_ALLOW_INSECURE_PEERS = "0";
		try {
			const res = await announce("http://seed.example.org", viewerCookie);
			expect(res.status).toBe(400);
			expect((await res.json()).reason).toBe("scheme");
		} finally {
			process.env.P2P_ALLOW_INSECURE_PEERS = previous;
		}
	});

	it("caps how many peers one account may advertise for one asset", async () => {
		const mine: ReturnType<typeof Bun.serve>[] = [];
		for (let i = 0; i < PEERS_PER_USER_PER_ASSET + 1; i++) {
			const s = fakeSeeder({ assetId });
			mine.push(s);
			servers.push(s);
		}
		// Clear anything earlier tests left so the cap is measured from a known floor.
		await db.delete(p2pPeers).where(eq(p2pPeers.assetId, assetId));

		const results: number[] = [];
		for (const s of mine) {
			results.push((await announce(`http://localhost:${s.port}`, creatorCookie)).status);
		}
		expect(results.slice(0, PEERS_PER_USER_PER_ASSET)).toEqual(
			new Array(PEERS_PER_USER_PER_ASSET).fill(200),
		);
		expect(results.at(-1)).toBe(400);
	});

	it("will not let a second account take over a live peer's URL", async () => {
		// Otherwise an account could claim a host somebody else is running, inherit its slot,
		// and stop renewing it — a way to quietly evict a peer you do not operate.
		await db.delete(p2pPeers).where(eq(p2pPeers.assetId, assetId));
		const seeder = fakeSeeder({ assetId });
		servers.push(seeder);
		const origin = `http://localhost:${seeder.port}`;

		expect((await announce(origin, viewerCookie)).status).toBe(200);
		const stolen = await announce(origin, creatorCookie);
		expect(stolen.status).toBe(400);
		expect((await stolen.json()).reason).toBe("too_many");
	});

	it("hides expired leases without anything having to sweep them", async () => {
		await db.delete(p2pPeers).where(eq(p2pPeers.assetId, assetId));
		const seeder = fakeSeeder({ assetId });
		servers.push(seeder);
		const origin = `http://localhost:${seeder.port}`;
		expect((await announce(origin, viewerCookie)).status).toBe(200);

		// Reach in and expire it, the way a seeder that crashed would.
		await db
			.update(p2pPeers)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(p2pPeers.url, origin));

		expect((await (await listPeers(viewerCookie)).json()).peers).not.toContain(origin);
	});

	it("does not tell an unentitled viewer who is serving", async () => {
		// Private-by-default (40.03) reads on the peer list too: that a Work has peers is a
		// fact about a Work you cannot open.
		const gated = await insertWork({
			creatorId: (
				await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.username, creatorName))
					.limit(1)
			)[0].id,
			type: "game",
			title: "Gated",
			downloadEnabled: true,
			anthersAccess: [{ threshold: 99, allow: true, price: "0" }],
		});
		const [gatedAsset] = await db
			.insert(assets)
			.values({
				workId: gated.id,
				file: STORAGE_KEY,
				filename: "gated.zip",
				fileSize: FILE_SIZE,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			})
			.returning();

		const res = await req(`/api/p2p/works/${gated.id}/assets/${gatedAsset.id}/peers`, {
			headers: { Cookie: viewerCookie },
		});
		expect(res.status).toBe(403);

		await db.delete(assets).where(eq(assets.id, gatedAsset.id));
		await db.delete(works).where(eq(works.id, gated.id));
	});
});
