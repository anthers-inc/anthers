// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WebRTC P2P spike — automated two-browser test.
 *
 * Opens two Chromium contexts: one as Host, one as Downloader. The Host downloads
 * the file from the hub and announces itself; the Downloader connects over WebRTC
 * and pulls chunks P2P. This is the spike that tests whether browser peers can
 * actually talk to each other — the NAT traversal / WebRTC feasibility question.
 *
 * Run with: bunx playwright test webrtc-p2p-spike.e2e.ts
 * (requires the API running on localhost:8000 with the gauntlet fixture seeded)
 */
import { expect, test } from "@playwright/test";

const API = "http://localhost:8000";
const WEBRTC_CLIENT = `${API}/api/spike-p2p/webrtc-client`;

test("WebRTC browser-to-browser chunk transfer", async ({ browser }) => {
	test.setTimeout(60000); // 1 minute — if WebRTC doesn't connect in 60s, it's not going to

	// Two contexts = two independent browser sessions
	const hostCtx = await browser.newContext();
	const downloaderCtx = await browser.newContext();
	const hostPage = await hostCtx.newPage();
	const downloaderPage = await downloaderCtx.newPage();

	const hostLogs: string[] = [];
	const downloaderLogs: string[] = [];

	hostPage.on("console", (msg) => hostLogs.push(`[${msg.type()}] ${msg.text()}`));
	downloaderPage.on("console", (msg) => downloaderLogs.push(`[${msg.type()}] ${msg.text()}`));
	hostPage.on("pageerror", (err) => hostLogs.push(`[PAGE ERROR] ${err.message}`));
	downloaderPage.on("pageerror", (err) => downloaderLogs.push(`[PAGE ERROR] ${err.message}`));

	// Helper: dump all logs for debugging
	function dumpLogs(label: string) {
		console.log(`\n=== ${label} — Page Logs ===`);
		try {
			const hostText = hostPage.evaluate(
				() => document.querySelector("#hostLog")?.textContent ?? "(empty)",
			);
		} catch {}
		console.log("\n=== Host Console ===");
		console.log(hostLogs.join("\n") || "(none)");
		console.log("\n=== Downloader Console ===");
		console.log(downloaderLogs.join("\n") || "(none)");
	}

	try {
		// Start the Host first — it needs to download the file and announce before the downloader connects
		await hostPage.goto(WEBRTC_CLIENT);
		await hostPage.click("text=Start Host");

		// Wait for the host to announce
		await hostPage.waitForFunction(
			() => document.querySelector("#hostLog")?.textContent?.includes("Announcing as host"),
			{ timeout: 30000 },
		);
		console.log("Host announced. Starting downloader...");

		// Give the host a moment to register with the signaling relay
		await hostPage.waitForTimeout(1000);

		// Now start the Downloader
		await downloaderPage.goto(WEBRTC_CLIENT);
		await downloaderPage.click("text=Start Download (P2P)");

		// Poll for completion — check every 2s
		const deadline = Date.now() + 45000;
		while (Date.now() < deadline) {
			const dlText = await downloaderPage.evaluate(
				() => document.querySelector("#dlLog")?.textContent ?? "",
			);
			if (dlText.includes("FILE HASH VERIFIED") || dlText.includes("FILE HASH MISMATCH")) {
				break;
			}
			await downloaderPage.waitForTimeout(2000);
		}

		// Capture final state
		const dlLogText = await downloaderPage.evaluate(
			() => document.querySelector("#dlLog")?.textContent ?? "(empty)",
		);
		const hostLogText = await hostPage.evaluate(
			() => document.querySelector("#hostLog")?.textContent ?? "(empty)",
		);

		console.log("\n=== Host Page Log ===");
		console.log(hostLogText);
		console.log("\n=== Downloader Page Log ===");
		console.log(dlLogText);

		// Assertions — the core claims
		expect(dlLogText).toContain("Data channel OPEN");
		expect(dlLogText).toContain("FILE HASH VERIFIED");

		// Report connection metrics
		const iceTime = await downloaderPage.evaluate(
			() => document.querySelector("#r-ice")?.textContent,
		);
		const throughput = await downloaderPage.evaluate(
			() => document.querySelector("#r-throughput")?.textContent,
		);
		const p2pChunks = await downloaderPage.evaluate(
			() => document.querySelector("#r-chunks")?.textContent,
		);
		const hubFallback = await downloaderPage.evaluate(
			() => document.querySelector("#r-hub")?.textContent,
		);

		console.log("\n=== WebRTC Spike Results ===");
		console.log(`ICE negotiation time: ${iceTime}`);
		console.log(`P2P chunks: ${p2pChunks}`);
		console.log(`Throughput: ${throughput}`);
		console.log(`Hub fallback: ${hubFallback}`);
	} catch (err) {
		// Print everything on failure
		console.log("\n=== TEST FAILED ===");
		console.log(String(err));
		console.log("\n=== Host Console ===");
		console.log(hostLogs.join("\n") || "(none)");
		console.log("\n=== Downloader Console ===");
		console.log(downloaderLogs.join("\n") || "(none)");
		try {
			const hostLogText = await hostPage.evaluate(
				() => document.querySelector("#hostLog")?.textContent ?? "(empty)",
			);
			console.log("\n=== Host Page Log ===");
			console.log(hostLogText);
		} catch {}
		try {
			const dlLogText = await downloaderPage.evaluate(
				() => document.querySelector("#dlLog")?.textContent ?? "(empty)",
			);
			console.log("\n=== Downloader Page Log ===");
			console.log(dlLogText);
		} catch {}
		throw err;
	} finally {
		try {
			await hostCtx.close();
		} catch {}
		try {
			await downloaderCtx.close();
		} catch {}
	}
});
