// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The P2P signaling relay — milestone 9's swarm half (45.01 § 3).
 *
 * Two peers cannot open a WebRTC connection without first exchanging an SDP offer, an SDP
 * answer, and a handful of ICE candidates. Something has to carry those first bytes, and
 * here it is the hub: peers hold a WebSocket to `/api/p2p/signal`, ask who else has the
 * asset they are pulling, and relay opaque blobs to each other by peer id until the direct
 * connection is up. After that the hub is out of the path entirely and the bytes never
 * touch it.
 *
 * The relay does not read the blobs it relays. It has no idea what SDP is, which is
 * deliberate: parsing them would put the hub in the business of understanding WebRTC
 * versions, and every field it learned to read would be a field it could get wrong.
 *
 * ── Why the hub brokers introductions at all ────────────────────────────────────────
 *
 * A public DHT is disqualified on principle rather than on performance. 45.03's legal
 * argument is that the Anthers swarm is *defined* by token verification — a peer that
 * doesn't verify isn't in it — and that only holds while discovery runs through a point
 * that checks. So: no DHT, no tracker semantics, no BitTorrent wire compatibility (settled
 * 2026-08-10; `anthersp2p` is open-source and conformant to 45.04, which is what makes it
 * forkable, not interoperability with existing tooling).
 *
 * ── Both sides check ────────────────────────────────────────────────────────────────
 *
 * The hub gates introduction here, AND the serving peer verifies the presented token
 * against the hub's public key before it hands over a chunk. Defence in depth, and it puts
 * swarm membership behind two independent checks, which is what makes 45.03's boundary
 * argument sturdier than a single gate would.
 *
 * Note plainly what the token is: a **bearer** credential for its 15-minute life. Anyone
 * holding it can pull. That is the same property a signed URL has, it is coherent with the
 * DRM-free line, and it is a documented property rather than an oversight (45.05).
 *
 * ── Auth rides in the first message, not the query string ───────────────────────────
 *
 * Browsers cannot set headers on a WebSocket handshake — there is no way to send
 * `Authorization` with `new WebSocket(url)`. The obvious workaround is `?token=…`, and it
 * is the wrong one: query strings land in access logs, in proxy logs, and in `Referer`
 * headers. So the socket opens unauthenticated and the client's FIRST frame must be
 * `{t:"auth", token}`. The cost is a briefly unauthenticated socket, which is why
 * `AUTH_TIMEOUT_MS` exists and why the pre-auth socket is in no index and can do nothing.
 *
 * ── The peer id is assigned by the hub ──────────────────────────────────────────────
 *
 * The spike let the client pick its own peer id in the query string. That lets any peer
 * claim another peer's id and intercept its signaling. Ids are `crypto.randomUUID()` here,
 * assigned at auth, and a client-supplied one is ignored rather than rejected — there is
 * nothing to negotiate.
 *
 * ── What peers learn about each other ───────────────────────────────────────────────
 *
 * A WebRTC connection discloses each side's IP address to the other; that is how ICE
 * works, and no signaling design avoids it. The relay does not make it worse: a peer list
 * carries peer ids and nothing else — no username, no user id, no account identity. Two
 * peers swapping chunks know each other's address and not each other's name.
 *
 * ── No database ─────────────────────────────────────────────────────────────────────
 *
 * Nothing in this file touches Postgres. A token is verified with the hub's own key, and
 * presence lives in memory. That is what makes signaling ~100× cheaper than chunk serving
 * (which saturates around 10–20 concurrent downloaders on a 512 MB / 1 shared vCPU box),
 * so the relay will never be the binding constraint — and the event that eventually forces
 * horizontal scaling will be something else entirely, which is exactly the danger
 * documented at the top of `registry.ts`.
 */

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { allowedOrigins } from "../origins.js";
import { InMemoryPeerRegistry, type PeerRegistry } from "./registry.js";
import { verifyP2pToken } from "./token.js";

/** Where peers connect. Under `/api/p2p` for grep-ability, intercepted before Hono. */
export const SIGNAL_PATH = "/api/p2p/signal";

/**
 * Bounds. Every one of these exists because the spike relay had none of them — it kept
 * unbounded state keyed by whatever the client sent.
 */
/** How long a socket may stay unauthenticated before it is dropped. */
let authTimeoutMs = 10_000;
/** Sockets open at once, authenticated or not. A 512 MB box, at a few KB of state each. */
let maxSockets = 500;
/** Sockets one account may hold. Several concurrent downloads are normal; hundreds are not. */
const MAX_SOCKETS_PER_USER = 8;
/** Peers returned in one `peers` reply. A swarm needs a handful of introductions, not all of them. */
const PEER_LIST_LIMIT = 8;
/** Recipients of one join/leave notification. Bounds the fan-out on a popular asset. */
const NOTIFY_FANOUT = 32;
/** Largest frame accepted. An SDP offer with candidates runs a few KB; this is generous. */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Frames per window before the socket is closed. Signaling a download costs ~50–100 total. */
const RATE_LIMIT_FRAMES = 240;
const RATE_LIMIT_WINDOW_MS = 10_000;

/** Application close codes (the 4000–4999 range is reserved for exactly this). */
const CLOSE_AUTH = 4001;
const CLOSE_RATE_LIMITED = 4002;
const CLOSE_TOKEN_EXPIRED = 4003;
const CLOSE_CAPACITY = 4004;

export interface SignalSocketData {
	peerId: string | null;
	assetId: number | null;
	workId: number | null;
	userId: number | null;
	expiresAt: number;
	authTimer: ReturnType<typeof setTimeout> | null;
	authenticating: boolean;
	windowStart: number;
	windowFrames: number;
}

type SignalSocket = ServerWebSocket<SignalSocketData>;

let registry: PeerRegistry = new InMemoryPeerRegistry();
let openSockets = 0;

/** Swap the presence implementation — the seam described at the top of `registry.ts`. */
export function setPeerRegistry(next: PeerRegistry): void {
	registry = next;
}

export function peerRegistry(): PeerRegistry {
	return registry;
}

// ── Upgrade ──────────────────────────────────────────────────────────────────────────

export type SignalUpgrade = { upgraded: true } | { upgraded: false; response: Response };

/**
 * Intercept a WebSocket upgrade for the signaling path, ahead of Hono.
 *
 * Returns `null` for every other request, which is the caller's signal to hand it to the
 * Hono app untouched. Keeping that distinction explicit rather than returning `undefined`
 * is what stops a successful upgrade from also being routed — see the header of
 * `server.ts` for what merging those two roles cost.
 */
export function tryUpgradeSignaling(
	req: Request,
	server: Server<SignalSocketData>,
): SignalUpgrade | null {
	if (new URL(req.url).pathname !== SIGNAL_PATH) return null;

	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return refuse(426, "This endpoint speaks WebSocket. Send an Upgrade request.");
	}

	// A WebSocket handshake is exempt from CORS, so the browser will not stop a hostile
	// page from opening one. It does send `Origin`, though, so we can. A client that sends
	// no Origin at all is not a browser (the CLI, the desktop app), and it cannot be
	// riding someone's ambient credentials, because this socket has none to ride: the
	// credential is a token in the first frame, which a cross-origin page cannot obtain.
	const origin = req.headers.get("Origin");
	if (origin && !allowedOrigins().includes(origin)) {
		return refuse(403, "Origin not allowed.");
	}

	// Refusing the upgrade is the graceful failure: a client that cannot get a socket falls
	// back to pulling every chunk from the hub, which is slower and works. Accepting more
	// sockets than the box can hold would take the API down with them.
	if (openSockets >= maxSockets) {
		return refuse(503, "The signaling relay is at capacity. Downloads continue from the hub.");
	}

	const data: SignalSocketData = {
		peerId: null,
		assetId: null,
		workId: null,
		userId: null,
		expiresAt: 0,
		authTimer: null,
		authenticating: false,
		windowStart: Date.now(),
		windowFrames: 0,
	};
	return server.upgrade(req, { data })
		? { upgraded: true }
		: { upgraded: false, response: new Response("Upgrade failed", { status: 400 }) };
}

function refuse(status: number, message: string): SignalUpgrade {
	return { upgraded: false, response: new Response(message, { status }) };
}

// ── Socket lifecycle ─────────────────────────────────────────────────────────────────

export const signalingWebSocket: WebSocketHandler<SignalSocketData> = {
	maxPayloadLength: MAX_MESSAGE_BYTES,
	// Bun drops a socket that has been silent this long. A peer that intends to keep
	// hosting sends `{t:"ping"}`; one that has finished its download and wandered off
	// should be reaped rather than held.
	idleTimeout: 300,

	open(ws) {
		openSockets++;
		ws.data.authTimer = setTimeout(() => {
			send(ws, { t: "error", code: "auth_timeout", message: "No auth frame." });
			ws.close(CLOSE_AUTH, "auth_timeout");
		}, authTimeoutMs);
	},

	async message(ws, raw) {
		if (!withinRateLimit(ws)) {
			send(ws, { t: "error", code: "rate_limited", message: "Too many frames." });
			ws.close(CLOSE_RATE_LIMITED, "rate_limited");
			return;
		}

		const text = typeof raw === "string" ? raw : raw.toString();
		let msg: Record<string, unknown>;
		try {
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
			msg = parsed as Record<string, unknown>;
		} catch {
			send(ws, { t: "error", code: "bad_message", message: "Expected a JSON object." });
			return;
		}

		if (msg.t === "auth") {
			await handleAuth(ws, msg);
			return;
		}

		if (!ws.data.peerId) {
			send(ws, { t: "error", code: "auth_required", message: "Authenticate first." });
			ws.close(CLOSE_AUTH, "auth_required");
			return;
		}

		// The vouch is what puts this peer in the swarm, so its lapse takes it back out —
		// mid-session, not only at connect. The client re-mints from the manifest endpoint
		// (which re-resolves access) and sends another auth frame.
		if (ws.data.expiresAt <= nowSeconds()) {
			send(ws, { t: "error", code: "token_expired", message: "Present a fresh token." });
			ws.close(CLOSE_TOKEN_EXPIRED, "token_expired");
			return;
		}

		switch (msg.t) {
			case "announce":
				return handleAnnounce(ws);
			case "withdraw":
				return handleWithdraw(ws);
			case "peers":
				return sendPeerList(ws);
			case "signal":
				return handleSignal(ws, msg);
			case "ping":
				return send(ws, { t: "pong" });
			default:
				return send(ws, { t: "error", code: "bad_message", message: "Unknown frame type." });
		}
	},

	close(ws) {
		openSockets = Math.max(0, openSockets - 1);
		if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
		const { peerId } = ws.data;
		if (!peerId) return;
		const record = registry.unregister(peerId);
		if (record?.serving) notifyAsset(record.assetId, peerId, { t: "left", peerId });
	},
};

// ── Frames ───────────────────────────────────────────────────────────────────────────

async function handleAuth(ws: SignalSocket, msg: Record<string, unknown>): Promise<void> {
	if (ws.data.authenticating) {
		send(ws, { t: "error", code: "auth_failed", message: "An auth frame is already in flight." });
		return;
	}
	ws.data.authenticating = true;
	try {
		const token = typeof msg.token === "string" ? msg.token : null;
		const payload = token ? await verifyP2pToken(token) : null;
		if (!payload) {
			send(ws, { t: "error", code: "auth_failed", message: "Invalid or expired token." });
			ws.close(CLOSE_AUTH, "auth_failed");
			return;
		}

		// Re-auth on a live socket: a refreshed token, extending the same peer's vouch. It
		// must cover the same asset and the same user, because anything else is a different
		// peer wearing this socket — and the peer id has already been handed to others.
		if (ws.data.peerId) {
			if (payload.a !== ws.data.assetId || payload.u !== ws.data.userId) {
				send(ws, {
					t: "error",
					code: "auth_scope",
					message: "A refreshed token must cover the same asset and user.",
				});
				ws.close(CLOSE_AUTH, "auth_scope");
				return;
			}
			ws.data.expiresAt = payload.e;
			registry.refresh(ws.data.peerId, payload.e);
			sendReady(ws);
			return;
		}

		if (registry.countForUser(payload.u) >= MAX_SOCKETS_PER_USER) {
			send(ws, { t: "error", code: "too_many_sockets", message: "Too many open sockets." });
			ws.close(CLOSE_CAPACITY, "too_many_sockets");
			return;
		}

		// Hub-assigned, never client-supplied. A `peerId` in the auth frame is ignored.
		const peerId = crypto.randomUUID();
		ws.data.peerId = peerId;
		ws.data.assetId = payload.a;
		ws.data.workId = payload.w;
		ws.data.userId = payload.u;
		ws.data.expiresAt = payload.e;
		if (ws.data.authTimer) {
			clearTimeout(ws.data.authTimer);
			ws.data.authTimer = null;
		}

		registry.register(
			{
				peerId,
				assetId: payload.a,
				workId: payload.w,
				userId: payload.u,
				expiresAt: payload.e,
				serving: false,
			},
			{ send: (data) => ws.send(data), close: (code, reason) => ws.close(code, reason) },
		);
		sendReady(ws);
	} finally {
		ws.data.authenticating = false;
	}
}

/** A peer announcing it can serve. The reply carries the peer list, saving a round trip. */
function handleAnnounce(ws: SignalSocket): void {
	const peerId = ws.data.peerId as string;
	const assetId = ws.data.assetId as number;
	registry.setServing(peerId, true);
	notifyAsset(assetId, peerId, { t: "joined", peerId });
	sendPeerList(ws);
}

function handleWithdraw(ws: SignalSocket): void {
	const peerId = ws.data.peerId as string;
	const assetId = ws.data.assetId as number;
	registry.setServing(peerId, false);
	notifyAsset(assetId, peerId, { t: "left", peerId });
	send(ws, { t: "withdrawn" });
}

function sendPeerList(ws: SignalSocket): void {
	const peers = registry.peersFor(ws.data.assetId as number, {
		excludePeerId: ws.data.peerId as string,
		limit: PEER_LIST_LIMIT,
	});
	// Peer ids only — see § What peers learn about each other.
	send(ws, { t: "peers", peers: peers.map((p) => ({ peerId: p.peerId })) });
}

/**
 * Relay one opaque blob to one peer on the same asset.
 *
 * The asset check is the swarm boundary applied to signaling: a peer vouched for asset X
 * can introduce itself to peers of asset X and to nobody else. Without it the relay would
 * be a general-purpose message bus between any two authenticated accounts, which is a
 * larger thing than a signaling relay and a much larger thing to secure.
 *
 * A missing peer and a peer on another asset get the SAME answer, deliberately: telling
 * them apart would let a peer probe which ids exist elsewhere on the hub.
 */
function handleSignal(ws: SignalSocket, msg: Record<string, unknown>): void {
	const to = typeof msg.to === "string" ? msg.to : null;
	if (!to || msg.data === undefined) {
		send(ws, { t: "error", code: "bad_message", message: "signal needs `to` and `data`." });
		return;
	}
	const target = registry.get(to);
	if (!target || target.assetId !== ws.data.assetId) {
		send(ws, { t: "error", code: "unknown_peer", peerId: to });
		return;
	}
	if (!registry.send(to, { t: "signal", from: ws.data.peerId, data: msg.data })) {
		send(ws, { t: "error", code: "unknown_peer", peerId: to });
	}
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────

function sendReady(ws: SignalSocket): void {
	send(ws, {
		t: "ready",
		peerId: ws.data.peerId,
		workId: ws.data.workId,
		assetId: ws.data.assetId,
		expiresAt: ws.data.expiresAt,
	});
}

function send(ws: SignalSocket, message: unknown): void {
	try {
		ws.send(JSON.stringify(message));
	} catch {
		// The socket closed between the decision to reply and the reply. Nothing to do.
	}
}

function notifyAsset(assetId: number, exceptPeerId: string, message: unknown): void {
	for (const peer of registry.membersOf(assetId, {
		excludePeerId: exceptPeerId,
		limit: NOTIFY_FANOUT,
	})) {
		registry.send(peer.peerId, message);
	}
}

function withinRateLimit(ws: SignalSocket): boolean {
	const now = Date.now();
	if (now - ws.data.windowStart >= RATE_LIMIT_WINDOW_MS) {
		ws.data.windowStart = now;
		ws.data.windowFrames = 0;
	}
	ws.data.windowFrames++;
	return ws.data.windowFrames <= RATE_LIMIT_FRAMES;
}

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

// ── Test helpers ─────────────────────────────────────────────────────────────────────

/** Shorten the unauthenticated-socket deadline so the timeout is testable in milliseconds. */
export function _setAuthTimeoutForTest(ms: number): void {
	authTimeoutMs = ms;
}

/** Lower the global ceiling, so the capacity refusal is testable without 500 sockets. */
export function _setMaxSocketsForTest(n: number): void {
	maxSockets = n;
}

/** Drop all presence and reset the socket counter, so one suite cannot leak into the next. */
export function _resetSignalingForTest(): void {
	registry = new InMemoryPeerRegistry();
	openSockets = 0;
}

/** The bounds, exposed so tests assert against the real numbers rather than copies of them. */
export const _limits = {
	MAX_SOCKETS_PER_USER,
	PEER_LIST_LIMIT,
	MAX_MESSAGE_BYTES,
	RATE_LIMIT_FRAMES,
} as const;
