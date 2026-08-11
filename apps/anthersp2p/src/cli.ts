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
 * ── Seeding is HTTP, not WebRTC, and that was the whole unlock ──────────────────────
 *
 * WebRTC exists to get through NAT. A host that can accept an inbound connection does not
 * need it, and serving over HTTPS costs no new protocol, no native module (Bun ships no
 * `RTCPeerConnection`), and no TURN relay — TURN being bytes *Anthers* would pay for, which
 * would quietly falsify 45.01 § 6's "swarm-served bytes are free to both sides".
 *
 * `seed` answers exactly the hub's own URL shape, so a client pointed at a peer is the hub
 * client with a different origin. One download architecture, not one plus a peer dialect.
 *
 * ⚠️ Still true: a peer that *cannot* accept inbound — an ordinary user behind NAT — needs
 * WebRTC, and the browser client's `{t:"want"}` data-channel path still has nothing
 * answering it. That population is 45.01's "as soon as viable", not a launch requirement.
 */

import { basename } from "node:path";
import { AccessDeniedError, fetchManifest, pullAsset, VerificationError } from "./pull.js";
import { SeedError, startSeeder } from "./seed.js";

const DEFAULT_BASE_URL = "https://anthers.org";

function usage(): never {
	console.error(`anthersp2p — the open client for Anthers P2P delivery

  anthersp2p pull <workId> <assetId> [options]     download and verify an asset
  anthersp2p seed <workId> <assetId> --file F      serve chunks to entitled peers
  anthersp2p manifest <workId> <assetId>           print the manifest as JSON

Options:
  --out FILE          where to write (default: the asset's own filename)
  --file FILE         (seed) the local copy to serve
  --port N            (seed) listen port (default 8080)
  --skip-verify       (seed) don't check the local file first — see the docs, it's a foot-gun
  --resume            re-verify what is on disk and fetch only what is missing
  --concurrency N     chunks in flight (default 4)
  --peer ORIGIN       (pull) fetch chunks from this peer; manifest still comes from the hub
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

		if (command === "seed") {
			const filePath = String(flags.file ?? "");
			if (!filePath) {
				console.error("seed needs --file pointing at your local copy of the asset.");
				return 2;
			}
			const seeder = await startSeeder({
				baseUrl,
				token,
				workId,
				assetId,
				filePath,
				port: flags.port ? Number(flags.port) : undefined,
				skipVerify: flags["skip-verify"] === true,
				onLog: (line) => console.error(line),
			});
			console.error(
				`seeding ${seeder.manifest.assetFilename} (${seeder.manifest.chunks.length} chunks) ` +
					`on port ${seeder.port}`,
			);
			console.error(
				"  peers present a hub-minted token; every request is verified. Ctrl-C to stop.",
			);
			// Resolve never: the process IS the service. Ctrl-C is the exit.
			await new Promise<void>(() => {});
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
		if (err instanceof SeedError) {
			console.error(`\n  Cannot seed: ${err.message}`);
			return 65; // EX_DATAERR — the file is wrong, not the request
		}
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
