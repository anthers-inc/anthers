// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WebRTC signaling relay for the P2P spike.
 *
 * The hub acts as the signaling server — peers exchange SDP offers/answers and ICE
 * candidates through it. The hub does NOT participate in the data transfer; it just
 * relays signaling messages between peers.
 *
 * The relay is a WebSocket server on the same port as the API. WebSocket upgrade
 * requests for /api/spike-p2p/signal are intercepted before they reach Hono.
 *
 * Protocol:
 * - Peer connects to ws://host/api/spike-p2p/signal?peerId=<id>&role=host|downloader
 * - Host announces itself: { type: "announce", peerId, assetId }
 * - Downloader requests the peer list: { type: "peers", assetId }
 * - Hub responds with available peers: { type: "peers", peers: [...] }
 * - Downloader sends offer to a host: { type: "offer", to: hostPeerId, sdp }
 * - Hub relays: { type: "offer", from: downloaderPeerId, sdp }
 * - Host sends answer: { type: "answer", to: downloaderPeerId, sdp }
 * - Hub relays: { type: "answer", from: hostPeerId, sdp }
 * - Either side sends ICE candidate: { type: "ice", to: peerId, candidate }
 * - Hub relays: { type: "ice", from: peerId, candidate }
 */

export interface SignalingPeer {
	peerId: string;
	role: "host" | "downloader";
	assetId: number | null;
	ws: any; // Bun WebSocket
}

const peers = new Map<string, SignalingPeer>();

function broadcastPeerList(assetId: number) {
	const available = [...peers.values()]
		.filter((p) => p.role === "host" && p.assetId === assetId)
		.map((p) => ({ peerId: p.peerId, assetId: p.assetId }));
	const msg = JSON.stringify({ type: "peers", peers: available });
	for (const p of peers.values()) {
		if (p.role === "downloader" && p.assetId === assetId) {
			try {
				p.ws.send(msg);
			} catch {}
		}
	}
}

export function handleSignalingConnection(ws: any, peerId: string, role: "host" | "downloader") {
	const peer: SignalingPeer = {
		peerId,
		role,
		assetId: null,
		ws,
	};
	peers.set(peerId, peer);
	ws.data = { peerId };

	ws.send(JSON.stringify({ type: "connected", peerId }));
}

export function handleSignalingMessage(ws: any, message: string | Buffer) {
	const data = JSON.parse(message.toString());
	const peerId = ws.data?.peerId;
	if (!peerId) return;
	const peer = peers.get(peerId);
	if (!peer) return;

	switch (data.type) {
		case "announce": {
			// Host announces it has chunks for an asset
			peer.assetId = data.assetId;
			broadcastPeerList(data.assetId);
			break;
		}
		case "subscribe": {
			// Downloader wants to know about hosts for an asset
			peer.assetId = data.assetId;
			// Send current peer list immediately
			const available = [...peers.values()]
				.filter((p) => p.role === "host" && p.assetId === data.assetId)
				.map((p) => ({ peerId: p.peerId, assetId: p.assetId }));
			ws.send(JSON.stringify({ type: "peers", peers: available }));
			break;
		}
		case "offer": {
			// Downloader → Host (relay SDP offer)
			const target = peers.get(data.to);
			if (target) {
				target.ws.send(JSON.stringify({ type: "offer", from: peerId, sdp: data.sdp }));
			}
			break;
		}
		case "answer": {
			// Host → Downloader (relay SDP answer)
			const target = peers.get(data.to);
			if (target) {
				target.ws.send(JSON.stringify({ type: "answer", from: peerId, sdp: data.sdp }));
			}
			break;
		}
		case "ice": {
			// Either side → other (relay ICE candidate)
			const target = peers.get(data.to);
			if (target) {
				target.ws.send(JSON.stringify({ type: "ice", from: peerId, candidate: data.candidate }));
			}
			break;
		}
	}
}

export function handleSignalingClose(ws: any) {
	const peerId = ws.data?.peerId;
	if (!peerId) return;
	const peer = peers.get(peerId);
	if (peer) {
		peers.delete(peerId);
		if (peer.role === "host" && peer.assetId != null) {
			broadcastPeerList(peer.assetId);
		}
	}
}
