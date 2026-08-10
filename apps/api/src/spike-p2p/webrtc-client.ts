// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * P2P delivery spike — WebRTC browser test client HTML.
 *
 * Tests browser-to-browser chunk transfer over WebRTC:
 * 1. Host tab: downloads the file from the hub (has the bytes), announces as a host
 * 2. Download tab: gets manifest + token from hub, connects to host over WebRTC, requests chunks
 * 3. Chunks flow over the data channel, hashes verified, file reassembled
 *
 * This is the spike that tests whether browser peers can actually talk to each other —
 * the NAT traversal / WebRTC feasibility question from 45.01 § Risk register.
 */

export const WEBRTC_CLIENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anthers P2P WebRTC Spike</title>
<style>
	body { font-family: system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #1a1a2e; color: #e0e0e0; }
	h1 { color: #7c4dff; }
	h2 { color: #b388ff; margin-top: 2rem; }
	.card { background: #16213e; border-radius: 8px; padding: 1.5rem; margin: 1rem 0; }
	button { background: #7c4dff; color: white; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; margin: 0.25rem; }
	button:hover { background: #651fff; }
	button:disabled { background: #444; cursor: not-allowed; }
	.log { font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; max-height: 500px; overflow-y: auto; background: #0d1117; padding: 1rem; border-radius: 4px; border: 1px solid #333; }
	.pass { color: #4caf50; font-weight: bold; }
	.fail { color: #f44336; font-weight: bold; }
	.info { color: #2196f3; }
	.warn { color: #ff9800; }
	.muted { color: #888; }
	.stat { display: inline-block; background: #0d1117; padding: 0.5rem 1rem; border-radius: 4px; margin: 0.25rem; border: 1px solid #333; }
	input { background: #0d1117; color: #e0e0e0; border: 1px solid #444; padding: 0.4rem; border-radius: 4px; width: 200px; }
</style>
</head>
<body>
<h1>Anthers P2P WebRTC Spike</h1>
<p class="muted">Tests browser-to-browser chunk transfer over WebRTC. Open this page in two tabs: one as Host, one as Downloader.</p>

<div class="card">
	<h2>Configuration</h2>
	<label>API base: <input id="apiBase" value="http://localhost:8000" /></label><br>
	<label>Work ID: <input id="workId" value="12743" /></label>
	<label>Asset ID: <input id="assetId" value="2721" /></label><br><br>
	<label>Username: <input id="username" value="gauntlet_viewer" /></label>
	<label>Password: <input id="password" type="password" value="gauntletpassword123" /></label>
</div>

<div class="card">
	<h2>Tab 1: Host Mode</h2>
	<p>Downloads the file from the hub, then serves chunks to downloaders over WebRTC.</p>
	<button onclick="startHost()">Start Host</button>
	<button onclick="stopHost()">Stop Host</button>
	<div id="hostLog" class="log"></div>
</div>

<div class="card">
	<h2>Tab 2: Downloader Mode</h2>
	<p>Gets manifest + token from hub, connects to host over WebRTC, downloads chunks P2P.</p>
	<button id="dlBtn" onclick="startDownload()">Start Download (P2P)</button>
	<button onclick="startDownloadFromHub()">Download from Hub (fallback test)</button>
	<div id="dlLog" class="log"></div>
</div>

<div class="card">
	<h2>Results</h2>
	<table id="resultsTable">
		<tr><th>Metric</th><th>Value</th></tr>
		<tr><td>WebRTC connection established</td><td id="r-conn">—</td></tr>
		<tr><td>ICE negotiation time</td><td id="r-ice">—</td></tr>
		<tr><td>Data channel opened</td><td id="r-channel">—</td></tr>
		<tr><td>Chunks transferred P2P</td><td id="r-chunks">—</td></tr>
		<tr><td>P2P transfer time</td><td id="r-time">—</td></tr>
		<tr><td>P2P throughput</td><td id="r-throughput">—</td></tr>
		<tr><td>File hash verified</td><td id="r-hash">—</td></tr>
		<tr><td>Hub-served bytes (fallback)</td><td id="r-hub">—</td></tr>
	</table>
</div>

<script>
const apiBase = () => document.getElementById("apiBase").value;
const workId = () => document.getElementById("workId").value;
const assetId = () => document.getElementById("assetId").value;
const myPeerId = crypto.randomUUID();

function log(id, msg, cls) {
	const el = document.getElementById(id);
	el.innerHTML += '<span class="' + (cls||"") + '">' + msg + '</span>\\n';
	el.scrollTop = el.scrollHeight;
}

function setResult(id, val, cls) {
	const el = document.getElementById(id);
	el.textContent = val;
	el.className = cls || "";
}

async function sha256hex(data) {
	const hash = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function login() {
	const res = await fetch(apiBase() + "/api/auth/sign-in", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Origin": apiBase() },
		credentials: "include",
		body: JSON.stringify({ login: document.getElementById("username").value, password: document.getElementById("password").value }),
	});
	if (!res.ok) throw new Error("Login failed: " + res.status);
	return res.json();
}

async function fetchManifest() {
	const res = await fetch(apiBase() + "/api/spike-p2p/works/" + workId() + "/assets/" + assetId() + "/manifest", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Origin": apiBase() },
		credentials: "include",
	});
	return res;
}

// ─── Host Mode ───────────────────────────────────────────────────────────────
let hostWs = null;
let hostManifest = null;
let hostBytes = null;
let hostToken = null;

async function startHost() {
	const el = "hostLog";
	document.getElementById(el).innerHTML = "";
	try {
		log(el, "Logging in...");
		await login();
		log(el, "Fetching manifest + downloading file from hub...", "info");

		const res = await fetchManifest();
		if (!res.ok) { log(el, "Manifest failed: " + res.status, "fail"); return; }
		const data = await res.json();
		hostManifest = data.manifest;
		hostToken = data.token;
		log(el, "Manifest received: " + hostManifest.chunks.length + " chunks, " + (hostManifest.fileSize/1024/1024).toFixed(1) + " MiB", "pass");

		// Download all chunks from the hub (so the host has the bytes)
		log(el, "Downloading all chunks from hub...");
		hostBytes = new Uint8Array(hostManifest.fileSize);
		const t0 = performance.now();
		await Promise.all(hostManifest.chunks.map(async (chunk) => {
			const r = await fetch(apiBase() + "/api/spike-p2p/works/" + workId() + "/assets/" + assetId() + "/chunks/" + chunk.index, {
				headers: { "Authorization": "Bearer " + hostToken },
			});
			if (!r.ok) throw new Error("Chunk " + chunk.index + " failed: " + r.status);
			const bytes = new Uint8Array(await r.arrayBuffer());
			hostBytes.set(bytes, chunk.offset);
		}));
		const t1 = performance.now();
		log(el, "File downloaded from hub in " + (t1-t0).toFixed(0) + "ms", "pass");

		// Verify hash
		const hash = await sha256hex(hostBytes);
		if (hash === hostManifest.fileSha256) {
			log(el, "Hash verified — host has the full file", "pass");
		} else {
			log(el, "Hash mismatch!", "fail");
			return;
		}

		// Connect to signaling relay and announce as host
		log(el, "Connecting to signaling relay...", "info");
		const wsUrl = apiBase().replace("http", "ws") + "/api/spike-p2p/signal?peerId=" + myPeerId + "&role=host";
		hostWs = new WebSocket(wsUrl);
		hostWs.onopen = () => {
			log(el, "Signaling connected. Announcing as host for asset " + assetId(), "pass");
			hostWs.send(JSON.stringify({ type: "announce", assetId: Number(assetId()) }));
		};
		hostWs.onmessage = async (event) => {
			const msg = JSON.parse(event.data);
			if (msg.type === "connected") {
				log(el, "  Peer ID: " + msg.peerId, "muted");
			} else if (msg.type === "offer") {
				log(el, "Received WebRTC offer from downloader " + msg.from.substring(0,8), "info");
				await handleOffer(msg.from, msg.sdp);
			} else if (msg.type === "ice") {
				await handleRemoteIce(msg.from, msg.candidate);
			}
		};
		hostWs.onclose = () => log(el, "Signaling disconnected", "warn");
		hostWs.onerror = (e) => log(el, "Signaling error: " + e, "fail");

	} catch (e) {
		log(el, "ERROR: " + e.message, "fail");
	}
}

const hostPCs = new Map(); // peerId -> RTCPeerConnection

async function handleOffer(downloaderPeerId, sdp) {
	const el = "hostLog";
	log(el, "Creating RTCPeerConnection for downloader " + downloaderPeerId.substring(0,8) + "...", "info");

	const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
	hostPCs.set(downloaderPeerId, pc);

	// The downloader creates the data channel; we receive it via ondatachannel.
	pc.ondatachannel = (e) => {
		const channel = e.channel;
		channel.binaryType = "arraybuffer";
		log(el, "  Data channel received from downloader", "info");
		channel.onopen = () => {
			log(el, "  Data channel OPEN — downloader connected!", "pass");
		};
		channel.onmessage = async (event) => {
			const req = JSON.parse(event.data);
			if (req.type === "get-chunk") {
				const chunk = hostManifest.chunks[req.index];
				if (!chunk) { channel.send(JSON.stringify({ type: "error", error: "no such chunk" })); return; }
				const bytes = hostBytes.subarray(chunk.offset, chunk.offset + chunk.size);
				channel.send(JSON.stringify({ type: "chunk-meta", index: req.index, sha256: chunk.sha256, size: chunk.size }));
				channel.send(bytes);
			}
		};
	};

	pc.onicecandidate = (e) => {
		if (e.candidate) {
			log(el, "  [host] sending ICE candidate", "muted");
			hostWs.send(JSON.stringify({ type: "ice", to: downloaderPeerId, candidate: e.candidate }));
		} else {
			log(el, "  [host] ICE gathering complete", "muted");
		}
	};
	pc.oniceconnectionstatechange = () => {
		log(el, "  [host] ICE state: " + pc.iceConnectionState, "muted");
	};

	await pc.setRemoteDescription(sdp);
	const answer = await pc.createAnswer();
	await pc.setLocalDescription(answer);
	hostWs.send(JSON.stringify({ type: "answer", to: downloaderPeerId, sdp: answer }));
	log(el, "  Answer sent", "info");
}

async function handleRemoteIce(peerId, candidate) {
	const pc = hostPCs.get(peerId);
	if (pc) {
		try { await pc.addIceCandidate(candidate); } catch (e) { /* race condition, ignore */ }
	}
}

function stopHost() {
	for (const pc of hostPCs.values()) pc.close();
	hostPCs.clear();
	if (hostWs) { hostWs.close(); hostWs = null; }
	log("hostLog", "Host stopped", "warn");
}

// ─── Downloader Mode ─────────────────────────────────────────────────────────
let dlWs = null;
let dlManifest = null;
let dlToken = null;
let dlPC = null;
let dlChannel = null;
let iceStartTime = 0;

async function startDownload() {
	const el = "dlLog";
	document.getElementById(el).innerHTML = "";
	try {
		log(el, "Logging in...");
		await login();
		log(el, "Fetching manifest from hub (access-checked)...", "info");

		const res = await fetchManifest();
		if (!res.ok) { log(el, "Manifest failed: " + res.status, "fail"); return; }
		const data = await res.json();
		dlManifest = data.manifest;
		dlToken = data.token;
		log(el, "Manifest received: " + dlManifest.chunks.length + " chunks", "pass");

		// Connect to signaling relay
		log(el, "Connecting to signaling relay...", "info");
		const wsUrl = apiBase().replace("http", "ws") + "/api/spike-p2p/signal?peerId=" + myPeerId + "&role=downloader";
		dlWs = new WebSocket(wsUrl);

		await new Promise((resolve, reject) => {
			dlWs.onopen = resolve;
			dlWs.onerror = reject;
		});

		dlWs.onmessage = async (event) => {
			const msg = JSON.parse(event.data);
			log(el, "  [signal] " + msg.type + (msg.from ? " from " + msg.from.substring(0,8) : ""), "muted");
			if (msg.type === "peers") {
				const hosts = msg.peers.filter(p => p.peerId !== myPeerId);
				if (hosts.length > 0 && !dlPC) {
					log(el, "Found " + hosts.length + " host(s). Connecting to " + hosts[0].peerId.substring(0,8) + "...", "pass");
					await connectToHost(hosts[0].peerId);
				} else if (hosts.length === 0 && !dlPC) {
					log(el, "No hosts found. Retrying in 2s... (open Host mode in another tab)", "warn");
					setTimeout(() => {
						if (!dlPC) dlWs.send(JSON.stringify({ type: "subscribe", assetId: Number(assetId()) }));
					}, 2000);
				}
			} else if (msg.type === "answer") {
				if (dlPC && dlPC.signalingState !== "closed") {
					try {
						await dlPC.setRemoteDescription(msg.sdp);
						log(el, "  Remote description set", "info");
					} catch (e) {
						log(el, "  setRemoteDescription error: " + e.message, "fail");
					}
				} else {
					log(el, "  Got answer but dlPC is " + (dlPC ? "in state " + dlPC.signalingState : "null"), "warn");
				}
			} else if (msg.type === "ice") {
				if (dlPC) {
					try { await dlPC.addIceCandidate(msg.candidate); } catch (e) { log(el, "  addIceCandidate error: " + e.message, "warn"); }
				}
			}
		};

		// Subscribe to peer list
		dlWs.send(JSON.stringify({ type: "subscribe", assetId: Number(assetId()) }));

	} catch (e) {
		log(el, "ERROR: " + e.message, "fail");
	}
}

async function connectToHost(hostPeerId) {
	const el = "dlLog";
	iceStartTime = performance.now();

	dlPC = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

	// Create the data channel BEFORE creating the offer — this ensures the SDP
	// includes a data channel media line, which triggers ICE candidate gathering.
	// Without this, the offer has no media and Chrome won't gather ICE candidates.
	dlChannel = dlPC.createDataChannel("chunks", { ordered: true });
	dlChannel.binaryType = "arraybuffer";

	dlPC.onicecandidate = (e) => {
		if (e.candidate) {
			log(el, "  [dl] sending ICE candidate", "muted");
			dlWs.send(JSON.stringify({ type: "ice", to: hostPeerId, candidate: e.candidate }));
		} else {
			log(el, "  [dl] ICE gathering complete", "muted");
		}
	};

	dlPC.oniceconnectionstatechange = () => {
		log(el, "  ICE state: " + dlPC.iceConnectionState, "muted");
		if (dlPC.iceConnectionState === "connected" || dlPC.iceConnectionState === "completed") {
			const t = (performance.now() - iceStartTime).toFixed(0);
			log(el, "ICE CONNECTED in " + t + "ms", "pass");
			setResult("r-ice", t + "ms", "pass");
			setResult("r-conn", "YES", "pass");
		}
	};

	dlChannel.onopen = async () => {
		log(el, "Data channel OPEN — starting P2P download", "pass");
		setResult("r-channel", "YES", "pass");
		await downloadOverChannel();
	};

	// Create and send offer
	const offer = await dlPC.createOffer();
	await dlPC.setLocalDescription(offer);
	dlWs.send(JSON.stringify({ type: "offer", to: hostPeerId, sdp: offer }));
	log(el, "Offer sent to host", "info");
}

async function downloadOverChannel() {
	const el = "dlLog";
	const assembled = new Uint8Array(dlManifest.fileSize);
	let chunksReceived = 0;
	let hubFallbackBytes = 0;
	const t0 = performance.now();

	// Request chunks sequentially (simple protocol; real impl would pipeline)
	for (let i = 0; i < dlManifest.chunks.length; i++) {
		const chunk = dlManifest.chunks[i];
		dlChannel.send(JSON.stringify({ type: "get-chunk", index: i }));

		// Wait for chunk-meta + binary data
		const [meta, binary] = await waitForChunk(dlChannel);
		if (meta.type === "error") {
			// Fallback to hub for this chunk
			log(el, "  Chunk " + i + " failed P2P, falling back to hub", "warn");
			const r = await fetch(apiBase() + "/api/spike-p2p/works/" + workId() + "/assets/" + assetId() + "/chunks/" + i, {
				headers: { "Authorization": "Bearer " + dlToken },
			});
			const bytes = new Uint8Array(await r.arrayBuffer());
			assembled.set(bytes, chunk.offset);
			hubFallbackBytes += bytes.length;
		} else {
			const bytes = new Uint8Array(binary);
			// Verify chunk hash
			const hash = await sha256hex(bytes);
			if (hash !== chunk.sha256) {
				log(el, "  Chunk " + i + " hash mismatch over P2P! Falling back to hub", "fail");
				const r = await fetch(apiBase() + "/api/spike-p2p/works/" + workId() + "/assets/" + assetId() + "/chunks/" + i, {
					headers: { "Authorization": "Bearer " + dlToken },
				});
				const hubBytes = new Uint8Array(await r.arrayBuffer());
				assembled.set(hubBytes, chunk.offset);
				hubFallbackBytes += hubBytes.length;
			} else {
				assembled.set(bytes, chunk.offset);
				chunksReceived++;
			}
		}

		if ((i+1) % 10 === 0 || i === dlManifest.chunks.length - 1) {
			log(el, "  " + (i+1) + "/" + dlManifest.chunks.length + " chunks (" + chunksReceived + " P2P, " + (hubFallbackBytes/1024/1024).toFixed(1) + " MiB hub fallback)", "muted");
		}
	}

	const t1 = performance.now();
	const totalSec = (t1 - t0) / 1000;
	const throughput = (dlManifest.fileSize / 1024 / 1024) / totalSec;

	log(el, "\\nDownload complete in " + totalSec.toFixed(2) + "s", "pass");
	log(el, "  P2P chunks: " + chunksReceived + "/" + dlManifest.chunks.length, "pass");
	log(el, "  Hub fallback: " + (hubFallbackBytes/1024/1024).toFixed(2) + " MiB", hubFallbackBytes > 0 ? "warn" : "pass");
	log(el, "  Throughput: " + throughput.toFixed(1) + " MiB/s", "info");

	// Verify total file hash
	const totalHash = await sha256hex(assembled);
	if (totalHash === dlManifest.fileSha256) {
		log(el, "FILE HASH VERIFIED", "pass");
		setResult("r-hash", "VERIFIED", "pass");
	} else {
		log(el, "FILE HASH MISMATCH!", "fail");
		setResult("r-hash", "MISMATCH", "fail");
	}

	setResult("r-chunks", chunksReceived + "/" + dlManifest.chunks.length, "pass");
	setResult("r-time", totalSec.toFixed(2) + "s", "pass");
	setResult("r-throughput", throughput.toFixed(1) + " MiB/s", "pass");
	setResult("r-hub", (hubFallbackBytes/1024/1024).toFixed(2) + " MiB", hubFallbackBytes > 0 ? "warn" : "pass");
}

function waitForChunk(channel) {
	return new Promise((resolve) => {
		let meta = null;
		let binary = null;
		const handler = (event) => {
			if (typeof event.data === "string") {
				meta = JSON.parse(event.data);
				if (meta.type === "error") {
					channel.removeEventListener("message", handler);
					resolve([meta, null]);
				}
			} else {
				binary = event.data;
				channel.removeEventListener("message", handler);
				resolve([meta, binary]);
			}
		};
		channel.addEventListener("message", handler);
	});
}

async function startDownloadFromHub() {
	const el = "dlLog";
	document.getElementById(el).innerHTML = "";
	try {
		log(el, "Logging in...");
		await login();
		log(el, "Fetching manifest...", "info");
		const res = await fetchManifest();
		if (!res.ok) { log(el, "Manifest failed: " + res.status, "fail"); return; }
		const data = await res.json();
		dlManifest = data.manifest;
		dlToken = data.token;
		log(el, "Downloading all chunks from hub (HTTP fallback)...", "info");

		const assembled = new Uint8Array(dlManifest.fileSize);
		const t0 = performance.now();
		await Promise.all(dlManifest.chunks.map(async (chunk) => {
			const r = await fetch(apiBase() + "/api/spike-p2p/works/" + workId() + "/assets/" + assetId() + "/chunks/" + chunk.index, {
				headers: { "Authorization": "Bearer " + dlToken },
			});
			if (!r.ok) throw new Error("Chunk " + chunk.index + ": " + r.status);
			const bytes = new Uint8Array(await r.arrayBuffer());
			const hash = await sha256hex(bytes);
			if (hash !== chunk.sha256) throw new Error("Chunk " + chunk.index + " hash mismatch");
			assembled.set(bytes, chunk.offset);
		}));
		const t1 = performance.now();
		const totalHash = await sha256hex(assembled);
		if (totalHash === dlManifest.fileSha256) {
			log(el, "Hub download OK in " + ((t1-t0)/1000).toFixed(2) + "s, hash verified", "pass");
			setResult("r-hub", dlManifest.fileSize/1024/1024 + " MiB (all hub)", "warn");
		} else {
			log(el, "Hub download hash mismatch!", "fail");
		}
	} catch (e) {
		log(el, "ERROR: " + e.message, "fail");
	}
}
</script>
</body>
</html>`;
