// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The P2P signaling relay (45.01 § 3, gated by 45.05's token).
 *
 * This suite drives REAL WebSockets against a REAL `Bun.serve`, which every other API
 * suite avoids — they all do `app.fetch(new Request(...))`, and that cannot reach this
 * code at all. A WebSocket upgrade needs the Bun server object, Hono never sees one, and
 * the relay lives ahead of Hono for exactly that reason. So the test server here is built
 * from the same two exports `server.ts` composes (`tryUpgradeSignaling` +
 * `signalingWebSocket`); what it does not cover is the three lines of wiring in
 * `server.ts` itself, which the typechecker does.
 *
 * No database. The relay verifies a token with the hub's own key and keeps presence in
 * memory, so a signaling test needs neither Postgres nor a Work — which is also the
 * property that makes signaling ~100× cheaper than chunk serving.
 *
 * What is deliberately asserted here, beyond "it relays":
 * - The socket is USELESS before its auth frame, and dies if one never comes.
 * - The peer id is the hub's, not the client's. The spike let the client choose, which
 *   let any peer claim another's id and intercept its signaling.
 * - The asset is the swarm boundary — for discovery AND for relaying. A peer vouched for
 *   asset X can neither see nor message a peer on asset Y.
 * - Every bound holds: sockets per user, frames per window, bytes per frame.
 * - Presence is released on close, so "bounded in memory" is a property with a test and
 *   not a hope.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { InMemoryPeerRegistry, type PeerRecord } from "../p2p/registry";
import {
	_limits,
	_resetSignalingForTest,
	_setAuthTimeoutForTest,
	_setMaxSocketsForTest,
	peerRegistry,
	SIGNAL_PATH,
	type SignalSocketData,
	signalingWebSocket,
	tryUpgradeSignaling,
} from "../p2p/signaling";
import { _resetKeyCache, _setPrivateKeyForTest, generateKeyPair, mintP2pToken } from "../p2p/token";

const ASSET_A = 4201;
const ASSET_B = 4202;
const WORK = 77;
const USER = 501;

/** Shorter than the 10s production deadline, so the timeout is testable in milliseconds. */
const TEST_AUTH_TIMEOUT_MS = 150;

let server: Server<SignalSocketData>;
let baseUrl: string;

/**
 * A test peer: a real client socket with a message queue.
 *
 * `next()` fails loudly on a timeout rather than hanging, because a relay bug's natural
 * shape is "the message never arrives" and a suite that stalls for thirty seconds tells
 * you far less than one that says which frame went missing.
 */
interface TestPeer {
	send(message: unknown): void;
	next(what?: string): Promise<Record<string, unknown>>;
	closed(): Promise<{ code: number; reason: string }>;
	disconnect(): void;
	peerId: string;
}

const openPeers: TestPeer[] = [];

async function connect(): Promise<TestPeer> {
	const ws = new WebSocket(`${baseUrl}${SIGNAL_PATH}`);
	const queue: Record<string, unknown>[] = [];
	const waiters: ((m: Record<string, unknown>) => void)[] = [];
	let closeInfo: { code: number; reason: string } | null = null;
	const closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];

	ws.addEventListener("message", (event) => {
		const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
		const waiter = waiters.shift();
		if (waiter) waiter(parsed);
		else queue.push(parsed);
	});
	ws.addEventListener("close", (event) => {
		closeInfo = { code: event.code, reason: event.reason };
		for (const w of closeWaiters.splice(0)) w(closeInfo);
		// Release anyone waiting on a message that is now never coming, so the failure is
		// an assertion about the frame rather than a timeout.
		for (const w of waiters.splice(0)) w({ t: "__socket_closed__", code: event.code });
	});

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
	});

	const peer: TestPeer = {
		peerId: "",
		send(message) {
			ws.send(typeof message === "string" ? message : JSON.stringify(message));
		},
		next(what = "a frame") {
			const queued = queue.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise<Record<string, unknown>>((resolve, reject) => {
				const timer = setTimeout(() => {
					const i = waiters.indexOf(push);
					if (i >= 0) waiters.splice(i, 1);
					reject(new Error(`timed out waiting for ${what}`));
				}, 3000);
				const push = (m: Record<string, unknown>) => {
					clearTimeout(timer);
					resolve(m);
				};
				waiters.push(push);
			});
		},
		closed() {
			if (closeInfo) return Promise.resolve(closeInfo);
			return new Promise<{ code: number; reason: string }>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("socket never closed")), 3000);
				closeWaiters.push((c) => {
					clearTimeout(timer);
					resolve(c);
				});
			});
		},
		disconnect() {
			ws.close();
		},
	};
	openPeers.push(peer);
	return peer;
}

/** Connect and authenticate in one step — the shape every test but the auth ones wants. */
async function join(
	opts: { assetId?: number; userId?: number; ttlSeconds?: number } = {},
): Promise<TestPeer> {
	const peer = await connect();
	const token = await mintP2pToken({
		workId: WORK,
		assetId: opts.assetId ?? ASSET_A,
		userId: opts.userId ?? USER,
		ttlSeconds: opts.ttlSeconds,
	});
	peer.send({ t: "auth", token });
	const ready = await peer.next("ready");
	expect(ready.t).toBe("ready");
	peer.peerId = ready.peerId as string;
	return peer;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("P2P signaling relay", () => {
	beforeAll(async () => {
		const kp = await generateKeyPair();
		_setPrivateKeyForTest(kp.privateKeyB64);
		_setAuthTimeoutForTest(TEST_AUTH_TIMEOUT_MS);

		server = Bun.serve({
			port: 0,
			fetch(req, srv) {
				const signal = tryUpgradeSignaling(req, srv);
				if (signal) return signal.upgraded ? undefined : signal.response;
				// Stands in for the Hono app: anything the relay declines must fall through
				// to routing rather than being swallowed.
				return new Response("fell through to the app", { status: 404 });
			},
			websocket: signalingWebSocket,
		});
		baseUrl = `ws://localhost:${server.port}`;
	});

	afterEach(async () => {
		for (const peer of openPeers.splice(0)) peer.disconnect();
		// Let the close handlers run before the next test reads the registry.
		await sleep(20);
		_resetSignalingForTest();
	});

	afterAll(() => {
		server.stop(true);
		_setAuthTimeoutForTest(10_000);
		_resetKeyCache();
	});

	// ── Routing: what the relay claims, and what it lets past ────────────────────────

	it("lets every other path fall through to the app", async () => {
		const res = await fetch(`http://localhost:${server.port}/api/content/works`);
		expect(res.status).toBe(404);
		expect(await res.text()).toBe("fell through to the app");
	});

	it("answers a plain GET on the signaling path with 426, not a fall-through", async () => {
		const res = await fetch(`http://localhost:${server.port}${SIGNAL_PATH}`);
		expect(res.status).toBe(426);
	});

	it("refuses an upgrade from a disallowed origin", async () => {
		const res = await fetch(`http://localhost:${server.port}${SIGNAL_PATH}`, {
			headers: {
				Origin: "https://evil.example",
				Upgrade: "websocket",
				Connection: "Upgrade",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": btoa("0123456789abcdef"),
			},
		});
		expect(res.status).toBe(403);
	});

	// ── Auth rides in the first frame ────────────────────────────────────────────────

	it("drops a socket that never authenticates", async () => {
		const peer = await connect();
		const frame = await peer.next("the auth_timeout error");
		expect(frame.t).toBe("error");
		expect(frame.code).toBe("auth_timeout");
		expect((await peer.closed()).code).toBe(4001);
		expect(peerRegistry().size()).toBe(0);
	});

	it("refuses any frame before the auth frame", async () => {
		const peer = await connect();
		peer.send({ t: "peers" });
		const frame = await peer.next("the auth_required error");
		expect(frame.code).toBe("auth_required");
		expect((await peer.closed()).code).toBe(4001);
	});

	it("rejects an invalid token", async () => {
		const peer = await connect();
		peer.send({ t: "auth", token: "not.a.token" });
		expect((await peer.next()).code).toBe("auth_failed");
		expect((await peer.closed()).code).toBe(4001);
		expect(peerRegistry().size()).toBe(0);
	});

	it("rejects a token whose signature has been tampered with", async () => {
		const real = await mintP2pToken({ workId: WORK, assetId: ASSET_A, userId: USER });
		const [payload, sig] = real.split(".");
		const peer = await connect();
		peer.send({ t: "auth", token: `${payload}.${sig.slice(0, -4)}AAAA` });
		expect((await peer.next()).code).toBe("auth_failed");
		expect((await peer.closed()).code).toBe(4001);
	});

	it("rejects an already-expired token", async () => {
		const stale = await mintP2pToken({
			workId: WORK,
			assetId: ASSET_A,
			userId: USER,
			ttlSeconds: -60,
		});
		const peer = await connect();
		peer.send({ t: "auth", token: stale });
		expect((await peer.next()).code).toBe("auth_failed");
		expect((await peer.closed()).code).toBe(4001);
	});

	it("admits a valid token and reports the token's own scope back", async () => {
		const peer = await connect();
		const token = await mintP2pToken({ workId: WORK, assetId: ASSET_A, userId: USER });
		peer.send({ t: "auth", token });
		const ready = await peer.next("ready");
		expect(ready.t).toBe("ready");
		expect(ready.workId).toBe(WORK);
		expect(ready.assetId).toBe(ASSET_A);
		expect(typeof ready.expiresAt).toBe("number");
		expect(peerRegistry().size()).toBe(1);
	});

	it("assigns the peer id itself and ignores one the client supplies", async () => {
		// The spike took the peer id from the query string, which let any peer claim
		// another's id and receive its signaling. The id must be the hub's.
		const peer = await connect();
		const token = await mintP2pToken({ workId: WORK, assetId: ASSET_A, userId: USER });
		peer.send({ t: "auth", token, peerId: "i-am-somebody-else" });
		const ready = await peer.next("ready");
		expect(ready.peerId).not.toBe("i-am-somebody-else");
		expect(ready.peerId).toMatch(/^[0-9a-f-]{36}$/);
	});

	// ── Discovery ────────────────────────────────────────────────────────────────────

	it("introduces two peers that announce for the same asset", async () => {
		const host = await join();
		host.send({ t: "announce" });
		await host.next("the announce reply");

		const downloader = await join();
		downloader.send({ t: "peers" });
		const list = await downloader.next("the peer list");
		expect(list.t).toBe("peers");
		expect(list.peers).toEqual([{ peerId: host.peerId }]);
	});

	it("does not offer a peer that has only connected, without announcing", async () => {
		// Being in the swarm and being willing to serve are different things — a downloader
		// that has nothing yet must not be handed out as a source.
		await join();
		const downloader = await join();
		downloader.send({ t: "peers" });
		expect((await downloader.next()).peers).toEqual([]);
	});

	it("pushes a joined notice to peers already on the asset", async () => {
		const waiting = await join();
		const host = await join();
		host.send({ t: "announce" });
		const notice = await waiting.next("the joined notice");
		expect(notice.t).toBe("joined");
		expect(notice.peerId).toBe(host.peerId);
	});

	it("never puts an account identity in a peer list", async () => {
		// A peer learns the other side's IP from ICE no matter what; there is no reason for
		// the relay to add a name to it.
		const host = await join();
		host.send({ t: "announce" });
		await host.next();
		const downloader = await join();
		downloader.send({ t: "peers" });
		const list = await downloader.next();
		expect(Object.keys((list.peers as object[])[0])).toEqual(["peerId"]);
	});

	it("withdraws a peer that says it is no longer serving", async () => {
		const host = await join();
		host.send({ t: "announce" });
		await host.next();
		const downloader = await join();

		host.send({ t: "withdraw" });
		expect((await host.next()).t).toBe("withdrawn");
		const left = await downloader.next("the left notice");
		expect(left.t).toBe("left");
		expect(left.peerId).toBe(host.peerId);

		downloader.send({ t: "peers" });
		expect((await downloader.next()).peers).toEqual([]);
	});

	// ── The asset is the swarm boundary ──────────────────────────────────────────────

	it("keeps peers on different assets from seeing each other", async () => {
		const onB = await join({ assetId: ASSET_B });
		onB.send({ t: "announce" });
		await onB.next();

		const onA = await join({ assetId: ASSET_A });
		onA.send({ t: "peers" });
		expect((await onA.next()).peers).toEqual([]);
	});

	it("refuses to relay across assets, and says nothing about whether the peer exists", async () => {
		// Same answer for "no such peer" and "that peer is on another asset" — telling them
		// apart would let a peer probe which ids are live elsewhere on the hub.
		const onB = await join({ assetId: ASSET_B });
		const onA = await join({ assetId: ASSET_A });

		onA.send({ t: "signal", to: onB.peerId, data: { sdp: "nope" } });
		const crossAsset = await onA.next();

		onA.send({ t: "signal", to: crypto.randomUUID(), data: { sdp: "nope" } });
		const nonexistent = await onA.next();

		expect(crossAsset.code).toBe("unknown_peer");
		expect(nonexistent.code).toBe("unknown_peer");
		expect(crossAsset.t).toBe(nonexistent.t);
	});

	// ── Relaying ─────────────────────────────────────────────────────────────────────

	it("relays a blob between two peers on the same asset, untouched", async () => {
		const host = await join();
		host.send({ t: "announce" });
		await host.next();
		const downloader = await join();

		// Deliberately not SDP-shaped. The relay has no business understanding the payload,
		// so the test asserts it survives rather than that it parses.
		const blob = { type: "offer", sdp: "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n", nested: [1, { a: 2 }] };
		downloader.send({ t: "signal", to: host.peerId, data: blob });

		const relayed = await host.next("the relayed signal");
		expect(relayed.t).toBe("signal");
		expect(relayed.from).toBe(downloader.peerId);
		expect(relayed.data).toEqual(blob);
	});

	it("relays in both directions", async () => {
		const host = await join();
		host.send({ t: "announce" });
		await host.next();
		const downloader = await join();

		downloader.send({ t: "signal", to: host.peerId, data: "offer" });
		expect((await host.next()).data).toBe("offer");
		host.send({ t: "signal", to: downloader.peerId, data: "answer" });
		expect((await downloader.next()).data).toBe("answer");
	});

	it("rejects a signal frame missing `to` or `data`", async () => {
		const peer = await join();
		peer.send({ t: "signal", data: "orphan" });
		expect((await peer.next()).code).toBe("bad_message");
		peer.send({ t: "signal", to: peer.peerId });
		expect((await peer.next()).code).toBe("bad_message");
	});

	// ── Disconnection releases presence ──────────────────────────────────────────────

	it("removes a peer that disconnects, and tells the peers that knew it", async () => {
		const host = await join();
		host.send({ t: "announce" });
		await host.next();
		const downloader = await join();
		expect(peerRegistry().size()).toBe(2);

		host.disconnect();
		const left = await downloader.next("the left notice");
		expect(left.t).toBe("left");
		expect(left.peerId).toBe(host.peerId);

		downloader.send({ t: "peers" });
		expect((await downloader.next()).peers).toEqual([]);
		expect(peerRegistry().size()).toBe(1);
	});

	it("holds nothing once every peer has gone", async () => {
		// "Bounded in memory" as an assertion rather than an intention.
		const a = await join();
		const b = await join({ assetId: ASSET_B });
		expect(peerRegistry().size()).toBe(2);
		a.disconnect();
		b.disconnect();
		await sleep(50);
		expect(peerRegistry().size()).toBe(0);
	});

	// ── Token lifetime ───────────────────────────────────────────────────────────────

	it("takes a peer back out of the swarm when its vouch lapses", async () => {
		const peer = await join({ ttlSeconds: 1 });
		await sleep(2100);
		peer.send({ t: "peers" });
		expect((await peer.next()).code).toBe("token_expired");
		expect((await peer.closed()).code).toBe(4003);
	});

	it("extends a peer's vouch when it presents a fresh token", async () => {
		const peer = await join({ ttlSeconds: 2 });
		const fresh = await mintP2pToken({ workId: WORK, assetId: ASSET_A, userId: USER });
		peer.send({ t: "auth", token: fresh });
		const ready = await peer.next("the re-ready");
		expect(ready.t).toBe("ready");
		expect(ready.peerId).toBe(peer.peerId); // the same peer, still reachable by the same id

		await sleep(2100);
		peer.send({ t: "peers" });
		expect((await peer.next()).t).toBe("peers");
	});

	it("refuses a refreshed token for a different asset", async () => {
		const peer = await join({ assetId: ASSET_A });
		const elsewhere = await mintP2pToken({ workId: WORK, assetId: ASSET_B, userId: USER });
		peer.send({ t: "auth", token: elsewhere });
		expect((await peer.next()).code).toBe("auth_scope");
		expect((await peer.closed()).code).toBe(4001);
	});

	// ── Bounds ───────────────────────────────────────────────────────────────────────

	it("caps the sockets one account may hold", async () => {
		for (let i = 0; i < _limits.MAX_SOCKETS_PER_USER; i++) await join({ userId: 999 });
		const extra = await connect();
		const token = await mintP2pToken({ workId: WORK, assetId: ASSET_A, userId: 999 });
		extra.send({ t: "auth", token });
		expect((await extra.next()).code).toBe("too_many_sockets");
		expect((await extra.closed()).code).toBe(4004);

		// A different account is unaffected — the cap is per user, not a global brownout.
		const other = await join({ userId: 1000 });
		expect(other.peerId).toBeTruthy();
	});

	it("caps the peer list rather than returning the whole swarm", async () => {
		for (let i = 0; i < _limits.PEER_LIST_LIMIT + 3; i++) {
			const host = await join({ userId: 2000 + i });
			host.send({ t: "announce" });
			await host.next();
		}
		const downloader = await join({ userId: 9999 });
		downloader.send({ t: "peers" });
		const list = await downloader.next();
		expect((list.peers as unknown[]).length).toBe(_limits.PEER_LIST_LIMIT);
	});

	it("refuses the upgrade at capacity instead of accepting a socket it cannot hold", async () => {
		// The graceful failure: a client with no socket falls back to pulling every chunk
		// from the hub — slower, and it works. Accepting past the ceiling takes the API
		// down with it, and the download fails outright.
		_setMaxSocketsForTest(2);
		try {
			await connect();
			await connect();
			const res = await fetch(`http://localhost:${server.port}${SIGNAL_PATH}`, {
				headers: {
					Upgrade: "websocket",
					Connection: "Upgrade",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": btoa("0123456789abcdef"),
				},
			});
			expect(res.status).toBe(503);
		} finally {
			_setMaxSocketsForTest(500);
		}
	});

	it("closes a socket that floods the relay", async () => {
		const peer = await join();
		for (let i = 0; i <= _limits.RATE_LIMIT_FRAMES; i++) peer.send({ t: "ping" });
		expect((await peer.closed()).code).toBe(4002);
		await sleep(20);
		expect(peerRegistry().size()).toBe(0);
	});

	it("closes a socket that sends an oversized frame", async () => {
		const peer = await join();
		peer.send({ t: "signal", to: peer.peerId, data: "x".repeat(_limits.MAX_MESSAGE_BYTES + 1) });
		await peer.closed();
		await sleep(20);
		expect(peerRegistry().size()).toBe(0);
	});

	it("answers an unparseable frame without closing the socket", async () => {
		const peer = await join();
		peer.send("this is not json");
		expect((await peer.next()).code).toBe("bad_message");
		// Still usable — a malformed frame is a client bug, not an attack.
		peer.send({ t: "ping" });
		expect((await peer.next()).t).toBe("pong");
	});

	it("answers an unknown frame type without closing the socket", async () => {
		const peer = await join();
		peer.send({ t: "seed-please" });
		expect((await peer.next()).code).toBe("bad_message");
		peer.send({ t: "ping" });
		expect((await peer.next()).t).toBe("pong");
	});
});

// ── The registry, directly ───────────────────────────────────────────────────────────
//
// The relay's expiry sweep is the one behaviour that is far cheaper to prove here than
// through a socket, because it turns on wall-clock time.

describe("InMemoryPeerRegistry", () => {
	const record = (over: Partial<PeerRecord> = {}): PeerRecord => ({
		peerId: crypto.randomUUID(),
		assetId: ASSET_A,
		workId: WORK,
		userId: USER,
		expiresAt: Math.floor(Date.now() / 1000) + 900,
		serving: true,
		...over,
	});
	const sink = () => {
		const sent: string[] = [];
		let closedWith: number | null = null;
		return {
			sent,
			get closedWith() {
				return closedWith;
			},
			send: (d: string) => void sent.push(d),
			close: (code: number) => {
				closedWith = code;
			},
		};
	};

	it("sweeps a peer whose vouch has lapsed, and closes its socket", async () => {
		const registry = new InMemoryPeerRegistry();
		const expired = record({ expiresAt: Math.floor(Date.now() / 1000) - 1 });
		const live = record();
		const expiredSink = sink();
		registry.register(expired, expiredSink);
		registry.register(live, sink());

		const found = registry.peersFor(ASSET_A, { excludePeerId: "nobody", limit: 8 });
		expect(found.map((p) => p.peerId)).toEqual([live.peerId]);
		expect(registry.get(expired.peerId)).toBeNull();
		expect(expiredSink.closedWith).toBe(4003);
		expect(registry.size()).toBe(1);
	});

	it("reports a failed delivery rather than throwing, and drops the dead peer", async () => {
		// The day this is a Postgres-backed registry, `false` means "not on this instance".
		// Today it means "gone", and either way the caller has to be able to act on it.
		const registry = new InMemoryPeerRegistry();
		const peer = record();
		registry.register(peer, {
			send() {
				throw new Error("socket is gone");
			},
			close() {},
		});
		expect(registry.send(peer.peerId, { t: "ping" })).toBe(false);
		expect(registry.size()).toBe(0);
		expect(registry.send(crypto.randomUUID(), { t: "ping" })).toBe(false);
	});

	it("forgets an asset entirely once its last peer leaves", async () => {
		// Bounded by peers ONLINE, not by assets ever requested — otherwise a one-off
		// download leaves a permanent entry behind.
		//
		// Asserted through `indexSizes()` on purpose. The obvious version of this test —
		// `size()` is 0, `peersFor` is empty, `countForUser` is 0 — passes just as happily
		// against a registry that never deletes an empty Set, which is precisely the leak
		// it is supposed to catch. Verified by sabotage: with the cleanup removed, the
		// obvious version stayed green and this one goes red.
		const registry = new InMemoryPeerRegistry();
		const peer = record();
		registry.register(peer, sink());
		expect(registry.indexSizes()).toEqual({ peers: 1, assets: 1, users: 1 });

		registry.unregister(peer.peerId);
		expect(registry.indexSizes()).toEqual({ peers: 0, assets: 0, users: 0 });
		expect(registry.peersFor(ASSET_A, { excludePeerId: "nobody", limit: 8 })).toEqual([]);
		expect(registry.countForUser(USER)).toBe(0);
	});

	it("keeps one asset's entry while another asset still has peers", async () => {
		// The other half of the same bound: cleanup must be per key, not "delete when the
		// registry happens to be empty".
		const registry = new InMemoryPeerRegistry();
		const onA = record({ assetId: ASSET_A });
		const onB = record({ assetId: ASSET_B, userId: USER + 1 });
		registry.register(onA, sink());
		registry.register(onB, sink());
		registry.unregister(onA.peerId);
		expect(registry.indexSizes()).toEqual({ peers: 1, assets: 1, users: 1 });
	});
});
