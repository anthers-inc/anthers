// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `anthersp2p` — the open client for Anthers' authenticated P2P delivery.
 *
 * Named for both halves it will eventually carry (download *and* hosting), which is why it
 * is not `anthersdl`. Today only the download half exists; see § Seeding below.
 *
 * Usage:
 *   anthersp2p pull <workId> <assetId> [--out FILE] [--resume] [--concurrency N]
 *   anthersp2p manifest <workId> <assetId>
 *
 * Auth is a session token, passed as `--token` or `ANTHERS_TOKEN`. That is the same opaque
 * `sessions` row the desktop Studio carries as a bearer credential — no new auth primitive,
 * which is the same reasoning 42.06 used. A PKCE browser handoff like the desktop app's
 * would be friendlier and is the obvious follow-up; a token you can paste is what makes the
 * client usable today without one.
 *
 * ── Seeding is NOT here, and the reason is a dependency decision ────────────────────
 *
 * 🚨 Bun ships no `RTCPeerConnection`. Serving chunks to browser peers means a native
 * WebRTC implementation (`node-datachannel` or similar), which is a real dependency call —
 * a native module, in the one artifact whose whole value is that anyone can build and audit
 * it. Until that is decided, **no peer in the swarm can serve**: the browser client asks
 * `{t:"want"}` over its data channel and nothing anywhere answers, so the relay has never
 * introduced two peers that could trade bytes. The hub is the only host, and the P2P path
 * is currently a verified download protocol rather than a swarm.
 */

import { basename } from "node:path";
import { AccessDeniedError, fetchManifest, pullAsset, VerificationError } from "./pull.js";

const DEFAULT_BASE_URL = "https://anthers.org";

function usage(): never {
	console.error(`anthersp2p — the open client for Anthers P2P delivery

  anthersp2p pull <workId> <assetId> [options]     download and verify an asset
  anthersp2p manifest <workId> <assetId>           print the manifest as JSON

Options:
  --out FILE          where to write (default: the asset's own filename)
  --resume            re-verify what is on disk and fetch only what is missing
  --concurrency N     chunks in flight (default 4)
  --url ORIGIN        hub origin (default ${DEFAULT_BASE_URL}, or ANTHERS_URL)
  --token TOKEN       session token (or ANTHERS_TOKEN)

Every chunk is verified against the manifest before it is written, and the finished
file is checked end to end. Manifest format: 45.04.`);
	process.exit(2);
}

function parseArgs(argv: string[]) {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith("--")) {
			const key = arg.slice(2);
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				flags[key] = next;
				i++;
			} else {
				flags[key] = true;
			}
		} else {
			positional.push(arg);
		}
	}
	return { positional, flags };
}

function humanBytes(n: number): string {
	if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
	if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
	return `${(n / 1024).toFixed(0)} KiB`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
	const { positional, flags } = parseArgs(argv);
	const command = positional[0];
	if (!command || flags.help) usage();

	const baseUrl = String(flags.url ?? process.env.ANTHERS_URL ?? DEFAULT_BASE_URL).replace(
		/\/$/,
		"",
	);
	const token = String(flags.token ?? process.env.ANTHERS_TOKEN ?? "");
	if (!token) {
		console.error("No session token. Pass --token or set ANTHERS_TOKEN.");
		return 2;
	}

	const workId = positional[1];
	const assetId = Number(positional[2]);
	if (!workId || !Number.isInteger(assetId)) usage();

	try {
		if (command === "manifest") {
			const { manifest } = await fetchManifest({ baseUrl, token, workId, assetId });
			console.log(JSON.stringify(manifest, null, 2));
			return 0;
		}

		if (command === "pull") {
			const { manifest } = await fetchManifest({ baseUrl, token, workId, assetId });
			const outputPath = String(
				flags.out ?? basename(manifest.assetFilename || `asset-${assetId}`),
			);

			console.error(
				`${manifest.assetFilename}  ${humanBytes(manifest.assetSize)}  ` +
					`${manifest.chunks.length} chunks  →  ${outputPath}`,
			);

			let lastPct = -1;
			const result = await pullAsset({
				baseUrl,
				token,
				workId,
				assetId,
				outputPath,
				resume: flags.resume === true,
				concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
				onProgress: (done, total) => {
					const pct = Math.floor((done / total) * 100);
					// Progress to stderr so `anthersp2p manifest … | jq` stays clean and a
					// redirected pull does not fill a log with carriage returns.
					if (pct !== lastPct && process.stderr.isTTY) {
						process.stderr.write(`\r  ${pct}%  (${done}/${total} chunks)`);
						lastPct = pct;
					}
				},
			});
			if (process.stderr.isTTY) process.stderr.write("\r");

			const skipped = result.chunksSkipped
				? `, ${result.chunksSkipped} chunks already present`
				: "";
			console.error(`  verified ✓  ${humanBytes(result.bytesWritten)} written${skipped}`);
			return 0;
		}

		usage();
	} catch (err) {
		// Each of these means something different to whoever is reading, and an exit code
		// that distinguishes them is what makes the CLI scriptable.
		if (err instanceof AccessDeniedError) {
			console.error(`\n  ${err.message}`);
			return 77; // EX_NOPERM
		}
		if (err instanceof VerificationError) {
			console.error(`\n  Integrity check failed: ${err.message}`);
			console.error("  The file on disk is not what the manifest describes. It was not completed.");
			return 65; // EX_DATAERR
		}
		console.error(`\n  ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
