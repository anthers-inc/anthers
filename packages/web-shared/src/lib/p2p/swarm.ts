// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The swarm half of the browser client — the relay connection and the peers it finds.
 *
 * The hub-only path in `download.ts` is complete without any of this: with no peers, every
 * chunk comes from the hub and the download works. This layer adds `ChunkSource`s that
 * happen to be other browsers, and the engine cannot tell the difference — which is the
 * point of it being an interface.
 *
 * ── The protocol, client side ───────────────────────────────────────────────────────
 *
 * Matches `apps/api/src/p2p/signaling.ts`. Connect to `/api/p2p/signal`, send
 * `{t:"auth", token}` as the FIRST frame (browsers cannot set headers on a WebSocket
 * handshake, and a query-string token lands in access logs), receive `{t:"ready", peerId}`
 * with a peer id the HUB assigned, then `{t:"peers"}` to find sources and `{t:"signal"}` to
 * relay SDP and ICE to one of them. The relay never sees the bytes.
 *
 * ── The load-bearing WebRTC detail ──────────────────────────────────────────────────
 *
 * 🚨 **Create the data channel BEFORE `createOffer()`.** Chrome gathers no ICE candidates
 * for a peer connection with no media and no data channel, so the offer is generated, the
 * answer arrives, the remote description is set — and then nothing happens, forever, with
 * no error. This was the one finding worth keeping from the WebRTC spike, and it costs a
 * session to rediscover.
 *
 * ── What a peer is trusted with, which is nothing ───────────────────────────────────
 *
 * A peer supplies bytes and the engine hashes them against the manifest before they are
 * written. That is the whole trust model: a peer that returns anything else is dropped by
 * `markPoisoned`. Nothing here needs to establish that a peer is honest, because nothing
 * downstream believes it.
 */

import { apiBaseUrl } from "../rpc.js";
import type { ChunkSource } from "./download.js";

/** How long to wait for a peer to answer a chunk request before giving up on it. */
const PEER_CHUNK_TIMEOUT_MS = 15_000;
/** How long to wait for a WebRTC data channel to open before abandoning the peer. */
const PEER_CONNECT_TIMEOUT_MS = 20_000;

/** The relay's URL, derived from the API origin — never hand-rolled. */
export function signalUrl(): string {
	const base = apiBaseUrl() || (typeof location !== "undefined" ? location.origin : "");
	return `${base.replace(/^http/, "ws")}/api/p2p/signal`;
}

interface RelayMessage {
	t: string;
	peerId?: string;
	peers?: { peerId: string }[];
	from?: string;
	data?: unknown;
	code?: string;
}

/**
 * A connection to the signaling relay.
 *
 * Deliberately does nothing on its own — it authenticates, reports peers, and relays
 * blobs. Deciding what to do with a peer is `SwarmClient`'s job, and pulling bytes is
 * `PeerChunkSource`'s.
 */
export class SignalingConnection {
	private socket: WebSocket | null = null;
	private ready = false;
	private selfPeerId: string | null = null;
	private readonly listeners = new Set<(msg: RelayMessage) => void>();

	async connect(token: string): Promise<string> {
		const socket = new WebSocket(signalUrl());
		this.socket = socket;

		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("signaling connect failed")), {
				once: true,
			});
		});

		socket.addEventListener("message", (event) => {
			let msg: RelayMessage;
			try {
				msg = JSON.parse(String(event.data)) as RelayMessage;
			} catch {
				return;
			}
			if (msg.t === "ready") {
				this.ready = true;
				this.selfPeerId = msg.peerId ?? null;
			}
			for (const listener of this.listeners) listener(msg);
		});

		// Auth is the first frame. Nothing else may be sent before `ready` comes back.
		socket.send(JSON.stringify({ t: "auth", token }));
		const readyMsg = await this.next((m) => m.t === "ready" || m.t === "error", 10_000);
		if (readyMsg.t !== "ready" || !readyMsg.peerId) {
			throw new Error(`signaling auth failed: ${readyMsg.code ?? "unknown"}`);
		}
		return readyMsg.peerId;
	}

	get peerId(): string | null {
		return this.selfPeerId;
	}

	get open(): boolean {
		return this.ready && this.socket?.readyState === WebSocket.OPEN;
	}

	send(message: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	on(listener: (msg: RelayMessage) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	next(predicate: (msg: RelayMessage) => boolean, timeoutMs: number): Promise<RelayMessage> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				off();
				reject(new Error("signaling timeout"));
			}, timeoutMs);
			const off = this.on((msg) => {
				if (!predicate(msg)) return;
				clearTimeout(timer);
				off();
				resolve(msg);
			});
		});
	}

	/** Ask who else holds this asset. The relay answers with peer ids and nothing else. */
	async requestPeers(timeoutMs = 5_000): Promise<string[]> {
		this.send({ t: "peers" });
		const msg = await this.next((m) => m.t === "peers", timeoutMs).catch(() => null);
		return msg?.peers?.map((p) => p.peerId) ?? [];
	}

	close(): void {
		this.listeners.clear();
		this.socket?.close();
		this.socket = null;
		this.ready = false;
	}
}

/**
 * One WebRTC connection to one peer, presented to the engine as a `ChunkSource`.
 *
 * The wire protocol over the data channel is deliberately minimal: a JSON request naming a
 * chunk index, then either the raw bytes as a binary message or a JSON `miss`. The manifest
 * already says how long every chunk should be and what it should hash to, so the transfer
 * needs no framing metadata of its own.
 */
export class PeerChunkSource implements ChunkSource {
	healthy = true;
	private channel: RTCDataChannel | null = null;
	private connection: RTCPeerConnection | null = null;
	private pending: { index: number; resolve: (b: Uint8Array | null) => void } | null = null;

	constructor(
		readonly id: string,
		private readonly signaling: SignalingConnection,
	) {}

	/** Open the connection. Resolves when the data channel is usable. */
	async connect(iceServers: RTCIceServer[] = []): Promise<void> {
		const connection = new RTCPeerConnection({ iceServers });
		this.connection = connection;

		// 🚨 BEFORE createOffer(). See the header — Chrome gathers no ICE candidates for a
		// connection with nothing attached, and the negotiation stalls silently.
		const channel = connection.createDataChannel("chunks");
		channel.binaryType = "arraybuffer";
		this.channel = channel;
		channel.addEventListener("message", (event) => this.onChannelMessage(event));

		connection.addEventListener("icecandidate", (event) => {
			if (event.candidate) {
				this.signaling.send({ t: "signal", to: this.id, data: { ice: event.candidate.toJSON() } });
			}
		});

		const offer = await connection.createOffer();
		await connection.setLocalDescription(offer);
		this.signaling.send({ t: "signal", to: this.id, data: { sdp: offer } });

		const off = this.signaling.on(async (msg) => {
			if (msg.t !== "signal" || msg.from !== this.id) return;
			const payload = msg.data as { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit };
			try {
				if (payload.sdp) await connection.setRemoteDescription(payload.sdp);
				else if (payload.ice) await connection.addIceCandidate(payload.ice);
			} catch {
				this.healthy = false;
			}
		});

		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("peer connect timeout")),
					PEER_CONNECT_TIMEOUT_MS,
				);
				channel.addEventListener(
					"open",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
				channel.addEventListener(
					"error",
					() => {
						clearTimeout(timer);
						reject(new Error("peer channel error"));
					},
					{ once: true },
				);
			});
		} catch (err) {
			off();
			this.healthy = false;
			this.close();
			throw err;
		}
	}

	async fetchChunk(index: number): Promise<Uint8Array | null> {
		if (!this.healthy || this.channel?.readyState !== "open") return null;
		// One request in flight per peer — the engine already parallelises across sources,
		// and multiplexing here would need request ids for no gain.
		if (this.pending) return null;

		return new Promise<Uint8Array | null>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pending?.index === index) {
					this.pending = null;
					// A peer that goes quiet is not poisoned, just useless — the engine falls
					// back to the hub, and a slow peer should not be treated as a hostile one.
					this.healthy = false;
					resolve(null);
				}
			}, PEER_CHUNK_TIMEOUT_MS);

			this.pending = {
				index,
				resolve: (bytes) => {
					clearTimeout(timer);
					resolve(bytes);
				},
			};
			this.channel?.send(JSON.stringify({ t: "want", index }));
		});
	}

	markPoisoned(): void {
		// Bytes that failed the manifest's hash. Unlike a timeout, this is a peer serving
		// something other than the file, so it is dropped rather than merely skipped.
		this.healthy = false;
		this.close();
	}

	close(): void {
		try {
			this.channel?.close();
			this.connection?.close();
		} catch {
			// Already torn down.
		}
		this.channel = null;
		this.connection = null;
		this.pending?.resolve(null);
		this.pending = null;
	}

	private onChannelMessage(event: MessageEvent): void {
		const waiting = this.pending;
		if (!waiting) return;
		if (typeof event.data === "string") {
			// A JSON frame here means "I don't have it" — the only non-binary reply.
			this.pending = null;
			waiting.resolve(null);
			return;
		}
		this.pending = null;
		waiting.resolve(new Uint8Array(event.data as ArrayBuffer));
	}
}

/**
 * Bring up the swarm for one asset and hand back whatever peers actually connected.
 *
 * Every failure here is non-fatal by design: no relay, no peers, a peer that will not
 * negotiate — all of them return fewer sources, and the engine falls back to the hub. The
 * swarm is an optimisation, and an optimisation that can fail a download is a liability.
 */
export async function joinSwarm(
	token: string,
	opts: { maxPeers?: number; announce?: boolean } = {},
): Promise<{ peers: PeerChunkSource[]; signaling: SignalingConnection | null }> {
	const signaling = new SignalingConnection();
	try {
		await signaling.connect(token);
	} catch {
		signaling.close();
		return { peers: [], signaling: null };
	}

	// Announcing means "I can serve this asset too". Not done while downloading — a browser
	// streaming to OPFS holds nothing to serve, so sharing means deliberately keeping a
	// window of chunks or reading back from disk. That is a design with a memory budget,
	// and it is explicitly post-launch (45.01 § 0).
	if (opts.announce) signaling.send({ t: "announce" });

	const peerIds = await signaling.requestPeers();
	const connected: PeerChunkSource[] = [];
	for (const peerId of peerIds.slice(0, opts.maxPeers ?? 4)) {
		const peer = new PeerChunkSource(peerId, signaling);
		try {
			await peer.connect();
			connected.push(peer);
		} catch {
			// This peer did not come up. The next one might; the hub certainly will.
		}
	}
	return { peers: connected, signaling };
}
