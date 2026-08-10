// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * WebRTC P2P spike — MANUAL two-browser harness. Not part of any suite.
 *
 * Opens two Chromium contexts: one as Host, one as Downloader. The Host downloads
 * the file from the hub and announces itself; the Downloader connects over WebRTC
 * and pulls chunks P2P. This is the spike that answered the NAT traversal / WebRTC
 * feasibility question in 45.01 § Risk register. It has already served that purpose —
 * the finding is written up in the WebRTC spike report.
 *
 * ─── Why `.manual.ts` and not `.e2e.ts` ──────────────────────────────────────
 *
 * It cannot pass in CI, and it took `main` red on 2026-08-10 proving that. Playwright's
 * `chromium` project claims every `*.e2e.ts` under tests/e2e, so shipping this as one
 * enrolled a hand-driven harness into the regression suite. Three separate reasons it
 * can never be green there, any one of which is fatal:
 *
 *   - The client page hardcodes Work 12743 / Asset 2721 — Postgres `serial` IDs from
 *     one developer's local database. CI builds a fresh database every run, so those
 *     rows do not exist and the manifest call 404s. That is the exact failure that
 *     went red: `Manifest failed: 404`.
 *   - It needs `bun run spike:p2p:seed` to have written a 10 MiB file to that asset,
 *     which CI never runs (and which hardcodes 2721 a second time).
 *   - It lives in the `chromium` project, which has no `dependencies: ["setup"]`, so
 *     it does not even guarantee the gauntlet fixture exists.
 *
 * The general rule this is an instance of: a harness with a config form and buttons is
 * driven by a person, and an extension is not a decision about that — the glob is. If a
 * spike harness earns a place in CI later, it earns it by deriving its fixtures at
 * runtime, not by being renamed back.
 *
 * ─── Running it ──────────────────────────────────────────────────────────────
 *
 * The spike routes are NOT mounted — `/api/spike-p2p` was removed from apps/api/src/index.ts
 * along with the WebSocket signaling relay (see the note on the default export there for
 * why). To revive this harness:
 *
 *   1. Re-add `.route("/api/spike-p2p", spikeP2pRoutes)` and the Bun.serve `websocket`
 *      handler to apps/api/src/index.ts. Keep it local — the relay authenticates nobody
 *      and the client page carries the gauntlet password in its markup.
 *   2. `make gauntlet-reset && bun run spike:p2p:seed`
 *   3. Read the real Work and Asset IDs out of your database and update both the client
 *      page defaults (apps/api/src/spike-p2p/webrtc-client.ts) and the seeder's
 *      TARGET_ASSET_ID (apps/api/src/spike-p2p/seed.ts).
 *   4. `make dev`, then `bunx playwright test webrtc-p2p-spike.manual.ts`
 *
 * When the real relay arrives with milestone 9 of the P2P lane it belongs in
 * apps/api/src/p2p/, scoped by the 45.05 token — this file's protocol shape is a
 * reference for that, not a thing to promote.
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
